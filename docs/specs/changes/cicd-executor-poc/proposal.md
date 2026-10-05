# Proposal — CI/CD Executor PoC (Reemplazo de Jenkins, PRMS Reporting DEV)

> **Veredicto en una línea:** la arquitectura (Executor liviano en un contenedor Docker sobre el **servidor de microservicios existente**, SQS Standard + DLQ, DynamoDB para estado y locks, Lambda para quality, **CodeBuild por aplicación y ambiente**, SSH a un script de deploy versionado que corre las migraciones en el target) **cubre el PoC de PRMS Reporting DEV sin bloqueos fundamentales**. Recomendación: **GO WITH CONDITIONS**, con tres gates distintos: escribir código, desplegar el PoC end-to-end y retirar Jenkins (§17).

---

## 1. Document Control

| Campo | Valor |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Slug | `cicd-executor-poc`, derivado del argumento en texto libre de la primera invocación |
| Type | **Change** (feature nueva, greenfield) |
| Approval Mode | `gated` (el contexto exige un gate humano, ctx §20) |
| Status | Draft **v2**: revisado contra el análisis de factibilidad. Pendiente de aprobación |
| Fecha | 2026-10-05 |
| Owner | CI/CD Platform Team |
| Fuentes | **ctx** = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md`; **FA** = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` (evidencia primaria); decisiones de arquitectura del owner (revisión del 2026-10-05) |
| Parent Spec | none (familia propuesta en §16, sin crear todavía) |
| Depends on | none |
| Parallel-safe | yes (respecto a `jenkins-config-inventory` y `cicd-security-remediation`) |

### 1.1 Evidencia y cómo se cita

- Workspace comprobado con `find . -type f`: `JENKINS_REPLACEMENT_AKILI_CONTEXT.md`, `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` y este proposal. **No** están en el workspace los Jenkinsfiles, el código de `<QUALITY_WORKER_FUNCTION>`, el buildspec de `<LEGACY_CODEBUILD_PROJECT>` ni los Dockerfiles de `<PRMS_REPORTING_REPO>`.
- El FA es un análisis read-only de los 152 archivos de pipeline. Cita archivo y línea (`L123`). Se toma como **evidencia primaria**. `VERIFIED (FA §x)` significa que el FA lo establece citando el Jenkinsfile.
- `UNVERIFIED — confirm at source before relying on it` solo se usa donde el FA dice UNKNOWN o no aporta evidencia.

### 1.2 Historial de cambios

| Versión | Cambio |
|---|---|
| v1 | Escrita sin el FA. Fargate como runtime, CodeBuild genérico, worker Lambda nuevo, SSM como alternativa |
| v2 | Se valida contra el FA. Runtime en el servidor de microservicios existente. CodeBuild por app+ambiente. Se reutiliza `<QUALITY_WORKER_FUNCTION>`. El Executor no maneja secretos de aplicación. Lock por unidad de deploy más regla de *supersede*. Modelo de coexistencia con 8 jobs de Jenkins. Hallazgos de seguridad clasificados en 3 niveles. Revisión de Q1–Q10. Tres gates |

---

## 2. Intent

Determinar, con un PoC real, si las responsabilidades de un pipeline representativo de Jenkins se pueden reemplazar **sin crear otro servidor CI permanente y sin convertir el Executor en otro Jenkins**.

Ciclo del Executor: **recibir → resolver definición → coordinar → despachar → registrar → notificar**.

Este proposal cubre el PoC (PRMS Reporting DEV) y los contratos reutilizables: schema de definiciones, eventos, estado, locks y contratos de Lambda, CodeBuild, SSH y script de deploy.

---

## 3. Problem / Current Behavior

| # | Afirmación sobre el estado actual | Estado |
|---|---|---|
| C1 | 152 archivos de pipeline (150 `Jenkinsfile` y 2 `Jenkinsfile copy`) en 25 carpetas de proyecto, 9 patrones de deploy y ~40 credential IDs. Veredicto **B**: Jenkins es removible, con brechas | VERIFIED (FA §1, §2, §24) |
| C2 | Ningún pipeline necesita una capacidad exclusiva de Jenkins. No hay `input`, `build job:`, `stash`, `lock`, `retry` ni cron en archivos. `parallel` aparece en 9, `when` en 6, `timeout` en 2 y `post`/`finally` en todos | VERIFIED (FA §1, §13) |
| C3 | ~45 pipelines construyen sin Docker en el host de Jenkins (Angular, Next, Astro, Vite, OpenNext, esbuild, Maven, `sam build --use-container`): es el **Blocker B1** | VERIFIED (FA §1, §19 B1) |
| C4 | La config de los jobs (triggers, parámetros, concurrencia, variables globales, credenciales) no está en el repo. **Qué dispara cada job es UNKNOWN** | VERIFIED como ausencia (FA §1.4, §19 B2). El contenido sigue `UNVERIFIED — confirm at source before relying on it` |
| C5 | 3 pipelines migran BD **desde el host de Jenkins** (PRMS reporting prod y prod-serverless, TANZANIA dev contra RDS). Unos ~12 migran en el target y RISK lo hace vía Lambda | VERIFIED (FA §5.5 R42–R45, §19 H1) |
| C6 | ≥15 deploys delegan en scripts fuera del repo: en hosts (`<HOST_SCRIPT_PATH>`…), como valores de Secrets Manager (`<SECRET_STORED_SCRIPT>`) o en repos de aplicación | VERIFIED su existencia (FA §1.3, §19 H2). El contenido es `UNVERIFIED — confirm at source before relying on it` |
| C7 | `aws configure set` escribe llaves estáticas en servidores (35 archivos) y otros jobs dependen de esas llaves sobrantes | VERIFIED (FA §12.2.1, §9.3.5, §19 H3) |
| C8 | Concurrencia insegura: keys S3 fijas (`s3://<LEGACY_POC_BUCKET>/codebuild/frontend.zip`), nombres de contenedor fijos, `rmi N-1`, borrado de Docker en todo el host y **hasta 8 jobs que despliegan los mismos contenedores `<SERVER_CONTAINER>` y `<CLIENT_CONTAINER>`** | VERIFIED (FA §10.2, §10.3) |
| C9 | Deuda de seguridad: `<AWS_CREDENTIAL_REF>` lee secretos de prod (355 bindings), ZIPs de quality con secretos de prod, `.git` publicado en un sitio estático público, una imagen en un registro público con un secreto de prod, SSH por password en 44 archivos y host-key checking deshabilitado en todos | VERIFIED (FA §12.2) |
| C10 | **Ningún pipeline hace rollback.** En P1, si la migración falla el contenedor viejo ya fue eliminado y el servicio queda caído. `rmi N-1` borra la única imagen de rollback | VERIFIED (FA §11.4, §16) |
| C11 | Existen un PoC de quality en Lambda (`<QUALITY_WORKER_FUNCTION>`, con contrato `status, failedCommand, exitCode, error, logS3Uri, logUrl`) y un PoC de CodeBuild solo para el frontend (`<LEGACY_CODEBUILD_PROJECT>`), que hace polling sin timeout | VERIFIED su existencia y contrato de salida (FA §2, §5.3 R23, §16, §23). La implementación es `UNVERIFIED — confirm at source before relying on it` (fuera del repo) |
| C12 | Una sola cuenta AWS (`<AWS_ACCOUNT_ID>`) para todos los ambientes, en `<AWS_REGION>` (TANZANIA en `<AWS_REGION_SECONDARY>`). La separación de ambientes **solo puede ser por IAM/recurso, no por cuenta** | VERIFIED (FA §2) |

---

## 4. Proposed Outcome

Al cerrar el PoC, un operador puede:

1. Disparar PRMS Reporting DEV **sin Jenkins** (trigger manual hacia SQS y, como último incremento, webhook de GitHub).
2. Comprobar que el Executor solo coordina:
   - clona y empaqueta **sin secretos**;
   - invoca `<QUALITY_WORKER_FUNCTION>` ×2 en paralelo;
   - lanza dos builds en el CodeBuild `prms-reporting-dev` (server y client);
   - recibe las finalizaciones por EventBridge → SQS;
   - toma el lock de la unidad de deploy;
   - hace SSH a `<PRMS_REPORTING_DEV_TARGET>` y ejecuta el script versionado, que migra y despliega.
3. Reconstruir qué pasó con DynamoDB, los logs de CloudWatch por `executionId` y el hilo de Slack.
4. Verificar que un evento duplicado no despliega dos veces, que dos ejecuciones no colisionan y que **una migración fallida deja la versión anterior sirviendo** (hoy la deja caída, C10).
5. Mantener Jenkins como rollback: solo se deshabilitan temporalmente sus jobs que apuntan al mismo target, durante las ventanas de prueba (§12).

---

## 5. Scope

### 5.1 In scope (PoC)

| Área | Incluye |
|---|---|
| Contratos | `pipeline.schema.json` v1, registro de targets, sobre de eventos, modelo DynamoDB y contratos de Lambda, CodeBuild, SSH y script de deploy |
| Executor | Consumer SQS, state machine, planner (DAG por `needs` + `finally`) y capacidades `source`, `lambda`, `codebuild`, `ssh` (exec + sftp), `notify`. Además LockService, reconciler y logging estructurado |
| Ingress | Trigger manual (mensaje SQS firmado por IAM). Webhook GitHub con Lambda HMAC en el último incremento |
| Quality | `<QUALITY_WORKER_FUNCTION>` **existente**, adaptado a invocación asíncrona con Destinations |
| Build | CodeBuild `prms-reporting-dev` (nuevo, cubre server y client) con buildspec versionado |
| Deploy | Script genérico `deploy-container.sh` versionado, entregado por SFTP en cada ejecución |
| Infra DEV | Recursos de §14.1 con tag `cicd-poc` |

### 5.2 Diseñado en el schema, sin implementar en el PoC

`when`, parámetros tipados, timeouts por ejecución, trigger `schedule`, re-run y los tipos de step `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check`. Se reservan en el schema para que las olas siguientes no lo rompan.

---

## 6. Non-Goals

| Non-goal | Motivo |
|---|---|
| Retirar o modificar Jenkinsfiles | Jenkins es el rollback (ctx §21). Deshabilitar jobs temporalmente no es modificarlos |
| Builds sin Docker (B1) en el PoC | PRMS V2 Reporting DEV construye ambos componentes **dentro de Docker** (FA §23). B1 se prueba en un segundo PoC (§16) |
| Migrar SSH → SSM | Fuera del PoC por decisión del owner. Queda como mejora futura |
| Que el Executor maneje secretos de aplicación o conecte a BD | Los secretos de build los lee CodeBuild y los de runtime y migración los lee el target (§10.10) |
| Jira Builds API, Teams, email | Full replacement (§10.15) |
| Remediar toda la deuda de seguridad | Track paralelo (§13.2) |
| Lenguaje de expresiones, loops, lógica condicionada por el valor de retorno de un comando SSH | Señal de "otro Jenkins" (FA §19 H5) |
| Dashboard web | Futuro |

---

## 7. Affected Users, Systems, And Specs

| Actor / Sistema | Impacto | Fuente |
|---|---|---|
| Servidor de microservicios existente | Aloja el contenedor `cicd-executor` | Decisión del owner. La identidad exacta del host es Q11 |
| `<PRMS_REPORTING_DEV_TARGET>` (credencial `<SSH_CREDENTIAL_REF>`) | Target. Contenedores `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) y `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>) | VERIFIED (FA §23, §11.1) |
| Repo `<PRMS_REPORTING_REPO>` (monorepo server + client) | Fuente del PoC | VERIFIED (FA §23) |
| ECR `<ECR_REPOSITORY>` (server y client) | Destino de imágenes. Hoy lo comparten hasta 8 jobs | VERIFIED (FA §10.3) |
| Hasta 8 jobs Jenkins sobre los mismos contenedores | Se deshabilitan durante las ventanas de prueba (§12) | VERIFIED los archivos (FA §10.3). Nombres de job: `UNVERIFIED — confirm at source before relying on it` (B2) |
| `<QUALITY_WORKER_FUNCTION>` | Se reutiliza. Cambia su configuración de invocación asíncrona | VERIFIED (FA §23) |
| `<LEGACY_CODEBUILD_PROJECT>` | No se reutiliza (key fija, solo frontend). Se sustituye por `prms-reporting-dev` | VERIFIED (FA §23 puntos 1 y 3) |
| BD DEV de PRMS Reporting | Recibe migraciones desde el target. **La comparten las variantes de Jenkins** (R9) | Inferido de FA §10.3; `UNVERIFIED — confirm at source before relying on it` |
| Slack `<SLACK_CHANNEL>` | Notificaciones del Executor | VERIFIED (FA §15) |

---

## 8. Visual Reference

- Source: None
- Location: n/a
- Notes: cambio de backend e infraestructura sin UI. El dashboard es futuro.

---

## 9. Requirement Delta Preview

### ADDED

- **R-DEF**: cada pipeline se describe en YAML versionado validado contra un schema. El Executor no infiere flujos y no contiene `if project == X`.
- **R-ID**: `executionId = <pipelineId>-<sequence>` (p. ej. `prms-reporting-dev-184`), con secuencia atómica por pipeline. Aparece en estado, logs, keys S3, tags de imagen, archivos temporales remotos y Slack.
- **R-QUEUE**: SQS Standard más DLQ, entrega **at-least-once**. Los mensajes llevan referencias, nunca artefactos.
- **R-IDEM**: reprocesar cualquier evento no produce efectos.
- **R-LOCK**: un solo deploy activo por unidad de deploy. La regla de *supersede* impide desplegar un commit más viejo sobre uno más nuevo.
- **R-PAR**: quality ∥ quality y build ∥ build. El fan-in avanza una sola vez.
- **R-MIG**: la migración corre en el target **antes** de detener la versión vieja. Si falla, la versión vieja sigue sirviendo.
- **R-ROLLBACK-READY**: se guarda `previousImageTag` por unidad de deploy y la imagen anterior no se borra hasta que la nueva está sana.
- **R-NOSECRETS**: ningún secreto en ZIPs, keys S3, imagen del Executor, definiciones ni logs.
- **R-RECON**: las ejecuciones atascadas y los locks huérfanos se cierran solos.
- **R-OBS**: logs JSON con `executionId`, estado en DynamoDB y Slack con enlace a logs.

### MODIFIED

- Deploy de PRMS Reporting DEV: Jenkins → Executor durante la validación.
- Orden del deploy en el target: hoy kill → pull → migrar → run (FA §16). Pasa a pull → migrar → swap → health → limpieza.
- Credenciales AWS del deploy en el target: llaves sobrantes → instance profile (o mecanismo equivalente, Q5).

### REMOVED

- Ninguno en el PoC.

---

## 10. Diseño propuesto (preview; `design.md` lo formaliza)

### 10.1 Arquitectura y límites

```text
Manual (aws sqs send-message / script) ─┐       GitHub webhook → Lambda ingress (HMAC) ─┐   (Inc 8)
                                        v                                               v
                              SQS cicd-events-dev (Standard) ── maxReceiveCount 5 ──> cicd-events-dev-dlq → alarma
                                        │   ▲            ▲                        ▲
                                        │   │ Lambda     │ EventBridge            │ EventBridge Scheduler
                                        │   │ Destinations│ (CodeBuild state)     │ (RECONCILE_TICK, 5 min)
                                        v   │            │
           ┌──────────── Servidor de microservicios existente ────────────┐
           │  contenedor cicd-executor (Node.js/TS, límites CPU/mem)      │
           │  receive → resolve → coordinate → dispatch → record → notify │
           └───────┬──────────────┬───────────────┬───────────────┬───────┘
                   │              │               │               │ SSH/SFTP
          S3 executions/{id}/   Lambda          CodeBuild         v
                   │         <QUALITY_WORKER_FUNCTION>  prms-reporting-dev   <PRMS_REPORTING_DEV_TARGET>
                   └── DynamoDB cicd-executions-dev (estado, dedupe, locks, targets)
                       CloudWatch Logs · Slack · Secrets Manager / IAM
```

| Componente | Hace | No hace |
|---|---|---|
| Executor | Consume eventos, transiciona estado, decide el siguiente step, clona y empaqueta, sube a S3, invoca Lambda, lanza CodeBuild, hace SSH y SFTP, gestiona locks y notifica | `npm`/`mvn`/`docker build`, scripts de repos, conexión a BD, leer secretos de aplicación, lógica por proyecto |
| `<QUALITY_WORKER_FUNCTION>` | Lint y tests desde un ZIP en S3 | Slack, DynamoDB |
| CodeBuild `prms-reporting-dev` | Lee secretos de build DEV, `docker build`, push a ECR | Decidir el flujo |
| Target y script | Lee secretos de runtime DEV, pull, migración, swap, health check, limpieza | Conocer el pipeline completo |

### 10.2 Runtime del Executor: servidor de microservicios existente

**Decisión:** contenedor Docker `cicd-executor` en el servidor de microservicios existente. Así se evita reemplazar el servidor grande de Jenkins por otro servidor CI permanente.

El FA confirma que un contenedor pequeño es razonable bajo cuatro condiciones (FA §17):

| Condición | Cómo se cumple |
|---|---|
| Nunca instalar dependencias ni compilar | La imagen no incluye `npm`, `mvn` ni `docker`. Esto se revisa como criterio de aceptación (AC2) |
| Concurrencia acotada | Máximo N preparaciones de fuente simultáneas (default 2) y M sesiones SSH (default 4). El resto espera en la cola |
| Esperas largas event-driven | Lambda asíncrona y CodeBuild vía EventBridge. Solo el SSH de deploy mantiene una sesión abierta |
| Disco para N × el clon más grande | Volumen dedicado `/work`. El tamaño de `<PRMS_REPORTING_REPO>` es UNKNOWN (Q15) y se mide en Inc 3 |

Configuración del contenedor: `--memory` y `--cpus` limitados, `restart=unless-stopped`, volumen `/work` dedicado, usuario no root y **sin** montar `docker.sock`.

**Conectividad requerida (solo salida; el Executor no expone puertos de orquestación):**

| Destino | Protocolo / puerto | Para qué | Validación |
|---|---|---|---|
| SQS `cicd-events-dev` | HTTPS 443 | Recibir y enviar eventos | Inc 2 |
| DynamoDB | 443 | Estado, locks, dedupe | Inc 2 |
| S3 `cicd-artifacts-dev` | 443 | Subir ZIPs (multipart en streaming) | Inc 3 |
| Lambda API | 443 | `Invoke` (Event) | Inc 4 |
| CodeBuild API | 443 | `StartBuild`, `BatchGetBuilds` (este último solo en el reconciler) | Inc 5 |
| EventBridge | n/a | El Executor **no** lo llama. EventBridge escribe en SQS | — |
| Secrets Manager | 443 | Credencial SSH, token de GitHub, token de Slack | Inc 2 |
| CloudWatch Logs y métricas | 443 | Logs (driver `awslogs` o agente) y métricas EMF | Inc 2 |
| STS | 443 | Credenciales temporales (según Q12) | Inc 2 |
| GitHub (`github.com`) | 443 | `git fetch` del commit exacto | Inc 3 |
| Slack (`slack.com`) | 443 | `chat.postMessage` | Inc 2 |
| `<PRMS_REPORTING_DEV_TARGET>` | **TCP 22** | SSH y SFTP del deploy | **Inc 0 (spike de red)** |

Si el servidor sale a internet por un proxy, el SDK de AWS, `git` y el cliente de Slack deben configurarse para usarlo. Se averigua en Q11.

**Riesgos propios de este runtime** (detalle en §15):

- El servidor de microservicios del FA (`<MICROSERVICES_PROD_HOST>`) es un **host de PROD**. En él corre un job que ejecuta `docker swarm leave --force`, un job DEV de monitoreo despliega ahí y hay conflictos de puertos (FA §10.3). Si es el mismo host, un Executor DEV quedaría en un host PROD que Jenkins todavía altera (R2).
- Si el host es EC2, el instance profile es compartido por todos los contenedores del host (R3, Q12).

### 10.3 SQS: topología, visibilidad, reintentos, retención

| Parámetro | Valor propuesto | Razón |
|---|---|---|
| Tipo | **Standard** | La corrección viene de DynamoDB. FIFO deduplica solo 5 minutos y no cubre fallos del consumidor |
| Colas | `cicd-events-dev` y `cicd-events-dev-dlq` | Una cola de trabajo basta al volumen CI/CD; el `eventType` discrimina |
| Long polling | `WaitTimeSeconds=20` | Menos requests vacíos |
| Visibility timeout | 120 s base. El handler la **extiende cada 60 s** (heartbeat) mientras trabaja: clone, SSH | Un SSH de deploy puede durar minutos; el heartbeat evita una entrega duplicada mientras sigue vivo |
| `maxReceiveCount` | 5 → DLQ | Mensajes envenenados o errores persistentes |
| Retención | Cola principal 4 días; DLQ 14 días | Tiempo para redrive manual |
| Reintento de efectos | Lo decide el Executor según el estado, no SQS (§10.13) | Evita repetir efectos destructivos |
| Alarma | DLQ visible > 0, y edad del mensaje más viejo de la cola principal > 10 min | Executor caído o atascado |

**Sobre:**

```json
{
  "specVersion": 1,
  "eventId": "uuid",
  "eventType": "BUILD_COMPLETED",
  "executionId": "prms-reporting-dev-184",
  "pipelineId": "prms-reporting-dev",
  "environment": "dev",
  "stepId": "server-image",
  "status": "SUCCEEDED",
  "attempt": 1,
  "timestamp": "2026-10-05T15:04:05Z",
  "source": "executor|lambda|codebuild|ingress|scheduler",
  "payload": { "buildId": "prms-reporting-dev:…", "imageUri": "…" }
}
```

Eventos: `PIPELINE_REQUESTED`, `QUALITY_COMPLETED|FAILED|TIMED_OUT`, `BUILD_COMPLETED|FAILED|TIMED_OUT`, `DEPLOYMENT_COMPLETED|FAILED`, `PIPELINE_COMPLETED|FAILED`, `RECONCILE_TICK`. Los registros nativos de Lambda Destinations y de EventBridge se **normalizan** a este sobre al recibirse.

### 10.4 Definiciones de pipeline y vocabulario de steps

**Vocabulario mínimo derivado del FA** (§13, §21):

| Tipo de step | Cubre (patrones FA) | Fase |
|---|---|---|
| `source` (implícito) | R6, R14, R15: clone, ZIP, S3 | **PoC** |
| `lambda` | Quality (R16–R23), migración vía VPC Lambda (R45), futuro *Lambda builder* (B1) | **PoC** |
| `codebuild` | Docker/ECR (R24–R26), ARM (R25), `sam --use-container` (R33), builds pesados | **PoC** |
| `ssh` (`exec` + `upload`) | P1, P2, P7: R36–R38, R41–R43, R47–R50 | **PoC** |
| `notify` (proveedor `slack`; luego `jira-builds`, `teams`, `email`) | R62–R65 | **PoC** (Slack) |
| `lambda-deploy` | P4, P4b, P5: R56 (código, configuración, alias y waiters) | Full |
| `s3-sync` (semántica sync/delete) | P3: R54 | Full |
| `cloudfront-invalidate` | R55 | Full |
| `cloudformation` (change set + waiter) | P6: R58 | Full |
| `http-check` | R52, R53 | Full |
| `apigateway-upsert`, `scheduler-upsert`, `ecr-ensure` | R57, R59, R29 (o mejor, pasar a IaC) | Full / evaluar |

El control de flujo se limita a `needs` (DAG, que da el paralelismo), `finally` (always-run), `when` declarativo (`param|branch == valor`, sin expresiones) y `timeoutMinutes`. Esto cubre los únicos patrones del FA: `parallel` (9), `when` (6), `timeout` (2) y `post`/`finally` (todos).

**Ejemplo PRMS Reporting DEV** (los valores `<…>` dependen de Q2):

```yaml
schemaVersion: 1
pipelineId: prms-reporting-dev
project: prms-reporting
environment: dev
repository:
  url: <github.com/…/<PRMS_REPORTING_REPO>>
  branch: <rama de la variante de referencia>       # Q2
  credentialRef: <GITHUB_CREDENTIAL_REF>
triggers: [ { type: manual } ]                         # github-push en Inc 8
notifications: { slack: { channel: "<SLACK_CHANNEL>", tokenRef: <SLACK_TOKEN_REF> } }

source:
  packages:
    - { name: server, path: <server-dir> }
    - { name: client, path: <client-dir> }
  # .git, node_modules y archivos de secretos (.env*, environment*.ts no versionados) se excluyen siempre

steps:
  - id: server-quality
    type: lambda
    with: { function: <QUALITY_WORKER_FUNCTION>, task: backend-quality, package: server }
  - id: client-quality
    type: lambda
    with: { function: <QUALITY_WORKER_FUNCTION>, task: frontend-quality, package: client }

  - id: server-image
    type: codebuild
    needs: [server-quality]
    with: { project: prms-reporting-dev, package: server, env: { COMPONENT: server } }
  - id: client-image
    type: codebuild
    needs: [client-quality]
    with: { project: prms-reporting-dev, package: client, env: { COMPONENT: client } }

  - id: deploy
    type: ssh
    needs: [server-image, client-image]
    timeoutMinutes: 20
    with:
      target: prms-reporting-dev                       # entrada del registro de targets
      script: deploy-container.sh                      # versionado; se entrega por SFTP
      args:
        - --execution-id=${execution.id}
        - --unit=prms-reporting-dev-unit
        - --image=server=${steps.server-image.outputs.imageUri}
        - --image=client=${steps.client-image.outputs.imageUri}
        - --run-migrations

finally:
  - { id: notify, type: notify }
```

**Registro de targets** (`pipeline-definitions/targets/dev.yaml`). Separa el "dónde" del "qué":

```yaml
prms-reporting-dev:
  host: <<PRMS_REPORTING_DEV_TARGET>>
  user: <usuario de deploy>
  credentialRef: <SSH_CREDENTIAL_REF>       # llave (preferida) o password (temporal)
  hostKeyRef: <SSH_HOST_KEY_REF>  # obligatorio
  lockKey: deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit
  containers:
    - { name: <SERVER_CONTAINER>, ports: ["<SERVER_PORT_MAPPING>"], envSecretRef: <secreto runtime server DEV> }
    - { name: <CLIENT_CONTAINER>, ports: ["<CLIENT_PORT_MAPPING>"] }
  migration: { component: server, check: "migration:check:ci", run: "migration:run" }   # Q2
```

El validador rechaza puertos o contenedores duplicados entre targets del mismo host. Esto ataca los conflictos de puertos del FA (§10.3: 3002, 4700, 4040), que un lock no resolvería.

Interpolación: solo de una lista blanca cerrada (`${execution.*}`, `${steps.<id>.outputs.*}`).

### 10.5 CodeBuild: aislamiento por aplicación y ambiente

**Decisión:** un proyecto por aplicación o proceso **y** por ambiente (`prms-reporting-dev`, `prms-reporting-staging`, `prms-reporting-prod`). La definición mapea su ambiente a su proyecto de forma explícita.

| Lo que aísla | Por qué importa aquí |
|---|---|
| Rol IAM | Una sola cuenta AWS para todo (C12). Sin roles por ambiente, DEV podría tocar PROD, que es justo el problema de `<AWS_CREDENTIAL_REF>` (C9) |
| Secretos | El rol DEV solo lee secretos `dev/*` |
| ECR | El rol DEV solo hace push a `<ECR_REPOSITORY>` |
| VPC, logs, costo | Separados por proyecto |

Los proyectos no son servidores encendidos: se paga por minuto de build (§14.2). Lo que se optimiza son **minutos de build innecesarios**, no el número de proyectos.

**¿Varios proyectos dentro de un mismo ambiente?** Según el FA, solo cuando cambia el *entorno de build*, no el componente:

| Caso | ¿Proyecto aparte? | Evidencia |
|---|---|---|
| Server y client de PRMS Reporting DEV | **No.** Mismo tipo de workload (docker build/push), mismos permisos (ECR dev, secretos dev). Un proyecto, dos builds paralelos con `COMPONENT` como override | FA §23 |
| Build ARM64 (un pipeline de AICCRA, `<JENKINS_JOB_ID>`) | Sí: requiere un entorno ARM nativo | FA §8.1 |
| Build que necesita VPC (p. ej. migración TANZANIA vía CodeBuild-in-VPC) | Sí, si se elige esa vía | FA §20 |
| `sam build --use-container` | No necesariamente: mismo modo privilegiado que docker | FA §8.3 |

**Política Lambda vs CodeBuild:** se prefiere Lambda si la carga cabe de forma razonable y segura. Si no, CodeBuild del ambiente. Aplicada a la evidencia:

| Carga | Ubicación | Base |
|---|---|---|
| Lint y tests de Node | Lambda (`<QUALITY_WORKER_FUNCTION>`, ya probado en PRMS reporting) | FA §6 R16–R19 |
| Tests que necesitan BD, Karma/Chrome, monorepos pnpm, Maven | Medir; CodeBuild si no caben | FA §19 H7 |
| `docker build`/push y ARM | CodeBuild (justificado) | FA §8.1 |
| **No** reproducir "build test image + docker run" para quality | Lambda | FA §8.2 (53 archivos, ahorro de costo) |
| No clonar dentro de CodeBuild | Fuente = ZIP de la ejecución vía `sourceLocationOverride` | FA §8.2 |
| No poner deploy SDK ni esperas en el buildspec | Executor | FA §8.2 |
| Builds estáticos y esbuild (B1) | *Lambda builder* preferido; CodeBuild del ambiente como fallback medido | FA §19 B1. **Fuera del PoC** |
| `sam build --use-container` | CodeBuild del ambiente (corto plazo) | FA §8.3 |
| Espejo de imágenes upstream | ECR pull-through cache, no CodeBuild | FA §8.2 |

**Contrato `StartBuild`:** `projectName` (de la definición), `sourceTypeOverride=S3`, `sourceLocationOverride=executions/{id}/source/{package}.zip`, env `EXECUTION_ID, STEP_ID, IMAGE_TAG, COMPONENT` e `idempotencyToken = dispatchToken`.

**Buildspec:** versionado en el repo de la plataforma y asociado al proyecto (no viaja en el ZIP). Su flujo:

1. Lee los secretos de build DEV desde Secrets Manager.
2. Escribe `environment.ts` o `.env` **dentro del contenedor de build**.
3. Ejecuta `docker build`; si el `.dockerignore` lo permite, con BuildKit secrets.
4. Hace `push` del tag único y emite `imageUri` y `digest`.

**Finalización:** regla de EventBridge `CodeBuild Build State Change` (`SUCCEEDED|FAILED|STOPPED|TIMED_OUT`, filtrada por proyecto) → SQS. Se correlaciona por `buildId` y `EXECUTION_ID`. Sin polling (FA §5.4 R35 señala que el PoC actual hace polling sin timeout).

### 10.6 Lambda: contrato

- Se **reutiliza** `<QUALITY_WORKER_FUNCTION>` con su contrato de salida (`status, failedCommand, exitCode, error, logS3Uri, logUrl`; FA §21.7).
- Cambio de invocación: síncrona (hoy espera hasta 900 s) → `InvocationType=Event`, `MaximumRetryAttempts=0` y Destinations `onSuccess`/`onFailure` → `cicd-events-dev`. Así el Executor no queda bloqueado.
- Clasificación del resultado:
  - `status=FAILED` → `QUALITY_FAILED` (de negocio);
  - error de función → `QUALITY_FAILED` (`errorClass=INFRA`);
  - timeout → `QUALITY_TIMED_OUT` (no `FAILED`, según FA §16).
- El formato de entrada del worker y si acepta invocación asíncrona sin cambiar código son `UNVERIFIED — confirm at source before relying on it` (Q2). Plan B: un wrapper Lambda delgado que invoque el worker en modo síncrono y publique en SQS.

### 10.7 Preparación de fuente y S3

Validada por el FA (§7.2): el clone y el ZIP corresponden al Executor, con estas restricciones.

```text
git fetch --depth 1 <sha exacto>   (token de corta duración desde <GITHUB_CREDENTIAL_REF>)
→ /work/{executionId}/
→ ZIP por package, excluyendo .git, node_modules y archivos de secretos
→ upload en streaming (multipart) a s3://cicd-artifacts-dev/executions/{executionId}/source/{package}.zip
→ rm -rf /work/{executionId} en finally
→ al arrancar, barrido de /work/* huérfanos
```

- **Sin la segunda clonación** de `getLastCommitInfo` (FA §5.2 R7): el SHA sale del primer fetch.
- **Bucket nuevo** `cicd-artifacts-dev`. No se reutiliza `<LEGACY_POC_BUCKET>`, que contiene secretos de prod (C9).

| Prefijo | Lifecycle |
|---|---|
| `executions/{id}/source/` | Borrado explícito al terminar (éxito o fallo) **y** expiración a **7 días** como red de seguridad |
| `executions/{id}/quality/` (logs y reportes) | Expiración a **30 días** (troubleshooting) |
| Multipart incompletos | Abortar a 1 día |

SSE activado, Block Public Access y política de bucket limitada a los roles del PoC.

### 10.8 SSH: mecanismo de deploy del PoC

- Biblioteca `ssh2` (exec + SFTP). **Host key fijado obligatorio** (hoy deshabilitado en todos los pipelines, FA §11.1).
- Autenticación: **llave** preferida. Password (credencial `<SSH_CREDENTIAL_REF>`) solo como fallback temporal y explícito en el registro de targets, porque el FA lo considera aceptable para el PoC (§23.5).
- La credencial se lee de Secrets Manager en cada ejecución, se mantiene **solo en memoria** y nunca va al disco, la imagen ni los logs.
- El Executor conoce únicamente: `target`, `script`, `args`, `timeout` y `executionId`.
- **Entrega del script:** el Executor sube por SFTP la versión fijada del script, desde el repo de la plataforma, a `/tmp/cicd-{executionId}/deploy-container.sh`. Lo ejecuta con args escapados (sin shell interpolado), registra su checksum y lo borra al final. Así siempre corre la versión revisada y no hace falta preinstalar nada (alternativa: preinstalar en `/opt/deploy`, §11).
- Se captura `exitCode`, la cola de stdout/stderr (a CloudWatch) y una línea final `CICD_RESULT {json}`.

### 10.9 Scripts de deploy: inventario y lo que necesita el PoC

| Patrón actual | Ejemplos (FA) | Tratamiento |
|---|---|---|
| Comandos inline `sshCommand` en el Jenkinsfile | ~57 pipelines P1, **incluido PRMS V2 Reporting DEV** | Se consolidan en un `deploy-container.sh` genérico versionado (FA §25.6) |
| Scripts residentes en hosts | Varios `<HOST_SCRIPT_PATH>` (nombres en el inventario local) | Inventario en `jenkins-config-inventory`. **No afectan al PoC** |
| Scripts como valores de Secrets Manager | `<SECRET_STORED_SCRIPT>` (una familia de aplicaciones) | Pasar a Git. **No afectan al PoC** |
| Scripts en repos de aplicación | `scripts/deploy-ecr.sh`, `deploy-api.sh`, `migrate-remote.sh`, `deploy-web.sh` | Requieren un runtime con toolchain (§15.1). **No afectan al PoC** |

**Para PRMS Reporting DEV:** no hay script residente. El deploy está inline en el Jenkinsfile de referencia (FA §23): kill/rm, login ECR, pull, migraciones condicionales, `docker run` de los dos contenedores y borrado del `.env` remoto en `finally`. El PoC necesita **un solo script nuevo**, `deploy-container.sh`, escrito durante la ejecución (no ahora).

### 10.10 Secretos y credenciales: quién lee qué

| Secreto | Hoy | En el PoC |
|---|---|---|
| Secretos de build del frontend (`environment*.ts`) | Jenkins los escribe en el árbol y terminan en ZIPs e imágenes | **CodeBuild `prms-reporting-dev`** los lee (rol DEV) dentro del build |
| `.env` de runtime y migración del server | El target los lee con llaves sobrantes de `aws configure set` | **El target** los lee con su instance profile y los escribe en `/tmp/deploy-{executionId}.env` (0600). Se borran en `finally` **en el target** |
| Secretos para tests de quality | Van dentro del ZIP (secretos de prod en el PoC actual) | ZIP **sin secretos**. Si los tests los necesitan (Q13), el worker los lee por ARN con un rol de solo lectura DEV |
| Credencial SSH | Jenkins (`<SSH_CREDENTIAL_REF>`) | Secrets Manager `<SSH_CREDENTIAL_REF>`, solo en memoria |
| Token GitHub | Repos clonados de forma anónima o con una credencial global UNKNOWN | `<GITHUB_CREDENTIAL_REF>` (GitHub App, preferida, o PAT de solo lectura) |
| Slack | `<SLACK_TOKEN_REF>` | `<SLACK_TOKEN_REF>` |
| AWS del Executor | `<AWS_CREDENTIAL_REF>` (lee prod) | Rol dedicado `cicd-executor-dev`, solo DEV, mecanismo según Q12 |

**El Executor nunca ve secretos de aplicación.** Esto reduce su radio de impacto, la principal preocupación de seguridad del FA (§12.3).

**Trampa en el target:** si se añade un instance profile pero el usuario SSH conserva `~/.aws/credentials` con llaves sobrantes, la AWS CLI **prioriza las llaves estáticas**. El script debe forzar la cadena del rol (p. ej. `AWS_SHARED_CREDENTIALS_FILE=/dev/null`) o usarse un usuario de deploy dedicado sin `~/.aws`. En el PoC **no se borran** las llaves existentes, porque otros jobs dependen de ellas (C7, H3).

### 10.11 Migraciones en el target

| Variante en el FA | ¿Encaja en el modelo "target ejecuta"? |
|---|---|
| Condicional `migration:check:ci → migration:run` en el target (familia PRMS reporting, incluido el PoC) | **Sí** |
| Incondicional en el target (ALLIANCE-INDICATORS, CLARISA v2) | **Sí** |
| Desde el host de Jenkins hacia la BD (PRMS reporting prod y prod-serverless) | Sí, moviéndola al script del target |
| Desde el host de Jenkins hacia RDS (TANZANIA, serverless, **sin servidor target**) | **No.** Necesita un step `lambda` hacia una VPC Lambda (patrón RISK) o CodeBuild en VPC |
| Vía Lambda (RISK) | Sí (step `lambda`) |

**Orden en `deploy-container.sh`** (corrige C10):

1. Login a ECR con el rol del host y pull de las imágenes nuevas.
2. Lectura del secreto de runtime → `/tmp/deploy-{executionId}.env`.
3. `docker run --rm --env-file … <nueva imagen server> npm run migration:check:ci`. Si hay pendientes, `migration:run`. **Si falla: exit 20; los contenedores viejos siguen arriba.**
4. Swap: detener el contenedor viejo, arrancar el nuevo con el mismo nombre y puertos.
5. Health check. Si falla: reiniciar `previousImageTag` y exit 40.
6. Limpieza: borrar el `.env` temporal y las imágenes más viejas que `previous`. **Nunca** `rmi` de la imagen previa.

| Exit | Significado | Estado previo preservado |
|---|---|---|
| 0 | OK | n/a |
| 10 | Falló login o pull | Sí |
| 20 | **Falló la migración** | Sí (la BD puede quedar parcialmente migrada si la migración no es transaccional) |
| 30 | Falló el arranque; se restauró la imagen previa | Sí (tras restaurar) |
| 40 | Falló el health check; se restauró la imagen previa | Sí (tras restaurar) |
| otro / sesión perdida | Desconocido | `UNKNOWN_TARGET_STATE` (revisión manual) |

Requisito: las migraciones deben ser **compatibles hacia atrás**, porque la versión vieja corre sobre el esquema nuevo entre los pasos 3 y 4. El mecanismo exacto actual (si migra dentro del contenedor en marcha o con un contenedor efímero) es `UNVERIFIED — confirm at source before relying on it` (Q2).

### 10.12 DynamoDB: estado

Tabla `cicd-executions-dev`, on-demand, TTL `expiresAt`. Incorpora los campos que el FA §9.2 pide añadir.

| PK | SK | Contenido |
|---|---|---|
| `EXEC#<executionId>` | `META` | `pipelineId, definitionRef (sha), project, environment, repository, branch, commit, sequence, trigger, triggeredBy, parameters, status, version, targets[], lockIds[], artifacts[], slackTs, startedAt, finishedAt, error{code,message,stepId}` |
| `EXEC#<executionId>` | `STEP#<stepId>` | `status, attempt, dispatchToken, externalRef (requestId / buildId / sesión SSH), logUrl, outputs{imageUri, digest…}, migrationsApplied, deadlineAt, startedAt, finishedAt, error` |
| `PIPELINE#<pipelineId>` | `SEQ` | Contador atómico → `executionId` |
| `TARGET#<lockKey>` | `STATE` | `currentImageTags, previousImageTags, lastDeployedSequence, lastExecutionId` |
| `LOCK#<lockKey>` | `LOCK` | Ver §10.14 |
| `DEDUPE#<key>` | `DEDUPE` | Dedupe de ingreso (TTL 7 días) |

Índices: GSI1 `pipelineId + startedAt` (historial) y GSI2 disperso `activeStatus + deadlineAt` (reconciler).

```text
Ejecución: QUEUED → RUNNING → SUCCEEDED | FAILED | TIMED_OUT | CANCELLED     (terminales inmutables)
Step:      PENDING → DISPATCHING → RUNNING → SUCCEEDED | FAILED | TIMED_OUT
           PENDING → SKIPPED (dependencia fallida, `when` falso o SUPERSEDED)
           PENDING → WAITING_LOCK → DISPATCHING
```

Todo cambio de estado es un `UpdateItem` condicional sobre `status` y `version`. No hay `currentStep` global: con paralelismo hay varios steps en curso.

Compatibilidad con `<JENKINS_EXECUTIONS_TABLE>`: el FA no sabe si alguien consume esa tabla (§14). En el PoC **no se escribe** en ella, salvo que Q14 revele consumidores.

### 10.13 Idempotencia

| Capa | Mecanismo |
|---|---|
| Ingreso | `DEDUPE#<X-GitHub-Delivery | requestId manual>` condicional: un request produce una ejecución |
| Consumo | Cada efecto es una transición condicional. Si la condición falla, ya fue procesado: ack sin efectos |
| Despacho | *Intent-then-act*: se escribe `DISPATCHING + dispatchToken` **antes** de llamar a AWS. CodeBuild usa `idempotencyToken`. El quality en Lambda es de solo lectura (repetirlo es inofensivo) |
| Fan-in | `deploy` pasa de `PENDING` a `DISPATCHING` con una escritura condicional: un único ganador |
| Deploy | Lock + estado del step + script idempotente para la misma imagen |
| Tags | `{pipelineId}-{sequence}` (p. ej. `prms-reporting-dev-184`) con labels OCI `commit` y `executionId`. No choca con los tags enteros de Jenkins en el mismo repo ECR |

`BUILD_COMPLETED` duplicado → el step ya está `SUCCEEDED` → no-op. `deploy` ya está `DISPATCHING` o más avanzado → no se vuelve a despachar. **Ni segunda migración ni segundo `docker run`.**

### 10.14 Locks de deploy

| Aspecto | Diseño |
|---|---|
| Clave | `lockKey` del registro de targets = **unidad de deploy en un host** (`deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit`). Cubre ambos contenedores. No se basa en el nombre del proyecto, porque 8 jobs de proyectos y ramas distintas comparten la unidad |
| Adquisición | `PutItem` condicional: `attribute_not_exists(PK) OR leaseExpiresAt < :now`. Guarda `owner=executionId`, `fencingToken`, `leaseExpiresAt = now + timeout del step + margen` y `expiresAt` (TTL) |
| Propiedad | Renovar y liberar son condicionales a `owner = :executionId` |
| Renovación | Heartbeat cada 60 s mientras dura el SSH |
| Liberación | En éxito, fallo o `finally` |
| Ocupado | `WAITING_LOCK`, reencola con backoff y falla con `LOCK_TIMEOUT` pasados 30 min |
| TTL | Solo limpieza (DynamoDB puede tardar hasta ~48 h en borrar). **La exclusión se decide por `leaseExpiresAt`** |
| Huérfano | El lease expira solo. El reconciler marca la ejecución dueña como `TIMED_OUT` y notifica |
| **Supersede** | Con el lock tomado, si `TARGET.lastDeployedSequence > mi sequence`, el step pasa a `SKIPPED (SUPERSEDED)`. Evita desplegar un commit viejo sobre uno nuevo cuando dos ejecuciones compiten |
| Locks de host (futuro) | Para operaciones destructivas a nivel host (`swarm leave`, P7) y builds en el servidor (P2): `lockKey` de alcance host |

### 10.15 Notificaciones

- `NotificationService` con interfaz `notify(event, execution)` y proveedores enchufables. PoC: `SlackProvider` (Web API `chat.postMessage` con bot token e hilo por ejecución). Después: `JiraBuildsProvider` (87 pipelines), `TeamsProvider` y `EmailProvider` (SES).
- Lambda y CodeBuild no conocen Slack: reportan a SQS y el Executor notifica.
- Eventos notificados: inicio, fallo de quality, fallo de build, fallo de deploy (incluido `UNKNOWN_TARGET_STATE`), éxito, lock timeout. Cada uno con `executionId`, commit y enlace a logs (deep link a Logs Insights o `logUrl` del worker).
- **Best-effort:** un fallo de notificación nunca falla el pipeline. Eso ya pasa hoy (FA §15).

| Integración | Clasificación |
|---|---|
| Slack | PoC |
| Jira Builds API | Full replacement (sin ella se pierde visibilidad en Jira de 87 pipelines) |
| Teams (1), email (1, legacy) | Full replacement o retiro |

### 10.16 Observabilidad

Logs JSON (`executionId, pipelineId, stepId, eventType, attempt`) del Executor, el worker y CodeBuild, filtrables por `executionId`. Consulta guardada "timeline de ejecución". Métricas EMF: ejecuciones, duración por step y espera de lock. Alarmas: DLQ > 0, ejecución viva más allá de su deadline y Executor sin heartbeat. Es la "observabilidad mínima" del FA §15.

### 10.17 Comportamiento ante fallos

| Fallo | Comportamiento esperado |
|---|---|
| Git clone falla | 2 reintentos con backoff dentro del handler. Luego `FAILED (SOURCE_CLONE)`, Slack, limpieza de `/work/{id}` |
| Preparación de fuente falla (disco, ZIP) | `FAILED (SOURCE_PREP)`, limpieza. Si es por disco, métrica y alarma |
| Subida a S3 falla | Reintentos del SDK y 1 reintento del step. Luego `FAILED`. Los objetos parciales los elimina el lifecycle |
| Lambda falla (error de función) | `QUALITY_FAILED (INFRA)`. 1 re-despacho automático (`attempt+1`) |
| Quality falla (lint/test rojo) | `QUALITY_FAILED`, sin reintento. Los dependientes pasan a `SKIPPED` y se ejecuta `finally` |
| Lambda timeout | `QUALITY_TIMED_OUT` (distinto de FAILED). Sin reintento automático |
| CodeBuild falla | `BUILD_FAILED` con el enlace al log del build. Sin reintento. Si falló `StartBuild` (API), 1 re-despacho |
| Push a Docker/ECR falla | Ocurre dentro del build → `BUILD_FAILED` |
| Redelivery de SQS | No-op por transición condicional (§10.13) |
| Conexión SSH falla | Hasta 2 reintentos **antes** de ejecutar el script. Luego `DEPLOYMENT_FAILED`. Se libera el lock |
| Migración falla | Exit 20 → `DEPLOYMENT_FAILED (MIGRATION)`. La versión vieja sigue sirviendo. Sin reintento automático |
| Script de deploy falla | Exit ≠ 0 → `DEPLOYMENT_FAILED` con código y cola de log. Sin reintento automático |
| Health check falla | Exit 40: el script restauró la imagen previa → `DEPLOYMENT_FAILED (HEALTH)` |
| Slack falla | Se registra el error; el pipeline sigue |
| El Executor se reinicia | El estado está en DynamoDB. Los mensajes no confirmados reaparecen tras el timeout de visibilidad y se reprocesan de forma idempotente. Al arrancar se barre `/work`. Un SSH interrumpido deja el lease sin renovar → el reconciler lo resuelve |
| Ejecución atascada | El reconciler (cada 5 min) busca `deadlineAt < now`. Para CodeBuild consulta `BatchGetBuilds` y recupera el evento perdido. Para el resto marca `TIMED_OUT`, ejecuta `finally` y notifica |
| Lock huérfano | Expira por lease. El reconciler cierra la ejecución dueña. Si la sesión SSH se cortó a mitad de script → `UNKNOWN_TARGET_STATE` y verificación manual con runbook |
| Mensaje envenenado | 5 recepciones → DLQ → alarma → redrive manual tras corregir |

### 10.18 Concurrencia

| Escenario (FA §10) | Control |
|---|---|
| Quality y builds de server/client | Paralelos por DAG; fan-in condicional |
| Dos ejecuciones del mismo pipeline | Ambas construyen (artefactos y tags distintos). El deploy se serializa por lock y *supersede* evita retrocesos |
| Colisión de S3 o de workspace | `executions/{id}/` y `/work/{id}/` |
| Colisión de archivos temporales remotos | `/tmp/deploy-{executionId}.env` y `/tmp/cicd-{executionId}/` |
| Conflictos de puertos entre contenedores distintos | Validación del registro de targets (no lo resuelve un lock) |
| **Executor vs Jenkins** | **El lock no lo cubre** → procedimiento operativo (§12) |
| **BD DEV compartida entre variantes de ramas distintas** | **El lock no lo cubre**: migraciones de otra rama pueden alterar el esquema que usa el PoC → R9 |

---

## 11. Approach Options

| Opción | Estado | Notas |
|---|---|---|
| **A. Executor liviano + SQS + DynamoDB en el servidor de microservicios existente** | **Seleccionada** | Validar justamente si un Executor liviano basta |
| A'. Mismo Executor en ECS Fargate | Alternativa | Aísla del host compartido (R2, R3) a cambio de un costo fijo pequeño. Plan B si Q11 o Q12 no se resuelven bien |
| B. AWS Step Functions | Alternativa, no seleccionada | Ver señales de alarma abajo |
| C. GitHub Actions + OIDC | Alternativa, no seleccionada | No es la arquitectura que se evalúa |
| Variante de entrega del script: preinstalado en `/opt/deploy` | Alternativa | Más simple, pero puede divergir de Git. Se prefiere entregarlo por SFTP en cada ejecución |

**Señales de alarma para reconsiderar Step Functions** (FA §19 H5, §24.7):

- Aparecen ramificaciones condicionales complejas o anidadas, más allá de `when` simple.
- Se piden sub-workflows, reutilización de pipelines dentro de pipelines o grafos de reintento.
- Se necesitan expresiones, loops o un DSL creciente en las definiciones.
- Hay esperas largas (CloudFormation de ~20 min o más, aprobaciones) que el Executor debe sostener.
- El planner o el reconciler crecen más allá de un módulo pequeño, o aparece lógica específica de proyecto.
- Se piden retries por step con políticas distintas o compensaciones (sagas).

Si aparecen dos o más de estas señales, se reevalúa Step Functions antes de seguir extendiendo el Executor.

## 12. Recommended Approach y coexistencia con Jenkins

**Opción A.** El Executor queda en el vocabulario de §10.4, la lógica de proyecto vive en definiciones y scripts versionados, y lo pesado en Lambda o CodeBuild.

**Coexistencia con Jenkins durante el PoC.** Hasta 8 jobs despliegan `<SERVER_CONTAINER>` y `<CLIENT_CONTAINER>` en `<PRMS_REPORTING_DEV_TARGET>` (FA §10.3):

- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`

Más los que revele el inventario. Procedimiento para cada **ventana de prueba de deploy** (Inc 6 en adelante):

1. Anunciar la ventana en el canal del equipo PRMS.
2. Confirmar en Jenkins que no hay builds en curso de esos jobs.
3. **Deshabilitar** esos jobs ("Disable Project", reversible y sin tocar Jenkinsfiles). Requiere conocer los nombres de los jobs (Q1 / B2) y aprobación del owner de Jenkins.
4. Ejecutar las pruebas del PoC.
5. Rehabilitar los jobs y dejar registro (quién, cuándo, ejecuciones) en `docs/specs/changes/cicd-executor-poc/`.

Jenkins no se apaga globalmente. Alternativa para iteraciones tempranas: desplegar a contenedores y puertos propios del PoC, sin conflicto con Jenkins. Comparten la BD DEV (R9), así que esa alternativa **no reemplaza** la prueba sobre el target real.

---

## 13. Hallazgos de seguridad del FA, clasificados

### 13.1 Requeridos para la seguridad del PoC

| Medida | Hallazgo FA |
|---|---|
| ZIPs de quality y fuente **sin secretos** y bucket nuevo `cicd-artifacts-dev` | §12.2.3, H6 |
| Keys S3 y tags con alcance de ejecución; no usar `codebuild/frontend.zip` | §10.2 |
| Rol AWS dedicado DEV para el Executor y por proyecto CodeBuild. **Nunca** `<AWS_CREDENTIAL_REF>` | §12.1, §12.2.2 |
| El Executor no ejecuta `aws configure set`; el target usa su rol (con la trampa de §10.10) | §12.2.1, H3 |
| Host key fijado en SSH | §12.2.6 |
| Credencial SSH en Secrets Manager, solo en memoria y redactada en logs | §12.3 |
| `.env` temporal remoto con nombre único y 0600, borrado **en el target** | §11.4, §12.2.8 |
| Mecanismo de credenciales del Executor en el host compartido sin exponerlas a otros contenedores (Q12) | §12.3 |
| HMAC del webhook (si se habilita) | §12.3 |

### 13.2 Remediación en paralelo (`cicd-security-remediation`, no bloquea el PoC)

Rotar `<AWS_CREDENTIAL_REF>` y separar IAM de prod y no-prod. Detener `aws configure set` y poner instance profiles en todos los hosts. Quitar secretos de prod de `s3://<LEGACY_POC_BUCKET>` y de los jobs de staging. Retirar la imagen publicada en un registro público con un secreto de prod. Dejar de publicar `.git` en el sitio estático afectado. Migrar SSH password → llave en los 44 archivos y activar host keys. Corregir los `finally` que corren en el host equivocado. Mover secretos en texto plano en variables de entorno de Lambda a Secrets Manager. Cambiar las credenciales por defecto del servicio de monitoreo afectado.

### 13.3 Limpieza a más largo plazo

Inyección de shell en `getLastCommitInfo` (desaparece con Jenkins). JMX sin autenticación en un servicio Java. `sudo -S` con password. `chmod 777` en directorios de secretos. Guardas para `docker swarm leave --force`. Crecimiento de políticas de permisos de Lambda. Reubicar `RECORDS/BRANCH`.

---

## 14. Recursos, costo, plan, archivos

### 14.1 Recursos del PoC (DEV, cuenta `<AWS_ACCOUNT_ID>`, `<AWS_REGION>`)

| Recurso | Nombre |
|---|---|
| SQS Standard + DLQ | `cicd-events-dev`, `cicd-events-dev-dlq` |
| DynamoDB | `cicd-executions-dev` |
| S3 | `cicd-artifacts-dev` (lifecycle §10.7) |
| ECR | `cicd-executor` (imagen del Executor). Los repos `<ECR_REPOSITORY>` **existentes** se reutilizan |
| CodeBuild | `prms-reporting-dev` (nuevo, privilegiado) y su rol de servicio |
| Lambda | `<QUALITY_WORKER_FUNCTION>` existente: configuración async y Destinations (o una copia DEV si no se debe tocar la original) |
| Lambda (Inc 8) | `cicd-github-ingress-dev` + Function URL |
| EventBridge | Regla `cicd-codebuild-state-dev` → SQS; Scheduler `cicd-reconcile-dev` |
| Secrets Manager | `<SSH_CREDENTIAL_REF>` (+ host key), `<GITHUB_CREDENTIAL_REF>`, `<SLACK_TOKEN_REF>` (+ `<WEBHOOK_SECRET_REF>` en Inc 8) |
| IAM | `cicd-executor-dev`, rol de servicio de `prms-reporting-dev`, rol de Destinations y rol de ingress |
| CloudWatch | Log groups (30 días), alarmas, consultas guardadas |
| Servidor de microservicios | Contenedor `cicd-executor`, volumen `/work`, credenciales según Q12 |
| `<PRMS_REPORTING_DEV_TARGET>` | Instance profile (ECR pull de `<ECR_REPOSITORY>` y lectura del secreto de runtime DEV), usuario de deploy y llave autorizada (o password temporal) |

### 14.2 Categorías de costo

| Categoría | Naturaleza | Expectativa |
|---|---|---|
| Executor | Marginal: corre en un servidor existente | Sin costo fijo nuevo de cómputo (Fargate y NAT de v1 eliminados) |
| CodeBuild | Por minuto de build, **sin costo por proyecto inactivo** | Principal costo variable. Se reduce con caché de capas, un solo build por imagen y sin quality en CodeBuild |
| Lambda | GB-s por quality run | Bajo |
| SQS, DynamoDB on-demand, EventBridge | Por request | Inmaterial |
| S3 | GB-mes | Bajo con lifecycle |
| Secrets Manager, CloudWatch Logs | Por secreto / GB | Bajo; vigilar el volumen de logs de builds |

### 14.3 Plan por incrementos

| Inc | Entrega | Requiere |
|---|---|---|
| 0 | `/akili-specify` aprobado. Schema y validador, registro de targets, definición del PoC. **Spike de red** desde el servidor de microservicios (443 a AWS, GitHub y Slack; 22 a `<PRMS_REPORTING_DEV_TARGET>`) | Gate A |
| 1 | Dominio puro: state machine, planner, idempotencia, LockService, *supersede*. Tests con DynamoDB Local | Gate A |
| 2 | Infra base DEV y contenedor del Executor en el servidor. Pipeline no-op manual → Slack. Poison message → DLQ | Gate B |
| 3 | `source`: clone, ZIP sin secretos, S3. Medición del tamaño de `<PRMS_REPORTING_REPO>` | Gate B |
| 4 | `<QUALITY_WORKER_FUNCTION>` async + Destinations; quality en paralelo | Gate B + Q2/Q13 |
| 5 | CodeBuild `prms-reporting-dev` + EventBridge; dos imágenes con tags únicos | Gate B + Q2 |
| 6 | SSH + lock + `deploy-container.sh` + migración en `<PRMS_REPORTING_DEV_TARGET>`, en ventana con Jenkins deshabilitado | **Gate C** |
| 7 | Reconciler, timeouts y pruebas de fallo (matar el Executor, migración rota, duplicados) | Gate C |
| 8 | Webhook de GitHub, E2E de aceptación e informe de medición y costo vs proposal | Gate C |

### 14.4 Archivos que se espera crear durante la ejecución (no ahora)

```text
cicd-platform/
  executor/src/{main.ts, consumer/, domain/{state-machine,planner,events}.ts,
                handlers/{source,lambda,codebuild,ssh,notify}-step-handler.ts,
                services/{pipeline-definition,execution,state,lock,notification,git,message-queue}.service.ts,
                adapters/{dynamodb,s3,secrets,sqs}/, observability/}
  executor/test/   executor/Dockerfile   executor/docker-compose.yml (despliegue en el servidor)
  ingress/github-webhook/
  buildspecs/prms-reporting-dev.yml
  pipeline-definitions/prms/reporting-dev.yaml
  pipeline-definitions/targets/dev.yaml
  schemas/{pipeline,targets,event}.schema.json
  deploy-scripts/deploy-container.sh
  infra/            (herramienta de IaC: Q7)
  docs/{runbook,resources,jenkins-coexistence-log}.md
docs/specs/changes/cicd-executor-poc/{requirements,design,tasks}.md
```

No se modifican Jenkinsfiles, código de aplicación (`<PRMS_REPORTING_REPO>`) ni la Lambda o el CodeBuild del PoC anterior, salvo la configuración de invocación del worker (§10.6).

---

## 15. Validación contra los 152 pipelines, riesgos y preguntas

### 15.1 Qué cubre la arquitectura y qué no

| Patrón FA | ≈# | ¿Encaja? | Qué falta |
|---|---:|---|---|
| P1 Docker → ECR → SSH | 57 | **Sí** (es el PoC) | Script genérico; migración de password a llave |
| P2 SSH + script en host o build en el servidor | 18 | Sí, estructuralmente | Contenido de scripts UNKNOWN (H2). Lecturas de workspace de Jenkins → secreto re-leído desde la ejecución |
| P3 build estático → S3 → CloudFront | 8 (+~10) | **Parcial** | B1 (runtime de build) + steps `s3-sync` y `cloudfront-invalidate` |
| P4 imagen Lambda | 6 (+2) | Sí | Step `lambda-deploy` (+ API GW y Scheduler o IaC) |
| P4b Lambda vía SSH (proxy de credenciales) | 9 | Sí, mejor sin SSH | `lambda-deploy` |
| P5 ZIP Lambda | 8 | **Parcial** | B1 (esbuild → *Lambda builder*) + `lambda-deploy` |
| P6 SAM / CloudFormation / scripts de repo | 15 | **No cubierto hoy** | `sam --use-container` en CodeBuild del ambiente. Scripts de repo con toolchain: **sin runtime decidido** |
| P7 Swarm | 4 | Sí vía SSH | Lock de alcance host y guarda para operaciones destructivas |
| P8 solo CI | 22 | Sí | Lambda (y CodeBuild si hay push) |
| P9 utilidades | 3 | Fuera del Executor | `RECORDS/BRANCH` → Lambda o tarea programada |

**Lo que el diseño todavía no puede representar o resolver:**

1. **Runtime para builds sin Docker (B1, ~45 pipelines).** La política está decidida (Lambda builder preferido, CodeBuild del ambiente como fallback), pero **no está probada**. Bloquea el retiro de Jenkins, no el PoC.
2. **Scripts de repos de aplicación que necesitan toolchain** (`deploy-ecr.sh`, `deploy-api.sh`, `infra/scripts/*`, `npm run deploy:staging`; RISK, TANZANIA, IBD y MARLO landing). Solo caben como "ejecutar script en el CodeBuild del ambiente", lo que convierte a CodeBuild en *script runner* con permisos de deploy. Requiere una decisión explícita en la ola correspondiente.
3. **Lógica de control en Groovy** que no debe portarse al Executor y tiene que ir a scripts:
   - flujo guiado por el valor de retorno de `sshCommand` (dos pipelines de AICCRA y Swarm, `<JENKINS_JOB_ID>`);
   - *branch-tip gating* con `git rev-list` (MONITORING);
   - transformaciones de secretos con python/jq (IA ai-insights, MARLO-V2 dev-lambda);
   - `sed` sobre la fuente (INNOVATION-CATALOG);
   - parcheo de `package.json`/`tsconfig` y sobrescritura del Dockerfile (variantes PRMS V2 reporting).

   Si la ola correspondiente intenta meter esto en el Executor, es la señal de "otro Jenkins". Las transformaciones de secretos a variables de entorno de Lambda se pueden expresar de forma genérica en `lambda-deploy` (`environmentFromSecret` con include/exclude) sin código por proyecto.
4. **Change set de CloudFormation ejecutado manualmente** (`<JENKINS_JOB_ID>`): no hay step de aprobación. Se mantiene manual o se decide un step `approval`, que hoy no se usa en Jenkins.
5. **Migraciones sin servidor target** (TANZANIA contra RDS): requieren VPC Lambda o CodeBuild en VPC. Caben en el vocabulario (`lambda`/`codebuild`), pero hay que construirlas.

**Funciones de Jenkins sin reemplazo completo:**

- Historial, consola y UI de replay: parcial (CloudWatch + DynamoDB; re-run es full replacement).
- Gráficos de tendencia de Cobertura: se pierden.
- Plugin de Jira (87 pipelines): necesita la Builds API.
- Store de credenciales: se migra a Secrets Manager credencial por credencial.
- Configuración de jobs: B2.

**Concurrencia que `executionId` + lock no resuelven:**

- Executor vs Jenkins (procedimiento de §12).
- BD DEV compartida entre variantes de ramas distintas (R9).
- Conflictos de puertos entre contenedores distintos (validación del registro).
- Operaciones destructivas a nivel host (lock de host, futuro).
- Desorden de deploys (*supersede*, incluido).

**Dependencias externas aún no disponibles:**

- Nombres, triggers y concurrencia de los jobs (B2).
- Código y formato de entrada de `<QUALITY_WORKER_FUNCTION>`.
- Buildspec del PoC anterior.
- Dockerfiles y `.dockerignore` de `<PRMS_REPORTING_REPO>`.
- Comandos exactos de migración y su orden.
- Tamaño del repo.
- Fuente de la librería `db-operations`.
- Consumidores de `<JENKINS_EXECUTIONS_TABLE>`.
- Configuración de los plugins Jira, Slack y Sonar.

**Red a validar antes de implementar el deploy:** servidor de microservicios → `<PRMS_REPORTING_DEV_TARGET>:22`, y → AWS, GitHub y Slack por 443. `<PRMS_REPORTING_DEV_TARGET>` → ECR, Secrets Manager y BD DEV (hoy funciona con Jenkins, pero desde otra identidad).

**Bloqueo genuino para el PoC:** ninguno fundamental. Los riesgos R1–R3 pueden obligar a cambiar el host del Executor (a A'), no la arquitectura.

### 15.2 Riesgos

| ID | Riesgo | Mitigación |
|---|---|---|
| R1 | Jenkins y el Executor despliegan al mismo target | Procedimiento de §12; nombres de jobs vía inventario |
| R2 | El "servidor de microservicios" es el **host de PROD** (`<MICROSERVICES_PROD_HOST>`), donde Jenkins ejecuta `swarm leave --force` y despliega un job DEV de monitoreo; un Executor DEV ahí mezcla ambientes | Confirmar el host (Q11). Si es PROD: evaluar otro host o A'. Como mínimo, contenedor fuera de Swarm y excluido de los jobs destructivos |
| R3 | Las credenciales AWS del Executor en un host compartido quedan accesibles a otros contenedores (instance profile vía IMDS) | Q12: rol dedicado con el mínimo privilegio DEV. IMDSv2 con hop limit 1 y credenciales entregadas solo al contenedor (Roles Anywhere o perfil `credential_process`). Nunca llaves estáticas de larga vida |
| R4 | `<QUALITY_WORKER_FUNCTION>` no admite invocación async o su entrada depende de secretos en el ZIP | Wrapper delgado (§10.6); Q13 |
| R5 | Las llaves sobrantes en `~/.aws` del target eclipsan el instance profile | Usuario de deploy dedicado o forzar la cadena del rol (§10.10) |
| R6 | Las migraciones no son compatibles hacia atrás | Requisito documentado; snapshot de la BD DEV antes de la primera prueba |
| R7 | Disco y concurrencia en el host compartido (`<PRMS_REPORTING_REPO>` de tamaño desconocido) | Medición en Inc 3, límites del contenedor, concurrencia acotada |
| R8 | Estado desconocido del target tras cortarse el SSH | `UNKNOWN_TARGET_STATE` + runbook; script idempotente |
| R9 | BD DEV compartida con 8 variantes de Jenkins de otras ramas | Ventanas de prueba con los jobs deshabilitados; snapshot; verificar el estado de las migraciones antes y después |
| R10 | El Executor crece hacia un workflow engine | Señales de §11 y revisión del vocabulario en cada ola |

### 15.3 Revisión de Q1–Q10 y preguntas nuevas

| ID | Pregunta original | Estado | Qué falta |
|---|---|---|---|
| Q1 | Informe de 152 pipelines + Jenkinsfile/`config.xml` de PRMS Reporting DEV | **PARTIALLY RESOLVED** | El FA está disponible y cita el Jenkinsfile de referencia línea a línea. Faltan los `config.xml`: nombres de los 8 jobs, triggers, concurrencia y la rama de cada uno (B2). Bloquea la ventana de deploy (Gate C), no el desarrollo |
| Q2 | PoC previo y script de deploy actual | **PARTIALLY RESOLVED** | Identificados: Jenkinsfiles de referencia, `<QUALITY_WORKER_FUNCTION>`, `<LEGACY_CODEBUILD_PROJECT>` y el deploy inline (no hay script). Faltan: formato de entrada del worker y si admite async; buildspec del PoC; Dockerfiles y `.dockerignore` de `<PRMS_REPORTING_REPO>`; comandos y orden exactos de la migración; rama de referencia |
| Q3 | Coexistencia con Jenkins | **PARTIALLY RESOLVED** | Política decidida (deshabilitar los jobs del target por ventana, §12). Faltan los nombres de los jobs (Q1) y el responsable de Jenkins que aprueba y ejecuta el disable y enable |
| Q4 | SSH vs SSM | **RESOLVED** | SSH para el PoC; SSM queda como futuro |
| Q5 | Instance profile en el target | **OPEN** | ¿`<PRMS_REPORTING_DEV_TARGET>` es EC2? ¿Se le puede asociar un instance profile? ¿Qué otros jobs usan sus llaves sobrantes (para no romperlos)? ¿Usuario de deploy dedicado o el actual? |
| Q6 | Red | **PARTIALLY RESOLVED** | Runtime decidido y conectividad listada (§10.2). Falta el spike de red real (Inc 0) y saber si hay proxy o firewall de salida |
| Q7 | Herramienta de IaC | **OPEN** | No hay evidencia de un estándar (el FA no encontró Terraform ni buildspecs en el repo). Falta la decisión CDK vs Terraform. **Bloquea Inc 2, no el diseño ni Inc 0–1** |
| Q8 | Framework (NestJS u otro) | **PARTIALLY RESOLVED** | Node.js/TypeScript decidido. La organización usa mucho NestJS (FA §3). Recomendación: TypeScript sin framework web, con la estructura de servicios de §14.4. NestJS standalone es aceptable si el equipo prioriza homogeneidad. Se decide en `design.md`; no bloquea |
| Q9 | Retención de artefactos | **RESOLVED** | Fuente: borrado explícito + lifecycle de 7 días. Logs y reportes: 30 días. Multipart: 1 día |
| Q10 | GitHub Actions | **RESOLVED** | Alternativa, no seleccionada |
| **Q11** | Nueva: ¿qué host es exactamente el "servidor de microservicios"? ¿Es `<MICROSERVICES_PROD_HOST>`? ¿Usa Docker standalone o Swarm? ¿Proxy de salida? | **OPEN** | Bloquea Gate B (R2) |
| **Q12** | Nueva: ¿cómo obtiene el Executor credenciales AWS en ese host sin exponerlas a otros contenedores? | **OPEN** | Bloquea Gate B (R3) |
| **Q13** | Nueva: ¿los tests de quality de server y client necesitan `.env` o `environment.ts` para compilar o pasar? | **OPEN** | Bloquea Inc 4 |
| **Q14** | Nueva: ¿algo consume la tabla `<JENKINS_EXECUTIONS_TABLE>`? | **OPEN** | No bloquea el PoC; bloquea el retiro de Jenkins |
| **Q15** | Nueva: tamaño de `<PRMS_REPORTING_REPO>` y forma de autenticación en GitHub (¿repo privado? ¿GitHub App disponible?) | **OPEN** | Se mide en Inc 3; la autenticación bloquea Inc 3 |

---

## 16. Descomposición de la iniciativa (documentada, sin crear directorios)

| Orden | Iniciativa | Propósito | Depends on | Parallel-safe |
|---|---|---|---|---|
| 1 | `cicd-executor-poc` (este) | Validar la arquitectura con PRMS Reporting DEV | none | yes |
| 1 | `jenkins-config-inventory` | Exportar `config.xml`, triggers, parámetros, concurrencia, globals, plugins, credenciales y librería `db-operations`. Mapear job → archivo. Marcar variantes muertas (~15). Inventariar scripts en hosts y en Secrets Manager | none | yes |
| 1 | `cicd-security-remediation` | §13.2 | none | yes |
| 2 | `cicd-build-runtime-poc` (**nueva, recomendada por el FA §23**) | Probar B1 con un sitio estático (un pipeline estático de INNOVATION-CATALOG o de BI, `<JENKINS_JOB_ID>`) y un ZIP esbuild: Lambda builder vs CodeBuild del ambiente, con medición | 1 (`cicd-executor-poc`) | no |
| 3+ | Olas de migración (FA §25.10): CI-only y P4b → P1 con llave → P1 con password → P2 → P5 → P3 → P6 → TANZANIA, RISK, PRMS reporting prod | Solo tras validar el PoC | 1, inventario, 2 (para P3, P5, P6) | no |

```text
Puede empezar el desarrollo del Executor PoC  ≠  Puede retirarse Jenkins
```

---

## 17. Success Criteria / Acceptance

| # | Criterio | Prueba |
|---|---|---|
| AC1 | PRMS Reporting DEV despliega de punta a punta sin Jenkins | E2E en DEV (manual; webhook en Inc 8) |
| AC2 | La imagen del Executor no contiene toolchains de build (npm de build, mvn, docker CLI ni socket) | Inspección de la imagen |
| AC3 | El Executor no tiene red ni credenciales hacia ninguna BD ni secretos de aplicación | Revisión de IAM, secretos y red |
| AC4 | CodeBuild solo para imágenes; quality en Lambda; un proyecto por app y ambiente | Definiciones + métricas |
| AC5 | Un `BUILD_COMPLETED` o `PIPELINE_REQUESTED` duplicado no produce un segundo deploy ni una segunda migración | Inyección de duplicados |
| AC6 | Dos ejecuciones concurrentes: artefactos distintos, deploys serializados, sin retroceso (*supersede*) | Prueba concurrente |
| AC7 | Una migración fallida deja la versión anterior sirviendo | Migración rota en una rama de prueba |
| AC8 | Un health check fallido restaura `previousImageTag` | Imagen que no arranca |
| AC9 | Los fallos de quality y build notifican en Slack y detienen el flujo | Test rojo / Dockerfile roto |
| AC10 | Matar el Executor a mitad de deploy termina en un estado terminal con el lock liberado | Kill del contenedor |
| AC11 | Un mensaje envenenado va a la DLQ y dispara la alarma | Mensaje malformado |
| AC12 | Ningún secreto en ZIPs, keys S3, imagen, definiciones ni logs | Escaneo |
| AC13 | Un operador reconstruye una ejecución solo con DynamoDB, CloudWatch y Slack | Ejercicio de runbook |
| AC14 | Los jobs de Jenkins se rehabilitan y funcionan tras cada ventana | Ejecución de Jenkins posterior |
| AC15 | Mediciones de duración y recursos (Lambda, CodeBuild, Executor) y comparación de costo con §14.2 | Informe de Inc 8 |

---

## 18. Recomendación: **GO WITH CONDITIONS**

La arquitectura es viable para el PoC y el FA no muestra ningún patrón que la invalide. Quedan condiciones concretas, separadas en gates distintos.

| Gate | Condiciones |
|---|---|
| **A: antes de escribir código del Executor** (Inc 0–1) | (1) Aprobar este proposal. (2) `/akili-specify` aprobado (requirements, design, tasks). Nada más: el dominio, el schema y los tests locales no dependen de AWS ni del host |
| **B: antes de desplegar el Executor e infra en DEV** (Inc 2–5) | Q11 (host identificado y aceptado frente a R2). Q12 (mecanismo de credenciales). Q7 (IaC). Acceso a DEV en `<AWS_ACCOUNT_ID>`. Spike de red de Inc 0 en verde. Token de Slack. Q15 (autenticación en GitHub). Q2 y Q13 para Inc 4–5 |
| **C: antes del deploy end-to-end en `<PRMS_REPORTING_DEV_TARGET>`** (Inc 6–8) | Nombres de los jobs que tocan el target y aprobación del procedimiento de §12 (Q1, Q3). Q5 (instance profile o equivalente, sin romper jobs que usan llaves sobrantes). Credencial SSH (llave preferida) y host key en Secrets Manager. Comando y orden de migración confirmados (Q2). Snapshot o backup de la BD DEV |
| **D: antes de retirar Jenkins** (cualquier job) | B2 completo (`jenkins-config-inventory`). B1 decidido **y probado** (`cicd-build-runtime-poc`). H1 resuelto (migraciones de PRMS prod y TANZANIA re-ubicadas). H2 (scripts inventariados y versionados). H3 (instance profiles en todos los targets y rotación de `<AWS_CREDENTIAL_REF>`). Steps SDK (`lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`). Jira Builds API. Credenciales migradas. Q14. Cada ola validada con Jenkins en paralelo |

---

## 19. Next Step

**Recomendado: `/akili-specify changes/cicd-executor-poc`** (después de aprobar este proposal).

Por qué `/akili-specify` y no `/akili-constitution` ahora:

- El Gate A solo pide el spec. Las preguntas abiertas (Q5, Q7, Q11–Q15) bloquean gates posteriores y pueden resolverse en paralelo mientras se especifica.
- Las decisiones de plataforma (runtime, SQS, DynamoDB, locks, CodeBuild por ambiente, vocabulario de steps) están registradas aquí y en el FA, así que el spec tiene una base suficiente.
- `/akili-constitution` aporta valor cuando exista el repo `cicd-platform` y la familia de §16 empiece a crecer. Entonces conviene llevar estas decisiones a un TRD o ADRs compartidos, para que las olas no las repitan. Se sugiere hacerlo al archivar este PoC (`/akili-archive`) o antes de la primera ola.

```text
/akili-specify changes/cicd-executor-poc
```

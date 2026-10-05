# Design — CI/CD Executor PoC (PRMS Reporting DEV)

> **En una línea:** un solo servicio TypeScript con arquitectura hexagonal. Un núcleo de dominio puro (state machine + planner) decide; adaptadores intercambiables actúan (SQS, DynamoDB, S3, Lambda, CodeBuild, SSH, Slack). La corrección descansa **solo** en escrituras condicionales de DynamoDB, no en el orden de la cola ni en tener una única instancia. Tier **LITE**.

---

## 1. Document Control

| Campo | Valor |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Fase | Phase 2: Design |
| Depth | Full (re-chequeado en §13) |
| Requisitos | `requirements.md` (**aprobado** 2026-10-05) |
| Intención | `proposal.md` v2 (aprobado) |
| Evidencia | FA = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`; ctx = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` (archivo renombrado el 2026-10-05 a pedido del owner para usar el nombre Akili) |
| Revisión | **v3.1** (posterior al APPROVED, autorizada por el owner): ajustes editoriales R3-1 a R3-4 y saneamiento de identificadores internos para publicar en Git. **v3**: ronda final de corrección de Judgment Day (R2-1, R2-W1 a R2-W4, R2-I1 a R2-I4) y repositorio canónico. v2: ronda 1 (C-1, C-2, S-1 a S-4, D-1, W-1 a W-6, I-1 a I-4). Detalle en `judgment.md` |
| Repositorio | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` (§4.1) |
| Skills aplicados | `software-architect` (Decision Spine). Sin UI: no se aplican skills de UX |
| Plantillas | No existe `general-setup`. Se usa la estructura mínima del comando |
| Decisiones abiertas | OD-Q5, OD-Q7, OD-Q11–OD-Q15 **siguen abiertas**. El diseño las aísla detrás de puertos o recursos para no tener que asumir su respuesta (§10, DD-16 a DD-18) |
| Fecha | 2026-10-05 |

---

## 2. Executive Summary

| Decisión | Elección | Requisitos |
|---|---|---|
| Estilo | Monolito modular hexagonal, un deployable, worker sin estado | NFR-01, NFR-08 |
| Consistencia | Escrituras condicionales en DynamoDB con versión optimista: única fuente de verdad | FR-05, FR-07, NFR-03 |
| Despacho | *Intent-then-act* con `dispatchToken` por intento | FR-07 |
| Extensión | Un handler por tipo de step, en un registro cerrado (Strategy) | FR-01, NFR-08 |
| Planificación | Función pura: estado → acciones | FR-06 |
| Esperas | Todo asíncrono por eventos salvo la sesión SSH del deploy | FR-09, FR-10, NFR-04 |
| Definiciones | Detrás del puerto `DefinitionSource`. En el PoC, empaquetadas en la imagen (simplificación del PoC); la versión es el commit del repo de la plataforma | FR-01, NFR-08 |
| Locks | Dos barreras: lock distribuido en DynamoDB (lease + propietario + fencing + supersede) **y** mutex local en el target que protege la operación física | FR-11, FR-13 |
| Ventanas de deploy | Gate genérico por target, con `deployWindowPolicy` y `externalDeployers` **obligatorios**. Se revalida en V1–V4 y las ventanas vencidas se cierran por consulta indexada. Transitorio, para convivir con Jenkins | FR-18 |
| Estados | Lista cerrada de transiciones. La única vuelta atrás es T9 (código 50) | FR-05 |
| Deploy | Script genérico versionado, entregado por SFTP en cada ejecución | FR-12, FR-13 |
| Abiertas | Credenciales AWS (Q12), host (Q11), IaC (Q7) y target (Q5) detrás de puertos o del inventario de recursos | §10 |

---

## 3. Architecture Overview

### 3.1 C4 — Contexto

```text
 [Operador DevOps] --mensaje PIPELINE_REQUESTED--> (SQS cicd-events-dev)
 [GitHub] --webhook (SHOULD)--> [Ingress Lambda] --> (SQS)
                                   |
                           [[CI/CD Executor]]
     +-------------+---------------+---------------+---------------+-------------+
     v             v               v               v               v             v
 (DynamoDB)      (S3)      [<QUALITY_WORKER_FUNCTION>] [CodeBuild        [<PRMS_REPORTING_DEV_TARGET>] [Slack]
 estado+locks  artefactos       Lambda        prms-reporting-dev]  vía SSH/SFTP
                                   |               |                       |
                                   +--Destinations-+--EventBridge--> SQS   +--> BD DEV (desde el target)

Leyenda: [ ] sistema o persona · [[ ]] sistema en diseño · ( ) almacenamiento o cola gestionada · --> flujo de datos o comandos
```

### 3.2 C4 — Contenedores del Executor

```text
+------------------------------- cicd-executor (1 contenedor) --------------------------------+
|  Inbound adapters        |  Application              |  Domain (puro)     |  Outbound ports   |
|  SqsConsumer ------------>  EventRouter ------------->  StateMachine      |  StateStore       |
|   (long-poll, heartbeat) |  ExecutionService          |  Planner          |  ArtifactStore    |
|                          |  StepDispatcher ---------->  IdempotencyRules  |  QueuePublisher   |
|                          |  Reconciler                |  LockPolicy        |  SecretProvider   |
|                          |  NotificationService       |  DefinitionModel   |  GitClient        |
|                          |                            |                    |  Step handlers:   |
|                          |                            |                    |   Lambda/CodeBuild|
|                          |                            |                    |   /Ssh/Notify     |
+--------------------------------------------------------------------------------------------+
Leyenda: flechas = dependencia de llamada. El dominio no depende de AWS ni de SSH; los puertos los implementan adaptadores.
```

### 3.3 Flujo principal (PRMS Reporting DEV)

| # | Disparador | Acción del Executor | Estado resultante |
|---|---|---|---|
| 1 | `PIPELINE_REQUESTED` | Dedupe → secuencia → crea la ejecución con la versión de la definición → resuelve el commit | Ejecución `QUEUED` → `RUNNING` |
| 2 | (interno) | Step implícito `source`: fetch, ZIP ×2, subida | `source` `SUCCEEDED` |
| 3 | Planner | Despacha `server-quality` ∥ `client-quality` (Lambda async) | Ambos `RUNNING` |
| 4 | `QUALITY_COMPLETED` ×2 | Por cada uno despacha su `*-image` (StartBuild) | Builds `RUNNING` |
| 5 | `BUILD_COMPLETED` ×2 | Fan-in condicional: un único ganador despacha `deploy` | `deploy` `WAITING_LOCK` → `DISPATCHING` |
| 6 | Ventana abierta + lock adquirido | Chequeo de ventana (si el target la exige) → supersede → SFTP del script → exec → heartbeat. El script toma el mutex local | `deploy` `RUNNING` |
| 7 | Script termina | Mapea el código de salida → actualiza el estado del target → libera el lock | `deploy` terminal |
| 8 | Planner | `finally` (notify) → la ejecución pasa a terminal | Ejecución terminal |

---

## 4. Extended Directory Structure

El workspace no tiene código. Comprobado con `find . -type f` el 2026-10-05: solo los dos documentos fuente y `docs/specs/`.

### 4.1 Repositorio canónico y control de versiones

| Aspecto | Decisión |
|---|---|
| Repositorio canónico | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` (`onecgiar-cicd-platform`), indicado por el owner el 2026-10-05. Reemplaza al directorio provisional `cicd-platform/` del proposal §14.4: **la raíz del repo es la raíz de la estructura de abajo** |
| Contenido versionado | Código del Executor, ingress y CLI de operador; Pipeline Definitions, registro de targets y schemas; tests; infraestructura; deploy scripts; buildspecs; runbooks; specs Akili (`docs/specs/…`, incluidos `proposal`, `requirements`, `design`, `judgment` y `tasks`) |
| **Excluidos (nunca versionados)** | `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` y `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`. Siguen siendo locales. Se añaden a `.gitignore` **antes del primer commit** (debe ser el primer archivo creado al vincular el workspace con el repo) |
| Verificación antes de cada commit con archivos de la raíz | `git status`, y `git ls-files` sobre ambos nombres → 0 resultados. Si alguno ya estuviera trackeado: detenerse y quitarlo del índice **sin borrar el archivo local** antes de seguir |
| Política de publicación (decidida por el owner el 2026-10-05) | Las specs y la documentación versionadas **no** publican identificadores internos: ID de cuenta, hosts, IPs, IDs de credenciales de Jenkins o SSH, nombres de secretos reveladores, detalles de BD, nombres de jobs de Jenkins ni valores sensibles. Se usan referencias lógicas (`<AWS_ACCOUNT_ID>`, `<PRMS_REPORTING_DEV_TARGET>`, `<SSH_CREDENTIAL_REF>`, `<AWS_CREDENTIAL_REF>`, `<JENKINS_JOB_ID>`, `<ECR_REPOSITORY>`, `<SERVER_CONTAINER>`, `<CLIENT_CONTAINER>`, `<QUALITY_WORKER_FUNCTION>`…) e identificadores semánticos (`prms-reporting-dev`). Los valores reales se resuelven fuera de Git (DD-23): Secrets Manager, IAM y la configuración de despliegue. Las citas al análisis local (FA §x/Lnn) se conservan como pista; su contenido no se copia |
| Saneamiento aplicado | `proposal.md`, `requirements.md`, `design.md` y `judgment.md` saneados el 2026-10-05, sin cambiar el significado de la arquitectura. Copia previa local en el scratchpad de la sesión (fuera de Git) |
| Estado del remoto | `git ls-remote` → `41f4c3e…  refs/heads/main` (P-25). Ya tiene un commit inicial de contenido no inspeccionado (P-26): la primera tarea de ejecución vincula el workspace con el remoto e integra ese contenido antes de añadir nada |
| Commits y push | Solo en las fases de ejecución de Akili. Nada se commitea ni se pushea en la fase de especificación |

### 4.2 Estructura (raíz del repo `onecgiar-cicd-platform`)

```text
onecgiar-cicd-platform/
  .gitignore                       # primero: excluye los dos archivos de análisis locales
  executor/
    src/
      main                         # bootstrap, wiring de puertos, lease de instancia, limpieza de /work/{instanceId}, shutdown ordenado
      inbound/sqs-consumer         # long-poll, heartbeat de visibilidad, ack/no-ack
      application/
        event-router               # eventType → caso de uso
        execution-service          # crear, avanzar y cerrar ejecuciones
        step-dispatcher            # intent-then-act, invoca el handler del tipo
        reconciler                 # RECONCILE_TICK
        notification-service       # fan-out a proveedores
        definition-service         # valida definiciones y registro; los obtiene vía el puerto DefinitionSource
        deploy-window-service      # abre, cierra y consulta ventanas de deploy por target (FR-18, transitorio)
      domain/
        state-machine              # transiciones válidas (tabla FR-05)
        planner                    # DAG, fan-in, skip en cascada, finally
        events                     # sobre y normalización (tipos)
        lock-policy                # lease, supersede, fencing
        errors                     # códigos (SOURCE_CLONE, MIGRATION, …)
      ports/                       # interfaces: StateStore, ArtifactStore, QueuePublisher, DefinitionSource,
                                   #   SecretProvider, GitClient, StepHandler, NotificationProvider, Clock
      adapters/
        dynamodb-state-store  s3-artifact-store  sqs-publisher  secrets-manager-provider
        git-cli-client  zip-packager  bundled-definition-source (PoC)
        handlers/{lambda,codebuild,ssh,notify}
        notify/slack-provider
      observability/{logger,metrics}
    test/{unit,integration,contract,e2e-fixtures}
    Dockerfile
    deploy/                        # artefactos para correr el contenedor en el host (según OD-Q11)
  ingress/github-webhook/          # FR-20 (SHOULD); contrato en §6.6
  tools/                           # CLI del operador: disparo manual, abrir y cerrar ventanas de deploy
  buildspecs/prms-reporting-dev.yml
  pipeline-definitions/prms/reporting-dev.yaml
  pipeline-definitions/targets/dev.yaml
  schemas/{pipeline,targets,event}.schema.json
  deploy-scripts/deploy-container.sh
  infra/                           # herramienta según OD-Q7; hasta decidirla: infra/RESOURCES.md (inventario)
  docs/{runbook,resources,jenkins-coexistence-log}.md
  docs/specs/changes/cicd-executor-poc/   # esta spec
```

---

## 5. Data Model

### 5.1 Tabla `cicd-executions-dev` (DynamoDB on-demand, TTL `expiresAt`)

| Item | PK | SK | Atributos | Escritura |
|---|---|---|---|---|
| Ejecución | `EXEC#{executionId}` | `META` | `pipelineId, definitionRef, project, environment, repository, branch, commit, sequence, trigger, triggeredBy, requestId, status, version, targets[], lockIds[], artifacts[], slackThreadTs, deadlineAt, startedAt, finishedAt, error{code,message,stepId}, activeStatus = EXECUTION (solo mientras no es terminal), expiresAt (180 d)` | Condicional sobre `version` |
| Step | `EXEC#{executionId}` | `STEP#{stepId}` | `type, status, attempt, dispatchToken, externalRef, logUrl, outputs{}, migrationsApplied, deadlineAt, activeStatus = STEP (solo mientras no es terminal), lockWaitStartedAt, lockWaitAttempts, lockLostDuringRun, windowClosedDuringRun, contentionCount, reconcileRedispatchCount, startedAt, finishedAt, error, version` | Condicional sobre `status` y `version` (§7.3) |
| Dedupe | `DEDUPE#{requestId}` | `DEDUPE` | `state (CLAIMED/BOUND), claimToken, claimLeaseExpiresAt, sequence, executionId, expiresAt (7 d)` | Ver DD-20 |
| Ventana de deploy | `WINDOW#{lockKey}` | `WINDOW` | `state (OPEN/CLOSED), openedBy, openedAt, closesAt (máx. 8 h), externalJobsDisabled[], note, closedBy, closedReason (MANUAL/EXPIRED), closedAt, version`; mientras está `OPEN`: `activeStatus = WINDOW` y `deadlineAt = closesAt` (entra en GSI2). El historial queda en ítems `WINDOW#{lockKey}` / `LOG#{openedAt}` | Condicional sobre `state` y `version` |
| Instancia del Executor | `INSTANCE#{instanceId}` | `LEASE` | `startedAt, leaseExpiresAt, hostname` (renovado cada 60 s) | `attribute_not_exists OR leaseExpiresAt < now` (§7.4) |
| Secuencia | `PIPELINE#{pipelineId}` | `SEQ` | `value` | `ADD` atómico |
| Target | `TARGET#{lockKey}` | `STATE` | `currentImages{}, previousImages{}, lastDeployedSequence, lastExecutionId, updatedAt` | Condicional al dueño del lock y al `fencingToken` |
| Lock | `LOCK#{lockKey}` | `LOCK` | `owner, fencingToken, leaseExpiresAt, acquiredAt, expiresAt` | Ver DD-09 |
| Marca de evento | `EXEC#{executionId}` | `EVT#{eventKey}` | Solo para eventos sin transición natural (p. ej. notificaciones enviadas). `expiresAt` 7 d | `attribute_not_exists` |

| Índice | Clave | Uso |
|---|---|---|
| GSI1 | `pipelineId` + `startedAt` | Historial por pipeline (FR-17) |
| GSI2 (disperso) | `activeStatus` (`EXECUTION`, `STEP` o `WINDOW`) + `deadlineAt` | Reconciler, **sin scans**: una `Query` por partición con `deadlineAt < now`. Solo contiene ítems vivos: el atributo se elimina al llegar a un estado terminal o al cerrar la ventana (FR-15, FR-18) |

### 5.2 S3 `cicd-artifacts-dev`

| Prefijo | Contenido | Ciclo de vida |
|---|---|---|
| `executions/{id}/source/{package}.zip` | Fuente sin secretos | Borrado explícito al terminar + expiración 7 d |
| `executions/{id}/quality/` | Logs y reportes (si el worker escribe aquí) | 30 d |
| (bucket) | Multipart incompletos | 1 d |

### 5.3 Estado en el target

| Elemento | Ubicación |
|---|---|
| Script entregado | `/tmp/cicd-{executionId}/deploy-container.sh` (se borra al final) |
| Configuración de runtime | `/tmp/cicd-{executionId}/runtime.env`, permisos 0600 (se borra al final). Cambio respecto al proposal (`/tmp/deploy-{executionId}.env`): un único directorio por ejecución permite borrar todo de una vez. Sigue cumpliendo FR-13 |
| Mutex local | Archivo de lock por unidad de deploy en un directorio del usuario de deploy (p. ej. `/var/lock/cicd/{lockKey}.lock`), tomado con un lock de archivo **del kernel**, no bloqueante, que el sistema operativo libera al morir el proceso. **El lock es el bloqueo del kernel, no la existencia del archivo.** El archivo contiene `executionId`, `fencingToken`, PID e inicio (diagnóstico; runbook §12.1). La sección crítica del script ignora la señal de cierre de sesión (HUP): un corte de SSH no interrumpe una migración ni un swap en curso |
| Imágenes | Se conservan la actual y la previa; se podan las más viejas |

---

## 6. API Design (contratos)

No hay API REST de orquestación. Los contratos son mensajes y CLIs.

### 6.1 Sobre de evento (`schemas/event.schema.json`)

| Campo | Obligatorio | Notas |
|---|---|---|
| `specVersion` | sí | `1` |
| `eventId` | sí | UUID |
| `eventType` | sí | `PIPELINE_REQUESTED, QUALITY_COMPLETED, QUALITY_FAILED, QUALITY_TIMED_OUT, BUILD_COMPLETED, BUILD_FAILED, BUILD_TIMED_OUT, DEPLOYMENT_COMPLETED, DEPLOYMENT_FAILED, PIPELINE_COMPLETED, PIPELINE_FAILED, STEP_RETRY_REQUESTED, LOCK_RETRY_REQUESTED, RECONCILE_TICK, DEPLOY_WINDOW_OPEN_REQUESTED, DEPLOY_WINDOW_CLOSE_REQUESTED` |
| `executionId` | sí (salvo `PIPELINE_REQUESTED`, `RECONCILE_TICK` y `DEPLOY_WINDOW_*`) | |
| `pipelineId`, `environment` | sí (salvo `RECONCILE_TICK` y `DEPLOY_WINDOW_*`, que llevan `lockKey`) | |
| `stepId`, `status`, `attempt` | en resultados de step | |
| `timestamp`, `source` | sí | `source ∈ executor, lambda, codebuild, ingress, scheduler, operator` |
| `payload` | no | Solo referencias e identificadores; tamaño máximo del mensaje 64 KB por diseño |
| `requestId` | en `PIPELINE_REQUESTED` | Clave de dedupe |

**Normalización en la recepción:**

| Origen | Se reconoce por | Correlación |
|---|---|---|
| Lambda Destinations | Forma del registro de destino (`requestContext`, `requestPayload`, `responsePayload`) | `requestPayload.executionId` + `stepId` + `dispatchToken` |
| EventBridge CodeBuild | `detail-type = CodeBuild Build State Change` | `buildId` == `externalRef` del step |

**Eventos huérfanos (FR-04):** si el `executionId` no existe, el `stepId` no existe en esa ejecución, o el identificador externo no coincide con el `externalRef` del intento vigente (p. ej. el resultado de un intento anterior ya reemplazado), `event-router` registra `ORPHAN_EVENT` (log con todos los identificadores recibidos + métrica `OrphanEvents`) y confirma el mensaje **sin efectos**. Un evento de un intento anterior nunca modifica el intento vigente.

### 6.2 Contrato Lambda (`<QUALITY_WORKER_FUNCTION>`)

| Dirección | Contenido |
|---|---|
| Entrada (Executor → worker) | `executionId, stepId, dispatchToken, task, sourceRef (S3 URI)` + los campos que exija el worker (P-2) |
| Salida (worker → Destinations) | `status, failedCommand, exitCode, error, logS3Uri, logUrl` (P-1) |
| Configuración | Invocación `Event` sobre un **alias dedicado** `cicd` con su propia configuración async (`MaximumRetryAttempts=0`, `onSuccess`/`onFailure` → SQS). La función sin calificar no se toca (DD-07) |

### 6.3 Contrato CodeBuild

| Elemento | Valor |
|---|---|
| Proyecto | El declarado en el step (`prms-reporting-dev`) |
| Overrides | Fuente S3 = ZIP de la ejecución; env `EXECUTION_ID, STEP_ID, IMAGE_TAG, COMPONENT`; `idempotencyToken = dispatchToken` |
| Buildspec | Versionado en `buildspecs/`; se asocia al proyecto en infraestructura (no viaja en el ZIP) |
| Secretos de build | Variables de tipo Secrets Manager declaradas en el proyecto, de solo lectura y solo DEV |
| Salidas | `imageUri`, `digest` como variables exportadas del build, leídas del evento o, si el evento no las trae, de `BatchGetBuilds` en el handler |
| Finalización | Regla EventBridge filtrada por los proyectos de la plataforma → SQS |

### 6.4 CLI del deploy script (`deploy-container.sh`)

| Argumento | Significado |
|---|---|
| `--execution-id` | Para rutas temporales y logs |
| `--unit` | Nombre de la unidad de deploy (informativo) |
| `--image <container>=<imageUri>` (repetible) | Imagen nueva por contenedor |
| `--previous <container>=<imageUri>` (repetible, pista) | Imagen previa según el estado del target en DynamoDB. **La fuente autoritativa para restaurar es la imagen que el contenedor está corriendo en el host al iniciar el script**; la pista solo se usa si el contenedor no existe. Así el rollback es correcto aunque una ejecución anterior desplegara sin poder actualizar DynamoDB (S-2) |
| `--lock-key`, `--fencing-token` | Identifican el mutex local y quién lo tiene |
| `--port <container>=<host:container>` (repetible) | Del registro de targets |
| `--runtime-secret <container>=<secretRef>` (opcional) | Referencia; el target la resuelve con sus propios permisos (OD-Q5) |
| `--migrate <container>` + `--migration-check <cmd>` + `--migration-run <cmd>` (opcional) | Del registro de targets |
| `--health <container>=<url or cmd>` (opcional) | Health check |

Primer paso del script, antes de cualquier efecto: tomar el mutex local (no bloqueante). Si está tomado, sale con **50 (`TARGET_BUSY`) sin haber hecho nada**.

Salida: códigos 0/10/20/30/40/50 (FR-13) y, como última línea de stdout, `CICD_RESULT` seguido de un JSON con `status, deployedImages, previousImages, migrations (APPLIED|NONE|FAILED), healthy, mutexHolder` (este último solo con 50).

### 6.6 Contrato del webhook de GitHub (FR-20, SHOULD; Inc 8)

| Aspecto | Contrato |
|---|---|
| Endpoint | Lambda `cicd-github-ingress-dev` detrás de una Function URL. Es el único componente expuesto; el Executor no expone puertos |
| Autenticación | Firma `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo, comparación en tiempo constante) con el secreto `<WEBHOOK_SECRET_REF>`. Firma ausente o inválida → **401**, nada se encola |
| Eventos aceptados | `push`; `ping` → 200 sin efecto; cualquier otro → 202 ignorado y registrado |
| Mapeo | Repositorio + `ref` (`refs/heads/<rama>`) → las definiciones con trigger `github-push` cuya `repository.url` y `branch` coinciden. Se obtienen del mismo `DefinitionSource` empaquetado (DD-19) |
| Rama no configurada o sin coincidencia | 202, registro `WEBHOOK_UNMATCHED`, nada se encola |
| Pushes que borran la rama (`deleted: true`) | 202 ignorado |
| Encolado | Un `PIPELINE_REQUESTED` por definición que coincide, con `requestId = X-GitHub-Delivery + ":" + pipelineId`, commit `after` y `triggeredBy` = el usuario del push |
| Respuesta | 202 tras encolar. GitHub reintenta si no recibe 2xx; el dedupe (DD-20) absorbe los reintentos |

### 6.5 Notificación (Slack)

Mensaje raíz al iniciar: pipeline, `executionId`, commit, rama y enlace a logs. Respuestas en hilo para cada fallo o timeout. El mensaje raíz se actualiza con el resultado final y la duración. Sin secretos.

---

## 7. Backend Module Design

| Módulo | Responsabilidad | Requisitos | Prohibido |
|---|---|---|---|
| `sqs-consumer` | Long-poll de 20 s. Concurrencia de handlers acotada. Heartbeat de visibilidad cada 60 s mientras el handler vive. Ack solo si el handler terminó o el evento es un no-op reconocido | FR-04, NFR-04 | Lógica de negocio |
| `main` (bootstrap) | Antes de consumir: (1) adquiere el lease de instancia `INSTANCE#{instanceId}`; (2) limpia **solo** `/work/{instanceId}/`. Modelo completo en §7.4 | FR-08 | Tocar directorios de otro `instanceId` |
| `event-router` | Valida el sobre, normaliza los orígenes AWS, detecta **eventos huérfanos** (§6.1) y enruta | FR-04 | — |
| `deploy-window-service` | Atiende `DEPLOY_WINDOW_OPEN_REQUESTED/CLOSE_REQUESTED` (CLI del operador en `tools/`). Abre la ventana solo si el pedido trae `openedBy` y un `externalJobsDisabled[]` no vacío que **cubra** los `externalDeployers` declarados para ese target en el registro (§7.7). La cierra a pedido o al vencer `closesAt`. Responde a `isDeployAllowed(lockKey, needUntil)`: hay ventana `OPEN` con `closesAt ≥ needUntil` | FR-18 | Conocer Jenkins: la lista de jobs es dato opaco que se compara y registra |
| `execution-service` | Dedupe → secuencia → creación con `definitionRef`. Resolución del commit vía `GitClient`. Avance y cierre | FR-03, FR-05 | — |
| `definition-service` | Obtiene definiciones y registro **solo** a través de `DefinitionSource` (en el PoC, `bundled-definition-source`). Valida el schema y las reglas semánticas: ciclos, `needs` inexistentes, tipos reservados, interpolación fuera de la lista blanca, ambiente ≠ dev, puertos o nombres duplicados por host, host key ausente, migraciones habilitadas sin `migrationCompatibility: backward-compatible` declarada en el target (DD-11), y la **política de ventana obligatoria y coherente** de §7.7. Un registro inválido impide el arranque del Executor; la misma validación corre en CI antes de construir la imagen | FR-01, FR-02 | Leer valores de secretos |
| `planner` (dominio) | Recibe los steps con sus estados y devuelve las acciones (despachar X, saltar Y, ejecutar finally, cerrar la ejecución) | FR-06 | I/O |
| `state-machine` (dominio) | Lista cerrada de transiciones con guardas (§7.3). Toda transición ausente de la lista, incluida cualquier otra vuelta atrás, se rechaza | FR-05 | I/O |
| `step-dispatcher` | Para cada acción de despacho: transición condicional (T1/T3 de §7.3) con un `dispatchToken` nuevo → llama al handler → guarda `externalRef` → `RUNNING`. Si la transición falla, no-op | FR-07 | Reintentar efectos sin pasar por el estado |
| `handlers/source` | Fetch del commit exacto, ZIP en streaming con exclusiones obligatorias, subida multipart, limpieza en finally. Semáforo de concurrencia | FR-08 | Instalar dependencias o ejecutar scripts del repo |
| `handlers/lambda` | Invoca el alias en modo Event | FR-09 | Invocación síncrona |
| `handlers/codebuild` | `StartBuild` con overrides e `idempotencyToken` | FR-10 | Polling en el camino normal |
| `handlers/ssh` | Secuencia y recursos en §7.5: ventana (punto V1/V2) → lock distribuido (DD-09) → supersede → **semáforo global de sesiones SSH** (default 4, configurable; NFR-04) → SFTP del script → ventana (punto V4) → `RUNNING` → exec con args escapados → captura → mapeo del código (50 → T9 de §7.3) → estado del target (con fencing) → liberación según la tabla de §7.5. Mientras espera el semáforo, el mensaje sigue con heartbeat (DD-14) | FR-11, FR-12, FR-18 | Construir comandos concatenando texto; abortar un script en curso |
| `notification-service` | Selecciona proveedores por definición. Best-effort. Marca `EVT#` para no duplicar | FR-14 | Cambiar el estado de la ejecución |
| `reconciler` | Tres `Query` a GSI2, nunca scans: `activeStatus = STEP` y `= EXECUTION` con `deadlineAt < now` (recuperación de resultados según la tabla de §7.3: T8, T13 o T12; `WAITING_LOCK` vencido: `LOCK_TIMEOUT` por T5, regla canónica de §7.3; luego el planner) y `activeStatus = WINDOW` con `deadlineAt < now` (cierre de ventanas vencidas, §7.7) | FR-15, FR-11, FR-18 | Re-ejecutar un deploy; abortar uno en curso |
| `observability` | Logger JSON con contexto (`executionId`, `stepId`, `eventType`, `attempt`) y redacción de patrones de secretos. Métricas EMF | FR-17 | — |

### 7.1 Plazos (`deadlineAt`)

| Step | Plazo por defecto |
|---|---|
| `source` | 15 min |
| `lambda` | 17 min (15 de Lambda + margen) |
| `codebuild` | Timeout del proyecto + 5 min |
| `ssh` | `timeoutMinutes` del step (20 en el PoC) + 5 min |
| Ejecución | 120 min |
| Espera de lock | 30 min acumulados (FR-11). Mientras dura, `deadlineAt` del step = `lockWaitStartedAt` + 30 min + 5 min (red de seguridad del reconciler) |

### 7.2 Mapeo de fallos (implementa FR-16)

| Origen | Clasificación | Reintento | Quién reintenta |
|---|---|---|---|
| Clone | `SOURCE_CLONE` | 2, con backoff, dentro del handler | Handler |
| ZIP | `SOURCE_PREP` | 0 | — |
| Subida | `ARTIFACT_UPLOAD` | SDK + 1 del step | `STEP_RETRY_REQUESTED` |
| Lambda: error de función | `INFRA` | 1 | `STEP_RETRY_REQUESTED` (nuevo `attempt` y `dispatchToken`) |
| Lambda: `status` de fallo | `QUALITY` | 0 | — |
| Lambda: timeout | `TIMED_OUT` | 0 | — |
| `StartBuild` rechazado (API) | `INFRA` | 1 | `STEP_RETRY_REQUESTED` |
| Build `FAILED/STOPPED` | `BUILD` | 0 | — |
| Build `TIMED_OUT` | `TIMED_OUT` | 0 | — |
| Conexión SSH o host key | `SSH_CONNECT` / `HOST_KEY_MISMATCH` | 2 / 0, antes de ejecutar | Handler |
| Exit 10/20/30/40/otro | `PULL` / `MIGRATION` / `START` / `HEALTH` / `UNKNOWN_TARGET_STATE` | 0 | — |
| Exit 50 (`TARGET_BUSY`) | Contención: el script no hizo nada | Vuelve a `WAITING_LOCK` (T9) y consume del mismo presupuesto de 30 min | `LOCK_RETRY_REQUESTED` |
| Lock ocupado más de 30 min acumulados | `LOCK_TIMEOUT` | 0 | — |
| Target exige ventana y no hay una vigente para la duración necesaria | `DEPLOY_WINDOW_CLOSED` (no se abre SSH o no se ejecuta el script) | 0 | — |

### 7.3 Máquina de estados del step: lista cerrada (corrige R2-1)

Regla general: **solo** son válidas las transiciones de esta tabla. Cada una se aplica con una escritura condicional sobre el estado de origen, el `attempt` y la `version` vigentes. Los estados terminales (`SUCCEEDED, FAILED, TIMED_OUT, SKIPPED`) son inmutables. Una transición pedida que no figura aquí se rechaza y se registra (`INVALID_TRANSITION`), sin efectos.

| # | Desde | Hacia | Tipos de step | Disparador y guarda |
|---|---|---|---|---|
| T1 | `PENDING` | `DISPATCHING` | `source`, `lambda`, `codebuild`, `notify` | Planner: dependencias en `SUCCEEDED`. Nuevo `dispatchToken` |
| T2 | `PENDING` | `WAITING_LOCK` | `ssh` | Planner: dependencias en `SUCCEEDED`. Guarda `lockWaitStartedAt = now` |
| T3 | `WAITING_LOCK` | `DISPATCHING` | `ssh` | Ventana válida (V1/V2) + lock adquirido + no superseded. Nuevo `dispatchToken` |
| T4 | `WAITING_LOCK` | `SKIPPED` | `ssh` | Supersede (`lastDeployedSequence > sequence`) |
| T5 | `WAITING_LOCK` | `FAILED` | `ssh` | `LOCK_TIMEOUT` o `DEPLOY_WINDOW_CLOSED` |
| T6 | `DISPATCHING` | `RUNNING` | todos | `externalRef` registrado (`ssh`: justo antes del exec, tras V4) |
| T7 | `DISPATCHING` | `FAILED` | todos | Error de despacho no reintentable, o reintentos agotados, o `DEPLOY_WINDOW_CLOSED` en V4 (`ssh`) |
| T8 | `RUNNING` | `SUCCEEDED` / `FAILED` / `TIMED_OUT` | todos | Resultado del intento vigente (`externalRef` coincide) |
| **T9** | **`RUNNING`** | **`WAITING_LOCK`** | **solo `ssh`** | **Única vuelta atrás por contención.** Guarda: el resultado del intento vigente es el **código 50** (`TARGET_BUSY`) del deploy script. No hay ninguna otra causa válida |
| T10 | `RUNNING` o `DISPATCHING` | `DISPATCHING` (mismo step, `attempt + 1`) | `source`, `lambda`, `codebuild` | `STEP_RETRY_REQUESTED`: error clasificado como reintentable en §7.2 y `attempt` < máximo. Nuevo `dispatchToken`; el resultado del intento anterior pasa a ser huérfano (§6.1). **Nunca** aplica a `ssh` |
| T11 | `PENDING` | `SKIPPED` | todos | Dependencia `FAILED`/`TIMED_OUT`/`SKIPPED`, o `when` falso |
| T12 | `DISPATCHING` / `RUNNING` | `TIMED_OUT` | todos | Reconciler: `deadlineAt < now` y no aplica T13 ni la adopción del resultado real (fila `reconciler` de §7). **No** aplica a `WAITING_LOCK`: ver la regla canónica de abajo |
| T13 | `DISPATCHING` (sin `externalRef`) | `DISPATCHING` (**mismo** `attempt`, **mismo** `dispatchToken`) | `codebuild`, `lambda` | Reconciler: `deadlineAt < now`, el step nunca registró `externalRef` (el Executor cayó entre la intención y el registro, DD-04) y `reconcileRedispatchCount = 0`. Vuelve a llamar con el mismo token: CodeBuild lo usa como `idempotencyToken` (no crea un segundo build si el primero existió, P-18); la quality en Lambda es de solo lectura (repetirla es inocua). Incrementa `reconcileRedispatchCount` y fija un nuevo `deadlineAt`. Si vuelve a vencer → T12. **Nunca** aplica a `ssh` (un `ssh` en `DISPATCHING` no ejecutó el script, porque el exec ocurre tras T6; vence por T12) ni a `source` (se re-despacha por T10 con un `attempt` nuevo) |

**Recuperación de resultados perdidos por el reconciler (R3-2):**

| Situación del step vencido | Acción del reconciler | Transición |
|---|---|---|
| `RUNNING` `codebuild` con `externalRef` | `BatchGetBuilds`. Si terminó, adopta el resultado real | T8 |
| `RUNNING` `codebuild` con `externalRef`, el build sigue corriendo | Extiende `deadlineAt` hasta el timeout del proyecto + 5 min (una sola vez) | Sin transición |
| `DISPATCHING` `codebuild`/`lambda` sin `externalRef`, primer vencimiento | Re-despacho idempotente con el mismo token | T13 |
| `DISPATCHING` sin `externalRef` tras T13, u otro tipo | Cierre | T12 (`TIMED_OUT`) |
| `RUNNING` `lambda` sin resultado | Cierre (los Destinations no llegaron) | T12 (`TIMED_OUT`) |
| `RUNNING` `ssh` con lease vencido | Cierre con `UNKNOWN_TARGET_STATE` (runbook §12.1) | T8 (`FAILED`) |

**Regla canónica en el límite de 30 min de espera de lock (R3-4):** el resultado de agotar la espera de lock es **siempre `FAILED` con código `LOCK_TIMEOUT` (T5)**, nunca `TIMED_OUT`.
- Lo aplica el handler al procesar un `LOCK_RETRY_REQUESTED` con espera ≥ 1.800 s.
- Lo aplica también el reconciler al encontrar un `WAITING_LOCK` con `deadlineAt < now`, por ejemplo porque se perdió el mensaje de reintento.
- Si ambos compiten, la escritura condicional deja pasar a uno solo, y los dos escriben exactamente el mismo resultado. Así el desenlace es determinista para la implementación y para los tests.

**Detalle de T9 (código 50):**

| Aspecto | Comportamiento |
|---|---|
| Estados que pueden recibir el 50 | Solo `RUNNING`: el código existe únicamente después de iniciar el exec, y el step se marca `RUNNING` antes del exec (T6). En `DISPATCHING` no existe ningún código de salida, así que `DISPATCHING → WAITING_LOCK` **no** es válida |
| Recursos que se liberan | Sesión SSH cerrada; cupo del semáforo SSH; lock distribuido (liberación condicional al dueño). El script ya no tiene nada que limpiar: sale con 50 antes de cualquier efecto y borra su `/tmp/cicd-{executionId}/` |
| Identidad preservada | El mismo `executionId`, `stepId`, `lockWaitStartedAt` y presupuesto acumulado. Se incrementan `attempt` y `contentionCount`; el `dispatchToken` del intento queda cerrado |
| Reintento | Se publica `LOCK_RETRY_REQUESTED` con el retraso del calendario de §7.6, recortado al presupuesto restante. Si no queda presupuesto: T5 (`LOCK_TIMEOUT`) en el mismo procesamiento |
| Revalidación | Antes de publicar el reintento se comprueba la ventana (V3). Si ya no es válida: T5 con `DEPLOY_WINDOW_CLOSED` en lugar de reencolar |
| Idempotencia | El resultado 50 se procesa en el mismo handler que abrió la sesión. Una re-entrega del mensaje original encuentra el step en `WAITING_LOCK` con otro `attempt` y no hace nada |

### 7.4 Workspace `/work`: propiedad y limpieza (corrige R2-W4)

| Aspecto | Diseño |
|---|---|
| Identidad de instancia | Cada contenedor del Executor tiene un `instanceId` **estable y único**, configurado en el despliegue (no aleatorio, para que un reinicio de la misma instancia reconozca su propio trabajo huérfano) |
| Exclusividad garantizada | Al arrancar, `main` adquiere `INSTANCE#{instanceId}` con escritura condicional (`attribute_not_exists OR leaseExpiresAt < now`) y lo renueva cada 60 s. Si otro contenedor vivo tiene el mismo `instanceId`, **el arranque se aborta**. Una mala configuración no puede llevar a dos procesos sobre el mismo subárbol |
| Nombres | `/work/{instanceId}/{executionId}/{stepId}-{attempt}/` |
| Propiedad | Una instancia solo crea, lee y borra bajo `/work/{instanceId}/`. Nunca toca otros subárboles, aunque el volumen se comparta |
| Limpieza por ejecución | El handler `source` borra su directorio en `finally` (éxito o fallo) |
| Limpieza al arrancar | Tras adquirir el lease, se borra todo `/work/{instanceId}/*`: con el lease en mano, ningún otro proceso puede tener trabajo vivo ahí, y el proceso anterior de esta instancia ya murió |
| Limpieza de rezagados | Cada 10 min, la instancia borra los directorios bajo su subárbol que **no** estén en su conjunto en memoria de trabajos activos y tengan más de 30 min (más que el plazo de `source`) |
| Varias instancias en el futuro | Seguro por construcción: subárboles disjuntos por `instanceId` y lease que impide duplicados. El volumen puede ser local de cada contenedor (recomendado) o compartido, sin depender de esa diferencia |

### 7.5 Recursos del handler SSH: adquisición y liberación (corrige R2-I2)

Orden de adquisición: **ventana (comprobación) → lock distribuido → semáforo SSH → sesión SSH → mutex local (lo toma el script en el target)**. Se liberan en orden inverso, en **toda** salida del handler.

| Salida | Mutex local (target) | Sesión SSH | Semáforo SSH | Lock distribuido | Estado del step |
|---|---|---|---|---|---|
| Éxito (código 0) | Lo libera el script al terminar | Cerrada | Liberado | Liberado (condicional al dueño) | `SUCCEEDED` |
| Fallo del script (10/20/30/40/otro) | Lo libera el script o el SO al terminar | Cerrada | Liberado | Liberado | `FAILED` (o `UNKNOWN_TARGET_STATE`) |
| Fallo de conexión SSH (antes del exec) | No llegó a tomarse | n/a | Liberado | Liberado | `FAILED (SSH_CONNECT)` tras los reintentos |
| Código 50 | Nunca se tomó (lo tiene otro proceso) | Cerrada | **Liberado** | **Liberado** | T9 → `WAITING_LOCK` (el step en espera **no ocupa** ningún cupo de semáforo) |
| Timeout del step con el script corriendo | Sigue tomado por el script, que sigue corriendo: ignora HUP | Cerrada | Liberado | **No se libera**: se deja de renovar y vence el lease | `UNKNOWN_TARGET_STATE` (runbook §12.1) |
| `DEPLOY_WINDOW_CLOSED` en V4 | No llegó a tomarse | Cerrada | Liberado | Liberado | `FAILED` |
| Interrupción del Executor (caída o reinicio) | Sigue tomado mientras el script viva; el SO lo libera al terminar | Cortada | Desaparece con el proceso (está en memoria) | Vence el lease (sin renovación) | El reconciler lo resuelve como `UNKNOWN_TARGET_STATE` |

### 7.6 Espera de lock: calendario exacto (corrige R2-I1; implementa C-1)

Parámetros: presupuesto **1.800 s** (30 min); retraso máximo por mensaje SQS **900 s** (P-22); calendario base 30, 60, 120, 240, 480, 900 s. Regla: `retraso = min(siguiente del calendario, presupuesto − espera acumulada)`. La **espera acumulada** se mide siempre como `now − lockWaitStartedAt`, tomada del estado persistido, no como suma de retrasos.

| Intento de adquisición | Retraso publicado tras fallar | Espera acumulada planificada al siguiente intento |
|---|---|---|
| 1 (T2, inmediato) | 30 s | 30 s |
| 2 | 60 s | 90 s |
| 3 | 120 s | 210 s |
| 4 | 240 s | 450 s |
| 5 | 480 s | 930 s |
| 6 | 870 s (recortado: quedan 870) | 1.800 s |
| 7 | — | Si falla: espera ≥ 1.800 s → `LOCK_TIMEOUT` (T5) |

- **Sin contención:** 7 intentos de adquisición y 6 reencolados como máximo. Ningún mensaje lleva más de 900 s de retraso.
- **Valores reales:** el tiempo de proceso y la latencia de la cola hacen que la espera real sea un poco mayor que la planificada; la decisión usa siempre la espera real.
- **Con código 50:** cada vuelta por T9 consume del mismo presupuesto y retoma el calendario por el siguiente valor.
- **Tope de seguridad:** 10 intentos en total. Solo se alcanza si los 50 se repiten y producen muchas re-entradas cortas; llegar a él produce `LOCK_TIMEOUT`.

### 7.7 Ventanas de deploy: configuración segura y revalidación (corrige R2-W1, R2-W2, R2-W3)

**Configuración segura por construcción (R2-W2).** En el registro de targets, dos atributos son **obligatorios** en toda entrada, sin valor por defecto:

| Atributo | Valores | Regla de validación |
|---|---|---|
| `externalDeployers` | Lista (puede ser vacía `[]`, pero debe declararse) de identificadores opacos de sistemas externos que también despliegan esa unidad (p. ej. nombres de jobs) | Omitirlo = registro inválido |
| `deployWindowPolicy` | `required` \| `not-required` | Omitirlo = registro inválido. Si `externalDeployers` no está vacío, **solo** se acepta `required`. `not-required` exige además `externalDeployers: []` |

- **Forma versionada (DD-23):** en Git, `externalDeployers` se declara como `externalDeployersRef` (referencia a la lista real, que no se publica) o como `none` explícito. CI valida la forma: con referencia ⇒ solo `required`; `not-required` ⇒ solo `none`. Al arrancar se resuelve la referencia y se valida que la lista no esté vacía.
- **Detección:** la validación corre en CI antes de construir la imagen y otra vez al arrancar el Executor, que no arranca con un registro inválido. Un error de configuración se detecta **antes** de cualquier deploy.
- **Frontera:** el núcleo no sabe qué es Jenkins; solo compara listas opacas. Para `<PRMS_REPORTING_DEV_TARGET>`, `externalDeployers` lista los jobs de P-13. Cuando se retire Jenkins de ese target, se vacía la lista y se pasa a `not-required`: es un cambio de datos, no de código.
- **Cobertura al abrir una ventana:** `externalJobsDisabled[]` debe contener **todos** los `externalDeployers` del target. Si falta alguno, la apertura se rechaza.

**Revalidación (R2-W1).** Una ventana válida al empezar la ejecución **no** autoriza el deploy indefinidamente. Se comprueba `isDeployAllowed(lockKey, needUntil)` con `needUntil = now + timeoutMinutes del step ssh` (la ventana debe cubrir la duración posible del deploy) en estos puntos:

| Punto | Momento | Si no es válida |
|---|---|---|
| V1 | Antes del primer intento (al entrar en T2 y antes de T3) | T5: `FAILED (DEPLOY_WINDOW_CLOSED)`, sin lock ni SSH |
| V2 | En cada `LOCK_RETRY_REQUESTED`, antes de intentar el lock | T5, sin reencolar |
| V3 | Tras recibir el código 50, antes de publicar el reintento | T5 en lugar de reencolar |
| V4 | Justo antes del exec SSH, con lock, semáforo y sesión ya tomados | T7: se cierra la sesión sin ejecutar el script y se liberan todos los recursos |

Comportamiento operativo de T5 y T7 por ventana: los dependientes pasan a `SKIPPED`, se ejecuta `finally`, se notifica `DEPLOY_WINDOW_CLOSED` con el target y el motivo (`NO_WINDOW`, `EXPIRED` o `INSUFFICIENT_REMAINING`), y el operador puede reabrir la ventana y volver a disparar. Si la ventana vence **mientras** el script corre, no se aborta (interrumpir una migración es peor): se marca `windowClosedDuringRun` y se notifica.

**Reconciliación indexada de ventanas (R2-W3).**

| Aspecto | Diseño |
|---|---|
| Patrón de acceso | "Ventanas abiertas vencidas": `Query` sobre GSI2 con `activeStatus = WINDOW` y `deadlineAt < now`. Sin scans |
| Indexación | Al abrir, el ítem `WINDOW#{lockKey}` recibe `activeStatus = WINDOW` y `deadlineAt = closesAt`. Al cerrar (manual o por vencimiento) se **eliminan** ambos atributos, así que el ítem sale del índice disperso |
| Cierre | Escritura condicional (`state = OPEN` y `version`) → `CLOSED`, `closedReason = EXPIRED`, entrada `LOG#`, notificación. Si otro proceso ya la cerró, no-op |
| Interacción con ejecuciones | Ninguna acción directa sobre steps. Los steps en `WAITING_LOCK` fallan en su próxima revalidación (V2/V3); los que están en `RUNNING` no se abortan y quedan con `windowClosedDuringRun` si su `needUntil` superaba el cierre |
| Volumen | A lo sumo una ventana abierta por target: la partición `WINDOW` es mínima en el PoC |

---

## 8. Frontend / UX Component Architecture

No aplica: no hay UI. La "interfaz" del operador son Slack, CloudWatch Logs Insights (consulta guardada "timeline de ejecución") y la lectura del estado en DynamoDB (documentada en el runbook).

---

## 9. Shared Contracts / Package Extensions

| Contrato | Archivo | Consumidores |
|---|---|---|
| Schema de definición | `schemas/pipeline.schema.json` | `definition-service`, autores de pipelines, CI de validación |
| Schema del registro de targets | `schemas/targets.schema.json` | `definition-service`, handler SSH |
| Schema de evento | `schemas/event.schema.json` | Executor, ingress, el script de disparo manual |
| CLI del deploy script | `deploy-scripts/deploy-container.sh` + `docs/runbook.md` | Handler SSH; futuras olas P1 (~57 pipelines) |
| Contrato del worker | §6.2 | `<QUALITY_WORKER_FUNCTION>` (alias `cicd`) |

---

## 10. Design Decisions

### Quality-attribute scenarios (Decision Spine, paso 1)

| ID | Atributo | Estímulo | Respuesta medible | Tácticas |
|---|---|---|---|---|
| QAS-1 | Confiabilidad | Un evento de finalización llega 2+ veces o desordenado | 0 despachos duplicados; 0 transiciones inválidas en 100 inyecciones | Escrituras condicionales, intent-then-act, idempotency token |
| QAS-2 | Disponibilidad | El contenedor muere en cualquier punto | Toda ejecución afectada termina en estado terminal ≤ plazo + 10 min; lock libre ≤ lease | Worker sin estado, reconciler, lease |
| QAS-3 | Rendimiento | Un evento de finalización entra a la cola | Siguiente step despachado ≤ 60 s p95 (NFR-05) | Long-poll, handlers no bloqueantes |
| QAS-4 | Seguridad | Ejecución normal | 0 secretos detectables en ZIPs, objetos, imagen y logs | El Executor no lee secretos de aplicación, redacción, mínimo privilegio |
| QAS-5 | Modificabilidad | Un nuevo pipeline P1 | 0 líneas de código del Executor cambiadas. En el PoC sí requiere **reconstruir y redesplegar la imagen**, por la simplificación de DD-19 | Definiciones declarativas, registro de handlers, puerto `DefinitionSource` |
| QAS-6 | Costo | Ejecución del PoC | CodeBuild solo en los steps de imagen; 0 cómputo permanente nuevo | Política Lambda/CodeBuild, host existente |
| QAS-7 | Escalabilidad | — | **No significativa arquitectónicamente** a este volumen: concurrencia acotada a propósito (NFR-04) | — |

**Tier:** LITE. Ningún escenario exige un broker distinto, sagas ni orquestación gestionada. Las señales para reconsiderar Step Functions están en el proposal §11.

### DD-01 — Monolito modular hexagonal, worker sin estado
- **Problema:** separar decisiones (dominio) de efectos (AWS, SSH) para probar la corrección sin infraestructura y mantener la frontera NFR-01.
- **Decisión:** dominio puro (state machine, planner, lock policy) con puertos; adaptadores para AWS, SSH y Slack. Un solo deployable.
- **Rechazado:** microservicios por capacidad (sin evidencia, QAS-7); NestJS (añade contenedor DI y un framework HTTP que no se usan).
- **Implicación:** cumple QAS-1, QAS-2 y QAS-5. Ver DD-15 sobre la elección de framework.

### DD-02 — Una cola Standard y normalización en la recepción
- **Decisión:** una cola + DLQ. Los resultados nativos de AWS se traducen al sobre en `event-router`.
- **Rechazado:** una cola por tipo de evento (más recursos sin beneficio); FIFO (no aporta corrección; proposal §10.3).
- **Implicación:** el orden no importa; lo garantizan las transiciones condicionales.

### DD-03 — DynamoDB como única fuente de verdad (concurrencia optimista)
- **Decisión:** toda mutación es condicional sobre `status` y `version`. Fallo de condición = "ya procesado" = no-op con ack.
- **Rechazado:** locks en memoria o instancia única obligatoria (frágil ante reinicios); FIFO para serializar por ejecución.
- **Implicación:** permite 2 instancias sin cambios. Los tests de integración usan DynamoDB Local.

### DD-04 — Intent-then-act con `dispatchToken`
- **Problema:** caída entre el efecto externo y el registro.
- **Decisión:** registrar `DISPATCHING + dispatchToken` antes de llamar a AWS. CodeBuild usa ese token como `idempotencyToken`. Lambda quality es repetible. SSH queda protegido por lock + estado.
- **Implicación:** un `DISPATCHING` sin `externalRef` tras el plazo lo resuelve el reconciler: re-despacho único con el mismo token (T13) en `codebuild` y `lambda`; `TIMED_OUT` (T12) en `ssh` y en un segundo vencimiento. Detalle en §7.3.

### DD-05 — Registro cerrado de handlers (patrón Strategy)
- **Problema:** añadir capacidades sin lógica por proyecto.
- **Decisión:** interfaz `StepHandler` por tipo; registro fijo en el arranque. Un tipo no registrado es un error de validación. Los tipos reservados están en el schema pero no tienen handler.
- **Rechazado:** plugins dinámicos o scripts embebidos (vía hacia "otro Jenkins").

### DD-06 — Planner como función pura
- **Decisión:** el planner recibe una instantánea de los estados de los steps y la definición, y devuelve acciones. El dispatcher aplica cada acción con una transición condicional.
- **Implicación:** el fan-in "exactamente una vez" lo garantiza la condición, no el planner. Es testeable sin I/O.

### DD-07 — Lambda async con alias dedicado
- **Decisión:** invocar el alias `cicd` de `<QUALITY_WORKER_FUNCTION>` en modo Event con su propia configuración async y Destinations → SQS. **No tocar la función sin calificar**, que usan los pipelines PoC de Jenkins (P-15).
- **Plan B** (si P-2 o P-18 resultan falsos): una Lambda wrapper delgada que invoque el worker de forma síncrona y publique el resultado normalizado en SQS.

### DD-08 — CodeBuild por app y ambiente; un proyecto para server y client
- **Decisión:** `prms-reporting-dev` construye ambos componentes con `COMPONENT` como override, en dos builds paralelos. Proyectos adicionales solo si cambia el entorno de build (ARM, VPC). Los secretos de build se declaran en el proyecto (solo DEV). Finalización por EventBridge.
- **Rechazado:** proyecto genérico compartido (rompe el aislamiento por ambiente); reutilizar `<LEGACY_CODEBUILD_PROJECT>` (key fija, solo frontend; FA §23).

### DD-09 — Lock distribuido con lease, fencing, supersede y espera acotada
- **Decisión (lock):**
  - Adquirir si el lock no existe, si `leaseExpiresAt < now` o si `owner` ya es esta ejecución (re-entrante, para que un mensaje duplicado no falle); `fencingToken` +1 solo cuando cambia el dueño.
  - Renovar cada 60 s mientras dura el SSH.
  - Liberar de forma condicional al dueño.
  - Escribir el estado del target condicionado a `fencingToken`.
  - Supersede: con el lock tomado, si `lastDeployedSequence > sequence` → `SKIPPED (SUPERSEDED)` y liberación.
  - Tras adquirir, la transición `WAITING_LOCK → DISPATCHING` es condicional. Si la pierde (mensaje duplicado), el handler **no** libera el lock que tiene el intento ganador.
- **Decisión (espera, corrige C-1):** SQS limita el retraso por mensaje a 900 s (P-22), así que la espera de 30 min es una **cadena acotada de reencolados**:
  - La primera vez que el lock está ocupado se guarda `lockWaitStartedAt` en el step.
  - Cada reintento publica `LOCK_RETRY_REQUESTED` según el calendario exacto de §7.6 (**nunca más de 900 s por mensaje**) e incrementa `lockWaitAttempts`.
  - En cada intento: `espera = now − lockWaitStartedAt`, medida sobre el estado persistido. Si es ≥ 1.800 s → `LOCK_TIMEOUT` (T5) y notificación.
  - Sin contención por código 50: como máximo 7 intentos de adquisición y 6 reencolados. Tope de seguridad: 10 intentos en total (§7.6).
  - Si se pierde el mensaje de reintento, el reconciler cierra el step con `LOCK_TIMEOUT` al vencer `deadlineAt` (§7.1).
  - Un código 50 del script (DD-22) vuelve a esta misma espera por T9 con el presupuesto ya consumido.
  - En cada intento se revalida la ventana del target (V2, §7.7).
- **Implicación:** el TTL de DynamoDB es solo limpieza. El lock distribuido sigue siendo **la** exclusión entre ejecuciones del Executor; el mutex de DD-22 es una segunda barrera, no un reemplazo.

### DD-10 — Script entregado por SFTP desde la imagen del Executor
- **Decisión:** el script viaja dentro de la imagen del Executor (misma versión que las definiciones, DD-19). Se sube a `/tmp/cicd-{id}/`, se registra su checksum, se ejecuta y se borra.
- **Rechazado:** preinstalar en `/opt/deploy` (puede divergir de Git; exige preparar cada host).

### DD-11 — Script de deploy genérico con migración previa al swap
- **Decisión:** orden mutex local (DD-22) → pull → configuración temporal → migración con contenedor efímero de la imagen nueva → swap → health → poda (conservando la previa). La imagen a restaurar es la que el contenedor está corriendo al iniciar el script (§6.4); el estado del target en DynamoDB es solo una pista.
- **Precondición explícita (corrige S-3): migraciones compatibles hacia atrás.** El diseño **no garantiza** esta propiedad para ninguna aplicación; la exige como precondición declarada por el equipo dueño:
  - Hasta el swap, la versión anterior corre sobre el esquema nuevo.
  - Tras un rollback por health check (código 40), la versión anterior vuelve a correr sobre el esquema migrado.
  - Ambos casos solo son seguros si las migraciones son compatibles hacia atrás.
  - El registro de targets exige `migrationCompatibility: backward-compatible` (con `attestedBy`) en toda unidad con migraciones habilitadas. Sin ese atributo, la definición que pide migrar es **inválida** y no se ejecuta.
  - La atestación es del equipo de la aplicación. La plataforma no la verifica (P-23). **Validarla es condición del Gate C**: ninguna prueba E2E con migraciones corre sin ella.
  - No se afirma que las migraciones de PRMS ya la cumplan. **Si no son compatibles hacia atrás, el rollback automático (código 40) no se puede dar por seguro.** En ese caso el target no habilita migraciones automáticas y el flujo E2E con migración queda bloqueado hasta acordar otra estrategia con el owner.
  - Un cambio de esquema destructivo no puede usar este flujo automático; queda fuera del alcance del PoC.
- **Dependencias:** P-5 (que la imagen pueda migrar en modo efímero), P-23 y OD-Q5 (cómo obtiene el target sus permisos AWS). Si P-5 es falso, la migración pasa a correr en el contenedor nuevo arrancado **con un nombre temporal**, antes de detener el viejo. El orden "migrar antes de detener" se mantiene.

### DD-12 — NotificationService con proveedores
- **Decisión:** interfaz `NotificationProvider`; Slack en el PoC (Web API, hilos). Marcas `EVT#` evitan duplicar notificaciones ante redelivery. Best-effort.

### DD-13 — Reconciliación por la misma cola
- **Decisión:** EventBridge Scheduler publica `RECONCILE_TICK` cada 5 min en la cola; lo atiende cualquier instancia.
- **Rechazado:** un cron interno (con 2 instancias se duplicaría y depende de que el proceso esté vivo).

### DD-14 — Heartbeat de visibilidad para handlers largos
- **Decisión:** visibilidad base de 120 s; mientras un handler vive (clone, SSH), se extiende cada 60 s. Si el proceso muere, el mensaje reaparece y el estado decide (no-op o reconciliación).

### DD-15 — TypeScript sobre Node.js LTS, sin framework web
- **Decisión:** TypeScript estricto y Node.js LTS. Composición manual de dependencias en `main`. Ajv para schemas, AWS SDK v3, `ssh2`, logger JSON y `vitest`.
- **Estado:** Q8 del proposal quedó *parcialmente resuelta* con esta recomendación. **El owner puede cambiarla en esta revisión** (NestJS standalone es la alternativa aceptable).

### DD-16 — Credenciales AWS del Executor detrás de la cadena estándar del SDK (OD-Q12 abierta)
- **Decisión:** el Executor no implementa ningún mecanismo propio: usa la cadena de credenciales por defecto del SDK. Así cualquier respuesta a OD-Q12 (rol del host, credenciales entregadas solo al contenedor, Roles Anywhere, `credential_process`) se resuelve en el **despliegue**, no en el código.
- **Lo que no se decide:** cuál de esos mecanismos. Bloquea el despliegue en DEV (Gate B), no el código.
- **Restricción que sí aplica (NFR-02):** el mecanismo elegido no debe exponer las credenciales a otros contenedores del host ni ser una llave estática de larga vida sin justificación explícita.

### DD-17 — Infraestructura como inventario hasta OD-Q7
- **Decisión:** los recursos se especifican en `infra/RESOURCES.md` (nombre, tipo, configuración, permisos) como contrato. La traducción a CDK o Terraform es una tarea bloqueada por OD-Q7.
- **Lo que no se decide:** la herramienta.

### DD-18 — Host del Executor parametrizado (OD-Q11 abierta)
- **Decisión:** el runtime sigue siendo **un contenedor Docker pequeño en el servidor de microservicios existente** (no Fargate). La imagen es agnóstica del host. `executor/deploy/` describe lo que el host debe proveer: Docker, egreso 443 y 22, un volumen `/work` (preferentemente local del contenedor; §7.4 lo hace seguro aunque se comparta), un `instanceId` único y estable por contenedor, límites de CPU y memoria, credenciales vía DD-16 y nada de Swarm.
- **Lo que no se decide:** el host concreto, ni si un host PROD es aceptable (riesgo R2 del proposal; se escala al owner en el Gate B).

### DD-19 — Definiciones detrás de `DefinitionSource`; empaquetadas en la imagen como simplificación del PoC
- **Decisión:** el núcleo (`definition-service`, planner, handlers) obtiene definiciones, registro y script **solo** a través del puerto `DefinitionSource`. Devuelve el contenido y su `definitionRef`, y nada del núcleo sabe de dónde vienen. En el PoC, la implementación `bundled-definition-source` lee `pipeline-definitions/`, `schemas/` y `deploy-scripts/` copiados a la imagen en el build. `definitionRef` = commit del repo de la plataforma, inyectado en el build.
- **Es una simplificación del PoC, no la arquitectura objetivo.** Cambiar una definición exige reconstruir y redesplegar la imagen. Eso cumple la letra de NFR-08 (sin cambios de código del Executor), pero no es un "solo YAML" operativo.
- **Migración futura (sin tocar el núcleo):** una implementación `versioned-external-definition-source` (repo Git fijado por commit o un bucket versionado) sustituye al adaptador en el wiring de `main`. El contrato del puerto ya incluye `definitionRef`, que FR-01 exige registrar por ejecución.
- **Rechazado para el PoC:** clonar las definiciones en cada ejecución (otra dependencia de red y de credenciales); sincronizar a S3 (otra pieza móvil).

### DD-20 — Identidad y dedupe con reclamo arrendado (corrige S-1)
- **Decisión:** el dedupe se protege con el mismo patrón de lease que el lock de deploy.
  1. **Reclamo:** `DEDUPE#{requestId}` se crea con `attribute_not_exists`, estado `CLAIMED`, un `claimToken` aleatorio propio y `claimLeaseExpiresAt = now + 2 min`.
  2. **Secuencia:** se incrementa el contador y el número obtenido se guarda en el dedupe con una escritura condicional (`claimToken` = el propio y `sequence` sin asignar). Si la escritura falla, otro proceso ya tomó el reclamo: se abandona sin crear nada (el número queda como hueco).
  3. **Ejecución:** el `executionId` se deriva de la `sequence` **guardada** y la ejecución se crea con `attribute_not_exists`. Repetir este paso es idempotente: mismo id, misma creación condicional.
  4. **Enlace:** el dedupe pasa a `BOUND` con el `executionId`, condicionado al `claimToken`.
- **Redelivery del mismo `requestId`:**

| Estado del dedupe al llegar | Acción |
|---|---|
| No existe | Paso 1 |
| `BOUND` | No-op, ack |
| `CLAIMED`, lease vigente, otro `claimToken` | No procesar; **no** hacer ack (el mensaje vuelve tras la visibilidad) |
| `CLAIMED`, lease vigente, **mismo** `claimToken` | Solo ocurre dentro del mismo procesamiento (el handler reintenta sus propias escrituras tras un error transitorio de DynamoDB; el `claimToken` es aleatorio por procesamiento, así que una re-entrega de SQS siempre trae otro). Se continúa desde el primer paso incompleto: sin `sequence` → paso 2; con `sequence` → paso 3 (idempotente); ejecución ya creada → paso 4 |
| `CLAIMED`, lease vencido | Tomar el reclamo con una escritura condicional sobre el `claimToken` anterior (nuevo token y lease). Si ya hay `sequence` guardada, **se reutiliza** y se continúa en el paso 3 (si la ejecución ya existe, la creación condicional es no-op y se pasa al 4); si no, paso 2 |
| `CLAIMED` y la toma condicional falla | Otro proceso la tomó primero: no procesar, no hacer ack |

- **Garantía:** dos procesos concurrentes nunca crean dos ejecuciones. Solo el dueño vigente del reclamo escribe la `sequence`, y la ejecución se crea de forma condicional a partir de la secuencia guardada (FR-03, FR-07). Las demás garantías no cambian: los eventos duplicados de una ejecución ya creada no producen deploys ni migraciones dobles (DD-03, DD-04, DD-09, DD-22 y §7.3), y las transiciones siguen siendo deterministas porque cada una es condicional sobre estado, `attempt` y `version`.
- **Riesgo aceptado:** una caída entre el incremento y su registro deja un hueco en la secuencia (FR-03 exige monotonía, no contigüidad).

### DD-21 — Ventanas de deploy por target (transitorio; corrige S-4)
- **Problema:** FR-18 exige que no haya deploys reales sobre un target compartido con Jenkins sin una ventana confirmada. Un lock no lo cubre (Jenkins no participa) y un procedimiento solo humano no tiene respaldo técnico.
- **Decisión:** una capacidad **genérica** de "ventana de deploy", gobernada por los atributos **obligatorios** `deployWindowPolicy` y `externalDeployers` de cada target (configuración segura por construcción, §7.7).
  - Si la política es `required`, el handler SSH revalida la ventana en V1–V4 (§7.7). Si no hay una ventana `OPEN` que cubra la duración del deploy → `DEPLOY_WINDOW_CLOSED`, sin ejecutar el script, con notificación.
  - Las ventanas las abre y cierra el operador con la CLI de `tools/`, mediante eventos `DEPLOY_WINDOW_*`.
  - Abrir exige `openedBy` y un `externalJobsDisabled[]` que cubra **todos** los `externalDeployers` del target. Esa es la "lista confirmada" de FR-18.
  - Duración máxima 8 h, con cierre automático por el reconciler mediante una consulta indexada (§7.7).
  - El historial queda en DynamoDB y se resume en `docs/jenkins-coexistence-log.md` (formato: target, abrió, cerró, motivo de cierre, jobs deshabilitados, ejecuciones dentro de la ventana, incidencias).
- **Frontera:** el núcleo no contiene lógica de Jenkins. "Jenkins" solo aparece como **dato** (identificadores opacos en `externalDeployers` y en la ventana) y en el runbook. Es transitorio: cuando se retire Jenkins del target, se vacía `externalDeployers` y se pasa a `not-required`, sin cambiar código. La capacidad sigue sirviendo como ventana de mantenimiento genérica.
- **Rechazado:** un flag global de "Jenkins activo" en el Executor (lógica Jenkins en el núcleo); integración con la API de Jenkins para deshabilitar jobs (acoplamiento y credenciales nuevas).

### DD-22 — Mutex local en el target como segunda barrera (corrige S-2)
- **Problema:** si el Executor pierde conectividad con DynamoDB (o se le vence el lease) mientras su sesión SSH sigue viva, otra ejecución puede adquirir el lock distribuido y lanzar un segundo deploy o migración físicamente concurrente. El `fencingToken` protege solo la escritura en DynamoDB.
- **Decisión (dos capas, ninguna reemplaza a la otra):**
  1. **Capa 1, lock distribuido en DynamoDB (DD-09):** sigue siendo la exclusión entre ejecuciones del Executor, el que ordena el trabajo, aplica supersede y da trazabilidad.
  2. **Capa 2, mutex local en el target:** antes de cualquier efecto, el script toma un lock de archivo no bloqueante por `lockKey` (§5.3). El sistema operativo lo libera al morir el proceso. Si está tomado, sale con **50 (`TARGET_BUSY`) sin hacer nada** e informa quién lo tiene. Así, aunque el lock distribuido haya vencido, la operación física (migración y swap) **nunca** corre dos veces a la vez en el host.
- **Flujo:**

```text
Executor ─► lock distribuido DynamoDB (capa 1: Executor vs Executor)
         ─► SSH ─► target: mutex local del kernel (capa 2: protege la operación física)
                          ─► pull ─► migración ─► swap ─► health
```

- **Comportamiento del Executor:**
  - Código 50 → transición T9 (§7.3): cierra la sesión, libera el semáforo SSH y el lock distribuido, revalida la ventana (V3) y vuelve a `WAITING_LOCK` con el presupuesto de espera acumulado (DD-09, §7.6).
  - Si una renovación del lease falla, el Executor **no aborta** el script remoto: interrumpir una migración es peor. Marca `lockLostDuringRun` en el step y, al terminar, registra el resultado real del script. Liberación de recursos en cada salida: §7.5.
  - Si la escritura del estado del target se rechaza por fencing, notifica la discrepancia. El siguiente deploy restaura desde la imagen que realmente corre (§6.4), no desde DynamoDB.
- **Límite conocido:** la capa 2 protege solo a los deploys que pasan por este script. Los jobs de Jenkins no lo usan; contra ellos actúa DD-21.

### DD-23 — Identificadores reales fuera de Git (política de publicación)
- **Problema:** el registro de targets y las definiciones son versionados, pero el host, el usuario, el host key, los nombres reales de contenedores y repos ECR, y los IDs de jobs externos no deben publicarse.
- **Decisión:**
  - Las entradas versionadas del registro contienen solo **identificadores semánticos y referencias**: `targetId` (p. ej. `prms-reporting-dev`), `connectionRef` y `hostKeyRef` (referencias a Secrets Manager), `lockKey` lógico, `deployWindowPolicy`, `externalDeployersRef`, `migrationCompatibility`, nombres lógicos de contenedores y `imageRepositoryRef`.
  - Los valores concretos (host, puerto, usuario, credencial, host key, nombres reales de contenedores y puertos, repos ECR, IDs de jobs) viven en entradas de Secrets Manager o de configuración de despliegue, y el `SecretProvider` los resuelve en el momento de uso.
  - `definition-service` valida la **estructura** en CI y la **resolución** al arrancar: el Executor no arranca si una referencia no resuelve. Así sigue siendo seguro por construcción (§7.7).
  - `externalDeployers` se valida contra la lista resuelta de `externalDeployersRef`.
- **No cambia la arquitectura:** el núcleo sigue trabajando con referencias opacas; solo cambia **dónde** viven los valores.
- **Rechazado:** un overlay YAML no versionado en el host (otra pieza de configuración sin auditoría) y publicar los valores en el repo (contradice la política del owner).

### Challenge de reversiones (Step 2.3)

Revisión hecha inline, sin subagente. Pregunta: "¿qué rompe quitar esto?"

| Comportamiento entregado que se revierte | Qué rompe | Respuesta en el diseño |
|---|---|---|
| Secretos dentro de los ZIPs de quality (hoy) | Tests que leen `.env` o compilan con `environment.ts` podrían fallar | OD-Q13 abierta. El handler no los incluye en ningún caso. Si se confirman, el worker los lee por referencia (requiere su propio permiso de solo lectura DEV). La tarea del worker lo verifica primero |
| `docker rmi N-1` en el target | Crecimiento de disco en `<PRMS_REPORTING_DEV_TARGET>` | El script poda imágenes más viejas que la previa (DD-11) |
| `aws configure set` en el target | Jobs que dependen de llaves sobrantes | **No se borran** llaves existentes (NFR-10). El script solo deja de depender de ellas (FR-13, OD-Q5) |
| Registro en `<JENKINS_EXECUTIONS_TABLE>` | Consumidores desconocidos dejarían de ver las ejecuciones del PoC | OD-Q14 abierta. Riesgo aceptado para el PoC: las ejecuciones de Jenkins siguen escribiendo |
| Invocación síncrona del worker | Ninguno de los pipelines de Jenkins (se usa un alias propio) | DD-07 |
| Kill → migrar → run | Nada que dependa del corte; mejora la disponibilidad | DD-11 |

---

## 11. Premise Ledger

**Conteo:** 4 verified (P-20, P-21, P-25, P-26 — esta última en T-00) · 23 `UNVERIFIED` (High: 10 — P-2, P-5, P-6, P-10 (condicional), P-11, P-13, P-14, P-19, P-23, P-24 · Low: 13 — P-1, P-3, P-4, P-7, P-8, P-8b, P-9, P-12, P-15, P-16, P-17, P-18, P-22)
**IDs de tarea `T-nn`:** alineados con `tasks.md` (Phase 3).
**Blast-radius triggers:** `shared-state` dispara: la unidad de deploy (P-13), las credenciales del target (P-14) y la BD DEV (P-24) las comparten jobs de Jenkins. `consumer` dispara (configuración async del worker y repos ECR compartidos). `live-path` no aplica: el diseño no cambia código existente; todo el código es nuevo y no hay acción de usuario sobre código previo cuyo camino haya que probar.

**Nota de citación:** el workspace no es un repositorio git, así que *Verified at* no puede llevar SHA. El FA es un documento: por la regla (d) es fuente **secundaria**. Las filas que se apoyan en él quedan `UNVERIFIED` y lo mencionan como pista para quien las verifique.

| # | Claim | Class | Citation (as run) | Verified at | If false | Settled by |
|---|---|---|---|---|---|---|
| P-1 | `<QUALITY_WORKER_FUNCTION>` devuelve `status, failedCommand, exitCode, error, logS3Uri, logUrl` | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA L1023) | — | Cambia el mapeo de §6.2 (Low) | Tarea del handler Lambda, primer paso: leer el código o configuración del worker. Owner: T-27 |
| P-2 | El worker acepta los campos de entrada que el Executor enviará (`sourceRef`, `task`…) y no requiere secretos en el ZIP | data-env | `UNVERIFIED — confirm at source before relying on it` | — | Plan B de DD-07 (wrapper) u OD-Q13 (High) | T-27 |
| P-3 | Contenedores `<SERVER_CONTAINER>` <SERVER_PORT_MAPPING> y `<CLIENT_CONTAINER>` <CLIENT_PORT_MAPPING> en `<PRMS_REPORTING_DEV_TARGET>` | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA L1107, L595) | — | Cambian los valores del registro (Low) | Lectura del Jenkinsfile de referencia, en la tarea del registro. Owner: T-32 |
| P-4 | El server de PRMS Reporting expone `migration:check:ci` y `migration:run` | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA L1106) | — | Cambian los argumentos del registro (Low) | T-32 |
| P-5 | La imagen del server puede ejecutar la migración como contenedor efímero (incluye CLI y archivos de migración) | existence | `UNVERIFIED — confirm at source before relying on it` | — | DD-11 usa la variante de "contenedor con nombre temporal" (High) | Inspección del Dockerfile de `<PRMS_REPORTING_REPO>` en la tarea del script. Owner: T-33 |
| P-6 | `<PRMS_REPORTING_DEV_TARGET>` tiene ruta de red a la BD DEV (las migraciones corren hoy desde el target) | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA L1106) | — | El modelo "target migra" no aplica: habría que usar VPC Lambda (High) | Primera ejecución del script en ventana con `--migration-check`. Owner: T-33 |
| P-7 | Una sola cuenta AWS `<AWS_ACCOUNT_ID>` para todos los ambientes | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA L82) | — | El aislamiento podría hacerse por cuenta; cambian las políticas (Low) | Owner (CI/CD Platform Team) en el Gate B |
| P-8 | Los repos ECR `<ECR_REPOSITORY>` (server y client) existen | existence | `UNVERIFIED — confirm at source before relying on it` (pista: FA L595) | — | Crear repos nuevos y ajustar el inventario (Low) | T-28 |
| P-8b | Esos repos admiten tags no numéricos (sin inmutabilidad ni reglas que lo impidan) | data-env | `UNVERIFIED — confirm at source before relying on it` (sin pista en el FA) | — | Cambia el formato del tag de imagen (FR-10) (Low) | T-28 |
| P-9 | El build del frontend necesita `environment*.ts` con valores de secretos en tiempo de build | data-env | `UNVERIFIED — confirm at source before relying on it` (pista: FA §7.1) | — | CodeBuild no necesita secretos; se simplifica el proyecto (Low) | T-28 |
| P-10 | `<PRMS_REPORTING_REPO>` requiere credencial para el clone y su tamaño cabe en `/work` con N=2 | data-env | `UNVERIFIED — confirm at source before relying on it` (OD-Q15) | — | Cambian el tipo de credencial y el dimensionamiento. **High condicional**: solo si el clon no cabe con N=2; si cabe, Low | OD-Q15. Owner: CI/CD Platform Team; medición en T-29 |
| P-11 | El host del Executor alcanza `<PRMS_REPORTING_DEV_TARGET>:22` y AWS, GitHub y Slack por 443 | data-env | `UNVERIFIED — confirm at source before relying on it` (OD-Q11) | — | DD-18: otro host o la alternativa A' (High) | Spike de red. Owner: T-23 |
| P-12 | Los jobs de Jenkins no participan de ningún mecanismo de lock que el Executor pueda usar | other | `UNVERIFIED — confirm at source before relying on it` (pista: FA §13: `lock()` = 0) | — | Podría integrarse un lock compartido en lugar de ventanas (Low) | Inventario de configuración (jenkins-config-inventory). Owner: CI/CD Platform Team |
| P-13 | **shared-state:** la unidad `<SERVER_CONTAINER>` y `<CLIENT_CONTAINER>` la despliegan también: siete `<JENKINS_JOB_ID>` (identificadores en el inventario local de jobs) (mecanismo de cada uno: `docker kill/rm/run` del mismo nombre por SSH) | shared-state | `UNVERIFIED — confirm at source before relying on it` (pista: FA L595 lista 7 archivos y "up to 8") | — | La lista de jobs a deshabilitar en FR-18 está incompleta: riesgo de colisión (High) | Nombres de los jobs vía inventario (Q1), cargados en `externalDeployers` del target (§7.7), que la apertura de ventana exige cubrir por completo. Owner: admin de Jenkins en el Gate C |
| P-14 | **shared-state:** otros jobs que despliegan en `<PRMS_REPORTING_DEV_TARGET>` dependen de las llaves AWS sobrantes en el host (p. ej. `<JENKINS_JOB_ID>`, `<JENKINS_JOB_ID>`) | shared-state | `UNVERIFIED — confirm at source before relying on it` (pista: FA §9.3.5, que nombra los jobs; L1123 solo da la recomendación) | — | Si el script o un cambio de perfil las invalidara, esos jobs se romperían; DD-11 y NFR-10 ya evitan tocarlas (High) | OD-Q5. Owner: infra |
| P-15 | **consumer:** la función `<QUALITY_WORKER_FUNCTION>` la invocan pipelines de Jenkins (cinco `<JENKINS_JOB_ID>`, identificadores en el inventario local) **sin calificar por el alias `cicd`**. El modo de invocación (síncrono o asíncrono) **no está establecido**: el FA solo nombra `aws lambda invoke`, sin indicar `--invocation-type` | consumer | `UNVERIFIED — confirm at source before relying on it` (pista: FA L259 "PoC: 6"; L201, L204, L224–226 nombran los pipelines, no el modo) | — | DD-07 configura el comportamiento async solo en el alias `cicd`, así que no afecta a invocaciones sin calificar en ningún modo. Solo habría colisión si algún pipeline invocara el alias `cicd`, que aún no existe (Low) | T-27 |
| P-16 | **consumer:** los repos ECR `<ECR_REPOSITORY>` los leen y limpian jobs de Jenkins con tags enteros (`rmi N-1` en el target) | consumer | `UNVERIFIED — confirm at source before relying on it` (pista: FA L595, §9.1) | — | Los tags `prms-reporting-dev-N` no coinciden con `N-1`; si hubiera limpieza por patrón amplio en el repo (lifecycle de ECR), podría borrar imágenes previas del PoC (Low) | T-28: revisar la política de lifecycle del repo ECR |
| P-17 | Lambda Destinations admite una cola SQS Standard como destino de la invocación async de un alias | other | `UNVERIFIED — confirm at source before relying on it` | — | Plan B de DD-07 (Low) | T-27 |
| P-18 | `StartBuild` admite `idempotencyToken` y override de la fuente S3; el evento de estado incluye `build-id` | other | `UNVERIFIED — confirm at source before relying on it` | — | DD-04 usaría dedupe propio por `dispatchToken` antes de llamar (Low) | T-28 |
| P-19 | El servidor de microservicios del owner no es el host PROD donde corre `docker swarm leave --force` | other | `UNVERIFIED — confirm at source before relying on it` (OD-Q11; pista: FA L633, L599) | — | Riesgo R2 del proposal: se escala al owner antes del Gate B (High) | OD-Q11. Owner: CI/CD Platform Team |
| P-20 | El workspace no contiene código, plantillas `general-setup` ni baseline | existence | `find . -type f` → 2 `.md` raíz + `docs/specs/changes/cicd-executor-poc/{proposal,requirements}.md` (al redactar la v1; después solo se añadieron `design.md` y `judgment.md` en esa carpeta); `ls -R docs` → solo `specs/changes/cicd-executor-poc` | n/a (sin git; 2026-10-05) | Habría que extender código existente (High) | — |
| P-21 | Fuera de la carpeta de esta spec no queda ninguna referencia al nombre anterior del método. Dentro de ella solo aparece como registro del renombrado: esta fila y `judgment.md` | other | `grep -rnil "akilia" .` → 2 archivos: `docs/specs/changes/cicd-executor-poc/design.md` y `…/judgment.md`. `grep -rnil "akilia" . \| grep -v "^./docs/specs/changes/cicd-executor-poc/"` → 0 líneas (exit 1). Ejecutado tras la revisión v2 | n/a (sin git; 2026-10-05, revisión v2) | Inconsistencia de nombres en documentos fuente (Low) | — |
| P-22 | SQS limita el retraso por mensaje (`DelaySeconds`) a 900 s | other | `UNVERIFIED — confirm at source before relying on it` (límite documentado de SQS; no se ejecutó contra AWS) | — | Si el límite fuera mayor, DD-09 sigue siendo correcto: solo podría hacer menos reencolados (Low) | T-26 (prueba de integración del reintento de lock) |
| P-23 | Las migraciones de PRMS Reporting son compatibles hacia atrás: la versión anterior funciona sobre el esquema migrado | data-env | `UNVERIFIED — confirm at source before relying on it` (el diseño **no** lo garantiza: lo exige como precondición atestada, DD-11) | — | El rollback por health check (código 40) y la ventana entre migrar y hacer el swap dejan una versión rota sobre el esquema nuevo. El target no puede habilitar migraciones automáticas (High) | Atestación `migrationCompatibility` del equipo PRMS Reporting en el registro. Owner: equipo PRMS (Gate C) |
| P-24 | **shared-state:** la BD DEV de PRMS Reporting la comparten las variantes de Jenkins de otras ramas (`dev`, `performance-refactor`, `dev-migration-review`) que despliegan la misma unidad (P-13). Cada una ejecuta sus propias migraciones condicionales contra esa BD, por el mismo mecanismo de SSH al target | shared-state | `UNVERIFIED — confirm at source before relying on it` (pista: FA L595 nombra las ramas distintas; que la BD sea la misma es inferencia del proposal R9) | — | Migraciones de otras ramas pueden dejar el esquema adelantado o divergente respecto del código que despliega el PoC. Afecta a P-23, a la validez de las pruebas E2E y al rollback (High) | Mitigaciones: ventana DD-21 (sin jobs activos durante la prueba), snapshot de la BD DEV y registro del estado de migraciones antes y después (Gate C). Confirmación de la BD compartida: equipo PRMS |

| P-25 | El repositorio canónico `onecgiar-cicd-platform` existe, es accesible para lectura y tiene una rama `main` | existence | `git ls-remote https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` → `41f4c3ee0437a9c10beb699d6dbb07c11c1935f8 HEAD` y `… refs/heads/main` (exit 0) | `41f4c3e` (remoto; 2026-10-05) | Habría que crear el repo o pedir acceso antes de la primera tarea (High) | — |
| P-26 | El commit inicial del remoto no tiene contenido que choque con la estructura de §4.2 | data-env | `git ls-tree -r --name-only origin/main` → `LICENSE` (único archivo; sin `.gitignore` remoto). Verificado en T-00 | `41f4c3e` (2026-10-05) | La primera tarea ajusta la estructura o integra el contenido existente (Low) | Primera tarea de ejecución (vincular el workspace con el remoto). Owner: T-00 |

**Traspaso a `tasks.md`:** las filas `consumer` P-15 y P-16 van al campo `Consumers` de T-27 y T-28. Cada fila `UNVERIFIED` con dueño de tarea se resuelve como **primer paso** de esa tarea. Las que dependen de una OD (P-10, P-11, P-14, P-19) siguen abiertas hasta que el owner responda. P-23 y P-24 son condiciones del Gate C, a cargo del equipo PRMS.

---

## 12. Riesgos, observabilidad y rollback (Full depth)

| Tema | Diseño |
|---|---|
| Observabilidad | Logger JSON; métricas EMF `ExecutionsStarted/Succeeded/Failed`, `StepDurationMs` por tipo, `LockWaitMs`, `DispatchLatencyMs` (NFR-05); alarmas DLQ > 0, `ApproximateAgeOfOldestMessage` > 10 min, sin `ExecutorHeartbeat` en 5 min |
| Liveness | El Executor emite una métrica de heartbeat cada minuto y escribe un archivo para el healthcheck del contenedor. No expone puertos |
| Seguridad | La redacción del logger cubre tokens, `password`, `secret`, llaves PEM y URLs presignadas. La imagen corre como no root, sin el socket de Docker |
| BD DEV compartida (P-24, R9 del proposal) | El lock y el mutex no la cubren. Mitigación: deploys reales solo dentro de una ventana DD-21 con los jobs de las demás variantes deshabilitados; snapshot de la BD antes de la primera prueba; registro del estado de migraciones (`migration:check:ci`) antes y después de cada prueba en el log de coexistencia |
| Migraciones no compatibles hacia atrás (P-23) | Las migraciones automáticas no se habilitan sin la atestación en el registro (DD-11) |
| Lease perdido durante el SSH | Segunda barrera DD-22 (mutex local); `lockLostDuringRun` y notificación de discrepancia |
| Rollback del PoC | Jenkins intacto. Se rehabilitan los jobs. Se destruyen los recursos `cicd-poc` (inventario). En el target se restaura la imagen previa con el mismo script (`--image` = previa) o se vuelve a desplegar con Jenkins |
| Rollback de una ejecución | Health fallido → restauración automática (código 40), **solo segura si se cumple P-23**. Migración fallida → la versión anterior nunca se detuvo |

### 12.1 Runbook: mutex local posiblemente atascado (R2-I4)

**Principio:** el mutex es el **bloqueo del kernel** sobre el archivo, no la existencia del archivo. Si el proceso que lo tenía murió, el sistema operativo ya lo liberó. Un mutex "atascado" solo puede ser un proceso **vivo** que lo retiene. **Nunca se borra el archivo de lock para "liberarlo"**: eso no libera nada si el titular vive, y si no vive, no hace falta.

| Paso | Evidencia que el operador comprueba | Qué indica |
|---|---|---|
| 1 | Notificación: `TARGET_BUSY` repetido, `LOCK_TIMEOUT` con `contentionCount > 0` o `UNKNOWN_TARGET_STATE` | Hay que mirar el target |
| 2 | Contenido del archivo de lock: `executionId`, `fencingToken`, PID e inicio | Quién dice tenerlo |
| 3 | ¿El bloqueo está tomado? (herramienta del SO que lista locks de archivo o intento no bloqueante de solo prueba) | No tomado → **no hay mutex**: el archivo es residual e inocuo, no hay nada que liberar |
| 4 | ¿El PID existe y es el script de deploy? Árbol de procesos: `docker pull`, contenedor de migración, `docker run` | Proceso vivo y trabajando → **deploy activo**, aunque la coordinación con DynamoDB haya fallado |
| 5 | Estado en DynamoDB de ese `executionId` y step (`RUNNING`, `lockLostDuringRun`, `UNKNOWN_TARGET_STATE`) y logs del Executor y del script en CloudWatch | Cuándo habló por última vez; si la sesión se cortó |
| 6 | Progreso real: logs del contenedor de migración, `migration:check:ci` en modo solo lectura, estado de los contenedores de la unidad, tiempo transcurrido frente al timeout del step | Avanza → **esperar**. Sin avance durante más de 2× el timeout del step → candidato a estancado |

**Decisión:**

| Caso | Acción |
|---|---|
| Deploy activo (avanza) | No tocar nada. Esperar a que termine; el SO libera el mutex. Registrar en el log de coexistencia |
| Estancado y **sin migración en curso** (el proceso está en pull, health o espera) | Terminar el proceso del script de forma ordenada (señal de terminación, no un kill forzado de entrada). El SO libera el mutex. Luego verificar qué imagen corre cada contenedor y restaurar la previa con el script si hace falta |
| Estancado **con migración en curso** | **Escalar** al equipo de la aplicación y a la BD antes de actuar: interrumpir una migración puede dejar el esquema a medias |
| Después de cualquier intervención | Registrar quién, cuándo y la evidencia en `docs/jenkins-coexistence-log.md`. Volver a disparar el pipeline (nueva ejecución); nunca reintentar la anterior a mano |

---

## 13. Budget (Step 2.4)

| Métrica | Estimación |
|---|---|
| Tareas esperadas | **37** (re-estimado en Phase 3: la descomposición en tareas revisables por separado y la separación por gates dan 23 de Gate A, 9 de Gate B y 5 de Gate C; T-00 a T-36. Antes: 25. Las de Gate C son mayormente operativas y de validación, con poco código). Gate D se registra, pero queda fuera del PoC |
| LOC esperadas | **~8.700** (Executor ~3.900 incluido el lease de instancia y la máquina de estados explícita, tests ~3.500, schemas y definiciones ~450, script ~400, CLI de operador ~150, infraestructura ~600 según OD-Q7). Incluye ingress |
| Rondas de review esperadas | **~50** (re-estimado: 1,5 por tarea de código y 1 por tarea operativa o documental) |

Coincide con la profundidad **Full**. No se recomienda bajar de nivel. Se recomienda **implementar en varios PRs**, cuya estrategia se define en `tasks.md`. Es un tripwire: si `/akili-execute` supera estas cifras, se detiene y escala.

---

## 14. Gates y bloqueos

| Gate | Significado | Decisiones abiertas y premisas que lo bloquean |
|---|---|---|
| **A** | Diseño listo para `tasks.md` e implementación del núcleo (dominio, schemas, validación, adaptadores con DynamoDB Local y tests) | **Ninguna OD.** Ninguna premisa `UNVERIFIED` bloquea: cada una tiene una tarea dueña o un gate posterior |
| **B** | Infraestructura y despliegue del Executor en DEV | OD-Q11 (host; P-19), OD-Q12 (credenciales del Executor), OD-Q7 (IaC), P-11 (spike de red), P-7. Para incrementos concretos: OD-Q15/P-10 (fuente), OD-Q13/P-2 (Lambda) |
| **C** | Deploy end-to-end en `<PRMS_REPORTING_DEV_TARGET>` | OD-Q5 (credenciales del target; P-14), P-13 (jobs en `externalDeployers` y ventana aprobada), P-23 (atestación de migraciones), P-24 (BD compartida: snapshot y registro), P-6 (red target → BD), P-5 (migración efímera) |
| **D** | Retirar Jenkins (cualquier job) | `jenkins-config-inventory` completo, B1 probado, H1, H2, H3, steps SDK, Jira Builds API, OD-Q14 (consumidores de `<JENKINS_EXECUTIONS_TABLE>`) y cada ola validada |

# Requirements — CI/CD Executor PoC (PRMS Reporting DEV)

> **En una línea:** un Executor liviano debe ejecutar PRMS Reporting DEV de punta a punta sin Jenkins: coordinar Lambda, CodeBuild y SSH a partir de definiciones declarativas, con idempotencia ante entrega at-least-once, locks por target y estado persistente. **No puede compilar, conectarse a bases de datos, leer secretos de aplicación ni contener lógica por proyecto.**

---

## 1. Document Control

| Campo | Valor |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Fase | Phase 1: Requirements |
| Depth | **Full** (infraestructura nueva, concurrencia, seguridad, despliegue y migraciones) |
| Type | Change |
| Approval Mode | `gated` (heredado del proposal) |
| Fuente de intención | `proposal.md` v2, **aprobado** por el owner el 2026-10-05 |
| Evidencia | **FA** = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`; **ctx** = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` |
| Plantillas | No existe `docs/specs/general-setup/` ni baseline (`CLAUDE.md`, PRD o TRD). Comprobado con `ls -R docs` el 2026-10-05: solo `docs/specs/changes/cicd-executor-poc/proposal.md`. Se usa la estructura mínima del comando `/akili-specify` |
| Patrón de IDs | No hay uno previo. Se adopta `FR-nn` (funcional), `NFR-nn` (no funcional) y `OD-xx` (decisión abierta) |
| Fecha | 2026-10-05 |
| Owner | CI/CD Platform Team |
| Revisión | Judgment Day **completo** (3 rondas; resultado **APPROVED**; `judgment.md`). Ajustes aprobados por el owner. **Ronda 1:** código 50 y precondición de migraciones (FR-13), respaldo técnico de FR-18, F18–F19 (FR-16), alcance de FR-02, aclaración de NFR-08. **Ronda 2:** única vuelta atrás permitida (FR-05), política de ventana obligatoria (FR-02), revalidación de la ventana (FR-18). **Posterior:** resultado canónico `LOCK_TIMEOUT` al agotar la espera de lock (FR-11) y saneamiento de identificadores internos para publicar en Git |

**Regla de esta especificación:** Q5, Q7 y Q11–Q15 son **decisiones abiertas**. Se identifican como `OD-Qn` (§9). Ningún requisito asume su respuesta. Donde una de ellas condiciona un requisito, se declara la dependencia y el requisito queda escrito sin depender de esa elección.

---

## 2. Executive Summary

| Pregunta | Respuesta |
|---|---|
| ¿Qué se construye? | Un Executor en contenedor que consume eventos de SQS y avanza ejecuciones de pipeline a partir de definiciones YAML versionadas. Despacha trabajo a Lambda (quality), CodeBuild (imágenes) y SSH (deploy en el target) |
| ¿Para qué? | Demostrar que las responsabilidades de un pipeline representativo de Jenkins se reemplazan **sin otro servidor CI y sin otro Jenkins** |
| ¿Con qué pipeline? | PRMS Reporting DEV (patrón P1, que comparten ~57 pipelines; FA §4, §23) |
| ¿Qué lo hace correcto? | Idempotencia con entrega at-least-once, locks por unidad de deploy, estado persistente, migración antes de detener la versión vieja y conservación de la imagen previa |
| ¿Qué lo hace "no Jenkins"? | Vocabulario cerrado de steps, sin expresiones ni lógica de proyecto, sin toolchains, sin acceso a BD ni a secretos de aplicación (NFR-01) |
| ¿Qué queda fuera? | Builds sin Docker (B1), deploys por SDK (S3, CloudFront, Lambda, CloudFormation), Jira, el retiro de Jenkins y la remediación de la deuda de seguridad histórica |

---

## 3. Glossary

| Término | Definición |
|---|---|
| Executor | Servicio coordinador. Recibe, resuelve la definición, coordina, despacha, registra y notifica |
| Pipeline Definition | Documento YAML versionado que describe repositorio, steps, dependencias y notificaciones de un pipeline |
| Target Registry | Documento versionado que describe los destinos de deploy: host, usuario, referencias a credencial y host key, contenedores, puertos y clave de lock |
| Ejecución | Una corrida de un pipeline, identificada por `executionId` |
| `executionId` | `<pipelineId>-<sequence>`, con secuencia monotónica por pipeline (p. ej. `prms-reporting-dev-184`) |
| Step | Unidad declarada de trabajo de un tipo del vocabulario (`lambda`, `codebuild`, `ssh`, `notify`). `source` es implícito |
| Capacidad | Implementación genérica de un tipo de step en el Executor |
| Unidad de deploy | Conjunto de contenedores de un host que se despliegan juntos y comparten un lock |
| Lock | Exclusión mutua con lease sobre una unidad de deploy |
| Supersede | Regla por la que un deploy de una secuencia más vieja se omite si el target ya tiene una más nueva |
| Evento | Mensaje en SQS con el sobre definido (FR-04) |
| Reconciler | Proceso periódico que cierra ejecuciones atascadas y recupera eventos perdidos |
| Ventana de prueba | Periodo en que los jobs de Jenkins que tocan el target del PoC están deshabilitados |
| Deploy script | Script versionado que el target ejecuta: pull, migración, swap, health check y limpieza |
| OD | Decisión abierta (Open Decision), heredada de las preguntas del proposal |

---

## 4. System Context & Scope

### 4.1 Contexto actual (citado)

| Afirmación | Evidencia |
|---|---|
| PRMS V2 Reporting DEV clona `<PRMS_REPORTING_REPO>`, escribe secretos en el árbol, crea ZIPs para quality en Lambda (`<QUALITY_WORKER_FUNCTION>`, ×2 en paralelo), construye con Docker y despliega por SSH con password en `<PRMS_REPORTING_DEV_TARGET>`, con migraciones condicionales | FA §23 (referencia `<JENKINS_JOB_ID>`). El Jenkinsfile no está en este workspace: `UNVERIFIED — confirm at source before relying on it` para detalles no citados por línea |
| Contenedores `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) y `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>). Hasta 8 jobs despliegan sobre ellos desde ramas distintas | FA §10.3, §23 |
| Los ZIPs de quality incluyen secretos. La key S3 del CodeBuild es fija (`codebuild/frontend.zip`) | FA §1.5, §23 (puntos 1 y 2) |
| Ante una migración fallida el contenedor viejo ya fue eliminado. `rmi N-1` elimina la imagen previa. No hay rollback | FA §11.4, §16 |
| El target recibe llaves AWS por `aws configure set` y otros jobs dependen de ellas | FA §9.3.5, §12.2.1, §23 (punto 4) |
| Hay una sola cuenta AWS (`<AWS_ACCOUNT_ID>`, `<AWS_REGION>`) | FA §2 |
| Contrato de salida del worker: `status, failedCommand, exitCode, error, logS3Uri, logUrl` | FA §21.7. El formato de entrada es `UNVERIFIED — confirm at source before relying on it` |
| Los triggers, nombres de job y la concurrencia de Jenkins no están en el repo | FA §19 B2 |

### 4.2 Alcance

| Dentro | Fuera |
|---|---|
| Definiciones y Target Registry con validación | Builds sin Docker (B1). Steps `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check` (solo reservados en el schema) |
| Trigger manual y, como SHOULD, webhook de GitHub | Trigger `schedule`, parámetros tipados, re-run, `when` (reservados) |
| Capacidades `source`, `lambda`, `codebuild`, `ssh`, `notify` (Slack) | Jira Builds API, Teams, email |
| Estado, idempotencia, locks, supersede, reconciler | Retiro de jobs de Jenkins; cambios en Jenkinsfiles |
| Contrato del deploy script en el target, incluida la migración | Migración SSH → SSM |
| Procedimiento de coexistencia con Jenkins | Remediación de seguridad histórica (track paralelo) |
| Recursos AWS DEV del PoC | Recursos STAGING o PROD |

### 4.3 Diagrama de contexto

```text
Operador / GitHub ──> SQS ──> Executor ──> Lambda (quality) ──┐
                       ▲         │  ├────> CodeBuild (imagen) ─┤ eventos de finalización
                       └─────────┼──┴──────────────────────────┘
                                 ├──> SSH ──> target ──> deploy script ──> (migración → BD DEV)
                                 ├──> DynamoDB (estado, locks)   S3 (artefactos)
                                 └──> Slack · CloudWatch · Secrets Manager
```

---

## 5. Stakeholders / Personas

| Persona | Necesita | Requisitos clave |
|---|---|---|
| Operador de plataforma (DevOps) | Disparar, observar y diagnosticar ejecuciones sin Jenkins | FR-03, FR-15, FR-17, NFR-06 |
| Autor de pipelines | Describir un pipeline solo con YAML | FR-01, FR-02, NFR-08 |
| Equipo PRMS Reporting | Que DEV quede desplegado correctamente y se entere de fallos | FR-12, FR-13, FR-14 |
| Administrador de Jenkins | Pausar y reanudar de forma controlada los jobs que tocan el target | FR-18 |
| Responsable de seguridad | Sin secretos en artefactos ni llaves de larga vida; separación de ambientes | NFR-02, NFR-09 |
| Arquitectura | Que el Executor no derive hacia un motor de workflows | NFR-01, NFR-08 |

---

## 6. Functional Requirements

### FR-01 — Pipeline Definitions declarativas

El sistema SHALL determinar el comportamiento de cada pipeline exclusivamente a partir de una Pipeline Definition versionada y validada contra un schema. El vocabulario de tipos de step es cerrado: PoC `lambda`, `codebuild`, `ssh`, `notify`; reservados y rechazados en tiempo de ejecución en el PoC: `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check`.

#### Scenario: definición válida
- GIVEN una definición que cumple el schema
- WHEN se crea una ejecución de ese pipeline
- THEN la ejecución registra el identificador de versión de la definición usada
- AND todos los steps de la ejecución provienen de esa versión, aunque la definición cambie durante la ejecución

#### Scenario: definición inválida
- GIVEN una definición con un tipo de step desconocido, una dependencia inexistente, un ciclo en `needs` o una interpolación fuera de la lista blanca
- WHEN se valida
- THEN se rechaza con un error que nombra el campo y la regla incumplida
- BUT it must NOT crear la ejecución ni despachar ningún step
- AND IT MUST rechazar cualquier construcción de expresión, bucle o script embebido

#### Scenario: proyecto CodeBuild por ambiente
- GIVEN un step `codebuild`
- WHEN se valida la definición
- THEN el proyecto CodeBuild está declarado de forma explícita en ese step
- BUT it must NOT existir un proyecto implícito ni compartido por defecto entre ambientes

#### Scenario: tipo reservado
- GIVEN una definición con un step `s3-sync`
- WHEN se valida en el PoC
- THEN se rechaza como "tipo reservado, no habilitado"

#### Scenario: ambiente fuera del alcance
- GIVEN una definición con `environment` distinto de `dev`
- WHEN el Executor DEV la carga
- THEN la rechaza

### FR-02 — Target Registry

El sistema SHALL resolver todo destino de deploy a través de un Target Registry versionado que declara host, usuario, referencia a la credencial, referencia al host key, contenedores, puertos y clave de lock. Cuando aplique, declara también si el target requiere ventana de deploy (FR-18) y la atestación de compatibilidad de migraciones (FR-13).

#### Scenario: conflicto de puertos o nombres
- GIVEN dos entradas del registro sobre el mismo host que publican el mismo puerto o el mismo nombre de contenedor
- WHEN se valida el registro
- THEN se rechaza nombrando ambas entradas

#### Scenario: host key ausente
- GIVEN una entrada sin referencia a host key
- WHEN se valida
- THEN se rechaza
- AND IT MUST considerarse inválida aunque la credencial exista

#### Scenario: política de ventana obligatoria (añadido tras Judgment Day ronda 2, R2-W2)
- GIVEN una entrada del registro que omite la declaración de desplegadores externos o la política de ventana, o que declara desplegadores externos con una política que no exige ventana
- WHEN se valida (en CI o al arrancar el Executor)
- THEN se rechaza antes de cualquier deploy
- BUT it must NOT existir un valor por defecto que deje desprotegido un target compartido

#### Scenario: secretos en el registro
- GIVEN el registro
- THEN contiene solo **referencias** a secretos
- BUT it must NOT contener valores de credenciales

### FR-03 — Solicitud de ejecución e identidad

El sistema SHALL crear una ejecución por cada solicitud válida, asignándole un `executionId` `<pipelineId>-<sequence>` con secuencia monotónica por pipeline, y SHALL deduplicar solicitudes repetidas.

#### Scenario: disparo manual
- GIVEN un operador con permiso para enviar mensajes a la cola
- WHEN envía `PIPELINE_REQUESTED` con `pipelineId`, `requestId` y, opcionalmente, un commit
- THEN se crea una ejecución con un `executionId` nuevo, en estado `QUEUED`
- AND se resuelve y registra el commit exacto que se usará

#### Scenario: solicitud duplicada
- GIVEN una solicitud con el mismo `requestId` (o el mismo id de entrega del webhook) ya procesada
- WHEN llega de nuevo
- THEN no se crea otra ejecución
- AND IT MUST NOT consumir un número de secuencia nuevo

#### Scenario: pipeline desconocido
- GIVEN un `pipelineId` sin definición
- WHEN llega la solicitud
- THEN se registra el rechazo en los logs y el mensaje se confirma
- BUT it must NOT crear la ejecución

### FR-04 — Recepción de eventos

El sistema SHALL consumir trabajo y resultados desde una cola SQS Standard con DLQ, asumiendo entrega **at-least-once** y sin orden garantizado. Los mensajes llevan identificadores y referencias, nunca artefactos ni logs.

#### Scenario: sobre válido
- GIVEN un mensaje con `specVersion, eventId, eventType, executionId, pipelineId, environment, timestamp, source` y, cuando aplica, `stepId, status, attempt, payload`
- WHEN el Executor lo recibe
- THEN lo procesa según su `eventType`

#### Scenario: resultados nativos de AWS
- GIVEN un registro de Lambda Destinations o un evento de estado de CodeBuild vía EventBridge
- WHEN llega a la cola
- THEN el Executor lo normaliza al sobre antes de procesarlo
- AND IT MUST correlacionarlo con un step existente por su identificador externo (`requestId` o `buildId`)

#### Scenario: mensaje envenenado
- GIVEN un mensaje malformado o cuyo procesamiento falla de forma persistente
- WHEN se recibió 5 veces
- THEN termina en la DLQ y se dispara una alarma
- BUT it must NOT bloquear el procesamiento de los demás mensajes

#### Scenario: evento huérfano
- GIVEN un evento de finalización sin ejecución ni step correlacionable
- WHEN llega
- THEN se registra como huérfano y se confirma, sin efectos

### FR-05 — Estado de ejecución persistente

El sistema SHALL persistir el estado de cada ejecución y de cada step fuera del proceso del Executor, con transiciones válidas explícitas y estados terminales inmutables.

| Entidad | Estados | Terminales |
|---|---|---|
| Ejecución | `QUEUED, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, CANCELLED` | `SUCCEEDED, FAILED, TIMED_OUT, CANCELLED` |
| Step | `PENDING, WAITING_LOCK, DISPATCHING, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, SKIPPED` | `SUCCEEDED, FAILED, TIMED_OUT, SKIPPED` |

#### Scenario: transición válida
- GIVEN un step en `RUNNING`
- WHEN llega su finalización exitosa
- THEN pasa a `SUCCEEDED` con hora de fin, salidas y referencia externa

#### Scenario: transición inválida
- GIVEN un step en un estado terminal
- WHEN llega cualquier evento que intente cambiarlo
- THEN el estado no cambia y el evento se registra como no-op

#### Scenario: única vuelta atrás permitida (añadido tras Judgment Day ronda 2, R2-1)
- GIVEN un step de deploy en ejecución cuyo script informa que el target está ocupado por otra operación de deploy (código 50)
- WHEN se procesa ese resultado
- THEN el step vuelve a esperar el lock, con el mismo `executionId` y la misma identidad de step, liberando los recursos del intento
- BUT it must NOT existir ninguna otra transición hacia atrás: cualquier otra se rechaza

#### Scenario: steps paralelos
- GIVEN dos steps en curso al mismo tiempo
- THEN cada uno tiene su propio registro de estado
- BUT it must NOT existir un único "step actual" del que dependa la corrección

#### Scenario: reinicio del Executor
- GIVEN un reinicio del Executor
- WHEN vuelve a procesar
- THEN continúa desde el estado persistido
- AND IT MUST NOT depender de memoria del proceso anterior

### FR-06 — Planificación de steps

El sistema SHALL despachar cada step cuando sus dependencias (`needs`) están en `SUCCEEDED`, ejecutando en paralelo los steps independientes, y SHALL ejecutar los steps `finally` en cualquier desenlace.

#### Scenario: paralelismo
- GIVEN `server-quality` y `client-quality` sin dependencias
- WHEN la fuente está preparada
- THEN ambos se despachan sin esperar el uno al otro

#### Scenario: fan-in exactamente una vez
- GIVEN `deploy` depende de `server-image` y `client-image`
- WHEN ambos terminan (en cualquier orden, incluso con eventos duplicados o simultáneos)
- THEN `deploy` se despacha exactamente una vez

#### Scenario: fallo de dependencia
- GIVEN un step en `FAILED` o `TIMED_OUT`
- WHEN se replanifica
- THEN todos sus dependientes directos y transitivos pasan a `SKIPPED`
- AND la ejecución termina en `FAILED` (o `TIMED_OUT`) tras completar los steps ya en curso y los `finally`

#### Scenario: finally
- GIVEN cualquier desenlace terminal
- THEN los steps `finally` se ejecutan una vez
- BUT el fallo de un step `finally` must NOT cambiar el estado terminal ya determinado de la ejecución

### FR-07 — Procesamiento idempotente

El sistema SHALL garantizar que recibir el mismo evento más de una vez no produce efectos adicionales: ni dos despachos del mismo intento de step, ni dos deploys, ni dos migraciones, ni transiciones inválidas.

#### Scenario: BUILD_COMPLETED duplicado
- GIVEN `server-image` ya en `SUCCEEDED` y `deploy` ya despachado
- WHEN llega otra vez el `BUILD_COMPLETED` de ese build
- THEN no cambia ningún estado
- BUT it must NOT despachar `deploy` otra vez, ni abrir otra sesión SSH, ni ejecutar otra migración

#### Scenario: concurrencia entre instancias
- GIVEN dos procesos del Executor reciben a la vez copias del mismo evento
- WHEN ambos intentan la misma transición
- THEN solo uno la aplica y el otro la trata como ya procesada

#### Scenario: fallo entre registrar y despachar
- GIVEN el Executor registró la intención de despacho y falló antes de confirmar el mensaje
- WHEN el mensaje se re-entrega
- THEN el despacho de CodeBuild no crea un segundo build para el mismo intento
- AND IT MUST usar un token de idempotencia del intento

### FR-08 — Preparación de fuente

El sistema SHALL obtener el commit exacto de la ejecución, empaquetar los paquetes declarados y subirlos a rutas con alcance de ejecución, sin instalar dependencias ni compilar.

#### Scenario: preparación exitosa
- GIVEN una ejecución con commit resuelto
- WHEN corre la preparación de fuente
- THEN cada paquete queda en `executions/{executionId}/source/{package}.zip`
- AND el workspace local `/work/{executionId}` se elimina al terminar

#### Scenario: exclusiones obligatorias
- GIVEN el árbol del repositorio
- WHEN se empaqueta
- THEN se excluyen `.git`, `node_modules` y los archivos de secretos (`.env*` y archivos de configuración de entorno no versionados)
- BUT it must NOT haber valores de secretos en ningún ZIP

#### Scenario: keys fijas
- GIVEN dos ejecuciones concurrentes del mismo pipeline
- THEN sus objetos S3 y sus workspaces son disjuntos
- AND IT MUST NOT usarse ninguna key fija (p. ej. `codebuild/frontend.zip`)

#### Scenario: fallo y huérfanos
- GIVEN un fallo en clone, empaquetado o subida
- THEN el step falla con un código que distingue `SOURCE_CLONE`, `SOURCE_PREP` y `ARTIFACT_UPLOAD`
- AND el workspace se elimina igualmente
- AND al arrancar, el Executor elimina workspaces huérfanos

#### Scenario: concurrencia acotada
- GIVEN más preparaciones solicitadas que el límite configurado
- THEN las excedentes esperan
- BUT it must NOT superarse el límite

### FR-09 — Quality en Lambda

El sistema SHALL despachar las tareas de quality a Lambda de forma asíncrona y SHALL recibir su resultado como evento, clasificándolo.

| Resultado | Clasificación |
|---|---|
| El worker devuelve `status` de éxito | `QUALITY_COMPLETED` |
| El worker devuelve `status` de fallo (lint o test rojo) | `QUALITY_FAILED` (de negocio, sin reintento) |
| Error de función | `QUALITY_FAILED` con clase `INFRA` (1 re-despacho) |
| Timeout de la función | `QUALITY_TIMED_OUT` (distinto de FAILED) |

#### Scenario: no bloqueo
- GIVEN dos tareas de quality despachadas
- WHEN están en curso
- THEN el Executor sigue procesando otros eventos
- BUT it must NOT mantener una invocación síncrona abierta esperando el resultado

#### Scenario: enlace a logs
- GIVEN un resultado con `logUrl` o `logS3Uri`
- THEN se guarda en el step y aparece en la notificación de fallo

### FR-10 — Build en CodeBuild por ambiente

El sistema SHALL iniciar builds en el proyecto CodeBuild declarado para el ambiente del pipeline, con la fuente de la ejecución y un tag de imagen único, y SHALL recibir la finalización como evento.

#### Scenario: tag único
- GIVEN un build de la ejecución `prms-reporting-dev-184`
- THEN la imagen queda etiquetada `prms-reporting-dev-184`, con el commit y el `executionId` como metadatos
- AND IT MUST NOT reutilizar `latest` ni tags enteros que Jenkins pueda producir

#### Scenario: finalización por evento
- GIVEN un build en curso
- WHEN termina con `SUCCEEDED`, `FAILED`, `STOPPED` o `TIMED_OUT`
- THEN el step se actualiza por el evento correspondiente
- BUT el Executor must NOT sondear el build en el camino normal (solo el reconciler puede consultarlo)

#### Scenario: fuente de la ejecución
- GIVEN un build
- THEN su fuente es el ZIP de esa ejecución
- BUT it must NOT clonar el repositorio dentro de CodeBuild

#### Scenario: salidas
- GIVEN un build exitoso
- THEN el step expone `imageUri` y `digest` como salidas utilizables por steps posteriores

### FR-11 — Lock de deploy y supersede

El sistema SHALL impedir que dos ejecuciones del Executor desplieguen al mismo tiempo sobre la misma unidad de deploy, mediante un lock con propietario y lease, y SHALL omitir deploys de secuencias más viejas que la ya desplegada.

#### Scenario: adquisición
- GIVEN una unidad de deploy sin lock o con el lease vencido
- WHEN un step `ssh` la solicita
- THEN obtiene el lock con propietario = su `executionId` y un vencimiento

#### Scenario: ocupado
- GIVEN un lock vigente de otra ejecución
- WHEN se solicita
- THEN el step queda en `WAITING_LOCK` y reintenta con backoff
- AND tras 30 minutos de espera falla con `LOCK_TIMEOUT` y se notifica
- AND IT MUST ser `LOCK_TIMEOUT` el único resultado de agotar la espera, sea quien sea quien la detecte (el propio reintento o la reconciliación)

#### Scenario: propiedad
- GIVEN un lock de la ejecución A
- WHEN la ejecución B intenta renovarlo o liberarlo
- THEN la operación no tiene efecto

#### Scenario: renovación y liberación
- GIVEN un deploy en curso
- THEN el lease se renueva periódicamente mientras dura
- AND al terminar (éxito, fallo o finally) el lock se libera

#### Scenario: lock huérfano
- GIVEN un propietario que dejó de renovar
- WHEN vence el lease
- THEN otra ejecución puede adquirirlo
- AND IT MUST decidirse por el vencimiento del lease, no por la eliminación automática del registro

#### Scenario: supersede
- GIVEN el target ya tiene desplegada la secuencia 186
- WHEN la ejecución 184 obtiene el lock
- THEN su deploy pasa a `SKIPPED` con motivo `SUPERSEDED`, sin abrir SSH
- AND se libera el lock

### FR-12 — Deploy por SSH

El sistema SHALL desplegar a través de SSH ejecutando, en el target resuelto por el registro, una versión fijada y versionada del deploy script con argumentos declarados, y SHALL capturar su resultado.

#### Scenario: host key
- GIVEN un target
- WHEN el host key presentado no coincide con el registrado
- THEN la conexión se aborta y el step falla con `HOST_KEY_MISMATCH`
- BUT it must NOT aceptarse ningún host key no registrado

#### Scenario: credenciales
- GIVEN la credencial SSH
- THEN se obtiene en el momento de uso desde el gestor de secretos y se mantiene solo en memoria
- BUT it must NOT escribirse en disco, imagen ni logs
- AND IT MUST admitir llave privada y, solo si la entrada lo marca como temporal, password

#### Scenario: versión del script
- GIVEN un deploy
- THEN el script ejecutado es el de la versión de la definición de esa ejecución y su checksum queda registrado
- AND los archivos remotos temporales llevan el `executionId` en su ruta y se eliminan al final

#### Scenario: argumentos
- GIVEN los argumentos del step
- THEN se pasan escapados, sin interpretación de shell adicional
- BUT it must NOT construirse comandos concatenando texto de la definición

#### Scenario: resultado
- GIVEN el script termina
- THEN se registran el código de salida, la cola de la salida y la línea estructurada final
- AND el código se mapea según FR-13

#### Scenario: reintentos de conexión
- GIVEN una conexión fallida
- THEN se reintenta hasta 2 veces **antes** de iniciar el script
- BUT it must NOT reintentarse automáticamente un script que ya empezó

### FR-13 — Contrato del deploy script (lado target)

El deploy script SHALL realizar, en este orden: autenticación en el registro de imágenes y pull de las nuevas; materialización temporal de la configuración de runtime; migración (cuando se solicita) con la imagen nueva **mientras la versión anterior sigue en servicio**; reemplazo de contenedores; health check; limpieza. Además SHALL conservar la imagen anterior.

| Código | Significado | Versión anterior |
|---|---|---|
| 0 | Éxito | Reemplazada |
| 10 | Falló el login o el pull | Intacta |
| 20 | Falló la migración | Intacta (sin detener) |
| 30 | Falló el arranque; se restauró la anterior | Restaurada |
| 40 | Falló el health check; se restauró la anterior | Restaurada |
| 50 | Target ocupado: otra operación de deploy tiene el mutex local; **no se hizo nada** | Intacta |
| otro / sesión perdida | Desconocido | `UNKNOWN_TARGET_STATE` |

*(Revisión tras Judgment Day ronda 1, S-2, aprobada por el owner: se añade el código 50.)*

#### Scenario: segunda barrera en el target
- GIVEN una operación de deploy en curso en la unidad (aunque el lock distribuido haya vencido)
- WHEN se inicia otro deploy sobre la misma unidad
- THEN el segundo sale con 50 sin pull, migración ni swap
- BUT it must NOT reemplazar al lock distribuido de FR-11: ambos coexisten

#### Scenario: precondición de compatibilidad de migraciones
- GIVEN un target con migraciones habilitadas
- THEN su entrada del registro declara que las migraciones son compatibles hacia atrás, con quién lo atesta
- AND IT MUST considerarse inválida la definición que pide migrar sobre un target sin esa declaración
- BUT la plataforma must NOT presentar esa propiedad como garantizada: es responsabilidad del equipo de la aplicación

#### Scenario: migración fallida
- GIVEN la versión N sirviendo y la migración de N+1 falla
- WHEN corre el script
- THEN sale con 20 y N sigue sirviendo
- BUT it must NOT detener ni eliminar los contenedores de N

#### Scenario: health check fallido
- GIVEN N+1 arrancó pero no pasa el health check
- THEN el script restaura N y sale con 40

#### Scenario: imagen previa
- GIVEN cualquier desenlace
- THEN la imagen de N permanece disponible en el host
- BUT it must NOT ejecutarse limpieza de la imagen previa

#### Scenario: configuración temporal
- GIVEN la configuración de runtime materializada en un archivo temporal
- THEN su nombre contiene el `executionId`, solo lo lee el usuario de deploy y se elimina **en el target** en cualquier desenlace

#### Scenario: credenciales AWS del target
- GIVEN el target
- THEN el script obtiene sus permisos AWS sin depender de credenciales estáticas dejadas por ejecuciones previas
- AND IT MUST NOT escribir credenciales AWS en el host (dependencia: OD-Q5)

#### Scenario: idempotencia del script
- GIVEN el script ejecutado dos veces con las mismas imágenes
- THEN el segundo resultado es equivalente al primero y no hay una segunda migración con efectos

### FR-14 — Notificaciones

El sistema SHALL notificar desde el Executor, a través de un servicio de notificación con proveedores intercambiables (Slack en el PoC), los eventos: inicio, fallo de quality, fallo de build, fallo de deploy (incluido `UNKNOWN_TARGET_STATE`), timeout de lock, timeout de ejecución y éxito.

#### Scenario: contenido
- GIVEN una notificación
- THEN incluye `executionId`, pipeline, commit, step afectado (si aplica) y un enlace a logs
- BUT it must NOT incluir valores de secretos

#### Scenario: fallo del proveedor
- GIVEN Slack no disponible
- WHEN se intenta notificar
- THEN se registra el error y el pipeline continúa
- AND IT MUST NOT cambiar el estado de la ejecución por un fallo de notificación

#### Scenario: separación
- GIVEN Lambda y CodeBuild
- THEN ninguno envía notificaciones directamente

### FR-15 — Reconciliación

El sistema SHALL ejecutar periódicamente (cada 5 minutos o menos) una reconciliación que detecte ejecuciones y steps vivos más allá de su plazo, recupere finalizaciones perdidas de CodeBuild y cierre locks huérfanos.

#### Scenario: evento de CodeBuild perdido
- GIVEN un step `codebuild` vencido cuyo build ya terminó
- WHEN corre la reconciliación
- THEN el step adopta el resultado real del build

#### Scenario: step atascado
- GIVEN un step sin resultado tras su plazo
- THEN pasa a `TIMED_OUT`, se ejecutan los `finally` y se notifica

#### Scenario: sesión SSH interrumpida
- GIVEN un deploy cuyo propietario dejó de renovar el lock
- THEN la ejecución termina con `UNKNOWN_TARGET_STATE` y se notifica para verificación manual
- BUT it must NOT re-ejecutarse el deploy automáticamente

### FR-16 — Comportamiento ante fallos

El sistema SHALL comportarse como indica esta tabla. Cada fila es verificable de forma independiente.

| # | Fallo | Comportamiento obligatorio |
|---|---|---|
| F1 | Falla el git clone | 2 reintentos con backoff, luego `FAILED (SOURCE_CLONE)`; limpieza; notificación |
| F2 | Falla la preparación de fuente | `FAILED (SOURCE_PREP)`; limpieza |
| F3 | Falla la subida a S3 | 1 reintento del step, luego `FAILED (ARTIFACT_UPLOAD)` |
| F4 | Error de la función Lambda | `INFRA`; 1 re-despacho; luego `FAILED` |
| F5 | Quality rojo | `FAILED`, sin reintento; dependientes en `SKIPPED` |
| F6 | Timeout de Lambda | `TIMED_OUT`, sin reintento |
| F7 | Build fallido | `FAILED` con enlace al log; sin reintento |
| F8 | Falla el push de imagen | `FAILED` (ocurre dentro del build) |
| F9 | Redelivery de SQS | No-op (FR-07) |
| F10 | Falla la conexión SSH | 2 reintentos antes del script; luego `FAILED`; se libera el lock |
| F11 | Falla la migración | Código 20 → `FAILED (MIGRATION)`; versión anterior sirviendo; sin reintento |
| F12 | Falla el deploy script | Código ≠ 0 → `FAILED` con código y cola de salida; sin reintento |
| F13 | Falla el health check | Código 40 → `FAILED (HEALTH)`; versión anterior restaurada |
| F14 | Falla Slack | Se registra y se continúa |
| F15 | Reinicio del Executor | Reanuda desde el estado persistido; barrido de workspaces |
| F16 | Ejecución atascada | Reconciliación → `TIMED_OUT` |
| F17 | Lock huérfano | El lease vence; reconciliación; `UNKNOWN_TARGET_STATE` si había un deploy en curso |
| F18 | Target ocupado (código 50) | Vuelve a la espera de lock dentro del mismo presupuesto de 30 min; al agotarlo, `LOCK_TIMEOUT` |
| F19 | El target exige una ventana de deploy y no hay ninguna abierta | `FAILED (DEPLOY_WINDOW_CLOSED)` sin abrir SSH; notificación |

### FR-17 — Observabilidad

El sistema SHALL emitir logs estructurados en los que cada entrada relacionada con una ejecución contiene `executionId` (y `stepId` cuando aplica), y SHALL exponer alarmas para mensajes en la DLQ, ejecuciones vivas más allá de su plazo y Executor sin actividad.

#### Scenario: reconstrucción
- GIVEN un `executionId`
- WHEN un operador consulta el estado persistido y los logs
- THEN puede determinar qué steps corrieron, con qué identificadores externos, cuánto duraron y por qué falló, sin acceso a Jenkins

#### Scenario: redacción
- GIVEN cualquier log
- THEN no contiene secretos, credenciales ni tokens

### FR-18 — Coexistencia con Jenkins

El sistema SHALL operar los deploys reales del PoC solo dentro de ventanas de prueba en las que los jobs de Jenkins que despliegan sobre la misma unidad de deploy están deshabilitados, y SHALL dejar registro de cada ventana.

#### Scenario: ventana
- GIVEN una prueba de deploy en `<PRMS_REPORTING_DEV_TARGET>`
- THEN antes de empezar se anuncia, se verifica que no hay builds de Jenkins en curso para esos jobs y estos se deshabilitan
- AND al terminar se rehabilitan y se registran responsable, horarios y ejecuciones

#### Scenario: Jenkins global
- BUT it must NOT apagarse Jenkins globalmente ni modificarse Jenkinsfiles

#### Scenario: precondición
- GIVEN que la lista de jobs no está confirmada (dependencia del inventario de configuración)
- THEN no se ejecutan deploys reales sobre ese target

#### Scenario: respaldo técnico (añadido tras Judgment Day ronda 1, S-4)
- GIVEN un target marcado en el registro como "requiere ventana de deploy"
- WHEN se intenta un deploy y no hay ninguna ventana abierta y vigente (registrada con responsable y con la lista no vacía de jobs externos deshabilitados)
- THEN el deploy falla sin abrir SSH y se notifica
- BUT el mecanismo must NOT contener lógica específica de Jenkins en el núcleo: es una capacidad genérica y transitoria por target que se retira cambiando datos del registro

#### Scenario: revalidación de la ventana (añadido tras Judgment Day ronda 2, R2-W1)
- GIVEN una ventana válida cuando empezó la ejecución
- WHEN el deploy espera el lock, recibe "target ocupado" o está a punto de ejecutar el script
- THEN la ventana se vuelve a comprobar en cada uno de esos momentos, y debe cubrir la duración posible del deploy
- AND IT MUST NOT ejecutarse el script si la ventana venció: el step falla sin efectos en el target y se notifica

### FR-19 — Retención de artefactos

El sistema SHALL eliminar los artefactos de fuente de cada ejecución al terminarla, y la infraestructura SHALL expirar automáticamente: fuente a 7 días, logs y reportes a 30 días, subidas multipart incompletas a 1 día.

#### Scenario: ejecución abandonada
- GIVEN una ejecución que nunca terminó
- THEN sus artefactos desaparecen por expiración aunque no se haya ejecutado la limpieza explícita

### FR-20 — Trigger por webhook de GitHub (SHOULD)

El sistema SHOULD aceptar webhooks de push de GitHub para pipelines con trigger `github-push`, verificando la firma y deduplicando por id de entrega.

#### Scenario: firma inválida
- GIVEN un webhook sin firma válida
- THEN se rechaza y no se encola nada

#### Scenario: rama no configurada
- GIVEN un push a una rama no declarada
- THEN no se crea ninguna ejecución

---

## 7. Non-Functional Requirements

| ID | Requisito | Medida / verificación |
|---|---|---|
| **NFR-01 Frontera del Executor** | El Executor MUST NOT: instalar dependencias ni compilar (npm/pnpm/maven/docker build); ejecutar scripts de repositorios de aplicación; conectarse a bases de datos de aplicación; leer secretos de aplicación; contener ramas de código por proyecto o aplicación; interpretar expresiones, bucles o scripts embebidos en definiciones; alojar el daemon o el socket de Docker | Inspección de la imagen (sin toolchains ni socket montado); revisión de permisos y red; búsqueda de identificadores de proyecto en el código del Executor = 0; validación de schema que rechaza expresiones |
| **NFR-02 Seguridad** | Ningún secreto en ZIPs, objetos S3, imagen, definiciones, registro ni logs. Mínimo privilegio por componente y ambiente. Credenciales AWS del Executor temporales o, si no es posible, justificadas de forma explícita (dependencia: OD-Q12). Host key fijado. Credencial SSH solo en memoria | Escaneo de artefactos, imagen y logs; revisión IAM |
| **NFR-03 Confiabilidad** | Corrección bajo entrega at-least-once, desorden y reinicios. Ningún deploy duplicado. Locks recuperables sin intervención | Pruebas de duplicados, concurrencia y kill |
| **NFR-04 Huella de recursos** | Contenedor con límites de CPU y memoria. Preparaciones de fuente y sesiones SSH concurrentes acotadas y configurables. Disco de trabajo dimensionado por medición (dependencia: OD-Q15) | Configuración del contenedor; medición en el incremento de fuente |
| **NFR-05 Latencia de coordinación** | Desde que un evento de finalización está en la cola hasta que el siguiente step queda despachado: ≤ 60 s en condiciones normales | Medición en E2E (p95 en ≥ 10 ejecuciones) |
| **NFR-06 Operabilidad** | Un operador reconstruye cualquier ejecución solo con estado persistido, logs y notificaciones | Ejercicio de runbook |
| **NFR-07 Costo** | CodeBuild solo para builds de imagen; quality en Lambda; sin cómputo permanente nuevo para el Executor. Se informan duraciones y recursos medidos | Informe de medición |
| **NFR-08 Extensibilidad sin código de proyecto** | Añadir un pipeline del mismo patrón requiere solo una definición y una entrada de registro, **sin cambios de código** del Executor. Añadir un tipo de step afecta solo a su capacidad y al schema. *Simplificación del PoC: como las definiciones van empaquetadas en la imagen, publicar una definición nueva requiere reconstruir y redesplegar la imagen. La fuente de definiciones debe estar abstraída para poder externalizarla sin cambiar el núcleo* | Prueba: segunda definición ficticia del mismo patrón validada sin cambios de código |
| **NFR-09 Aislamiento de ambiente** | Todos los recursos y permisos del PoC son DEV. Sin acceso a recursos STAGING o PROD | Revisión IAM (una sola cuenta AWS, FA §2) |
| **NFR-10 No interferencia** | El PoC no modifica Jenkinsfiles, código de aplicación ni elimina credenciales existentes en hosts | Revisión de cambios |

---

## 8. Defect classes y gates

| Clase de defecto | Gate que la detecta | Sin gate automático → sustituto |
|---|---|---|
| Transición de estado inválida o en carrera | Tests de dominio con base de datos local y concurrencia simulada | — |
| Doble despacho, doble deploy o doble migración | Tests de idempotencia + E2E con inyección de duplicados | — |
| Lock mal adquirido o liberado, o supersede incorrecto | Tests de LockService con base de datos local (contención, vencimiento, propietario ajeno) | — |
| Definición o registro inválidos aceptados | Tests de validación con casos negativos | — |
| Error de tipos en contratos | Type-check / build del proyecto | — |
| Secreto filtrado en ZIP, S3, imagen o logs | Escaneo automatizado de artefactos de prueba e imagen | Revisión humana del escaneo en la HITL de E2E |
| El Executor incluye toolchains o lógica de proyecto (frontera) | Inspección de imagen + búsqueda de identificadores de proyecto | Revisión de diseño en cada PR |
| Script de deploy en orden incorrecto (migra después de detener) | Prueba E2E con migración rota a propósito | Verificación humana del servicio en la ventana |
| Rollback ineficaz tras un health check fallido | Prueba E2E con imagen que no arranca | Verificación humana |
| Conectividad de red faltante | Spike de red | — |
| Permiso IAM excesivo | **Sin gate automático completo** | Revisión humana de políticas en la HITL de infraestructura; riesgo aceptado residual |
| Interferencia con Jenkins | **Sin gate automático** | Checklist de ventana (FR-18) verificado por el admin de Jenkins |
| Latencia (NFR-05) | Medición sobre ≥ 10 ejecuciones; si la dispersión supera el umbral, el resultado no es evidencia y se reporta la dispersión | — |

---

## 9. Decisiones abiertas y dependencias

Ninguna se resuelve en esta fase.

| OD | Pregunta (sin responder) | Requisitos que dependen | Qué queda sin decidir |
|---|---|---|---|
| OD-Q5 | ¿`<PRMS_REPORTING_DEV_TARGET>` admite instance profile? ¿Usuario de deploy dedicado? ¿Qué jobs usan sus llaves sobrantes? | FR-13 (credenciales AWS del target), FR-18 | El mecanismo exacto por el que el target obtiene permisos AWS. FR-13 exige el resultado (sin llaves estáticas sobrantes), no el mecanismo |
| OD-Q7 | ¿CDK o Terraform? | FR-19 (lifecycle), aprovisionamiento de toda la infra | La herramienta de IaC. Los requisitos describen recursos y comportamientos, no la herramienta |
| OD-Q11 | ¿Qué host es exactamente el servidor de microservicios? ¿PROD? ¿Swarm? ¿Proxy? | NFR-04, NFR-09, conectividad | El host. NFR-09 exige aislamiento DEV en permisos y recursos; si el host es PROD, se escala al owner |
| OD-Q12 | ¿Cómo obtiene el Executor credenciales AWS sin exponerlas a otros contenedores? | NFR-02 | El mecanismo. NFR-02 exige mínimo privilegio y no exposición |
| OD-Q13 | ¿Los tests de quality necesitan configuración con secretos? | FR-08, FR-09 | Si el worker necesita leer secretos. FR-08 prohíbe secretos en ZIPs en cualquier caso |
| OD-Q14 | ¿Alguien consume `<JENKINS_EXECUTIONS_TABLE>`? | Ninguno del PoC | Compatibilidad futura de registros |
| OD-Q15 | Tamaño de `<PRMS_REPORTING_REPO>` y autenticación en GitHub | FR-08, NFR-04 | El tamaño del disco y el tipo de credencial de lectura del repo |

Dependencias de evidencia aún no disponibles (del proposal Q1–Q3, parcialmente resueltas): nombres de los jobs de Jenkins (FR-18), formato de entrada de `<QUALITY_WORKER_FUNCTION>` (FR-09), comandos y orden de migración actuales (FR-13), Dockerfiles y `.dockerignore` de `<PRMS_REPORTING_REPO>` (FR-10).

---

## 10. Requirement ID Index

| ID | Nombre | Fuerza | Proposal |
|---|---|---|---|
| FR-01 | Pipeline Definitions declarativas | SHALL | R-DEF, §10.4 |
| FR-02 | Target Registry | SHALL | §10.4 |
| FR-03 | Solicitud de ejecución e identidad | SHALL | R-ID |
| FR-04 | Recepción de eventos | SHALL | R-QUEUE, §10.3 |
| FR-05 | Estado persistente | SHALL | §10.12 |
| FR-06 | Planificación de steps | SHALL | R-PAR |
| FR-07 | Procesamiento idempotente | SHALL | R-IDEM, §10.13 |
| FR-08 | Preparación de fuente | SHALL | R-NOSECRETS, §10.7 |
| FR-09 | Quality en Lambda | SHALL | §10.6 |
| FR-10 | Build en CodeBuild por ambiente | SHALL | §10.5 |
| FR-11 | Lock y supersede | SHALL | R-LOCK, §10.14 |
| FR-12 | Deploy por SSH | SHALL | §10.8 |
| FR-13 | Contrato del deploy script | SHALL | R-MIG, R-ROLLBACK-READY, §10.11 |
| FR-14 | Notificaciones | SHALL | §10.15 |
| FR-15 | Reconciliación | SHALL | R-RECON |
| FR-16 | Comportamiento ante fallos | SHALL | §10.17 |
| FR-17 | Observabilidad | SHALL | R-OBS, §10.16 |
| FR-18 | Coexistencia con Jenkins | SHALL | §12 |
| FR-19 | Retención de artefactos | SHALL | §10.7 |
| FR-20 | Webhook de GitHub | SHOULD | Inc 8 |
| NFR-01…10 | No funcionales | MUST / SHALL | §6, §13, §14 |

**Delta del proposal:** todos los ADDED se convierten en FR. Los MODIFIED (ruta de deploy, orden del deploy, credenciales del target) quedan en FR-12, FR-13 y FR-18. No hay REMOVED.

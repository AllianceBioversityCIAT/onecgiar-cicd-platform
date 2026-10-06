# Execution Log — changes/cicd-executor-poc

## Document Control

| Campo | Valor |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Alcance autorizado | **Gate A únicamente (T-00 a T-22)**. Aprobado por el owner (CI/CD Platform Team) el 2026-10-05. Detenerse tras T-22 |
| Repositorio | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git`. Commits y push autorizados para Gate A |
| Approval Mode | `gated` |
| Triad | Leader `opus` (T1) · Implementer `sonnet` (T2) · Reviewer `opus` (T3) en un contexto independiente (author ≠ auditor) |
| Personas | `.agents/` creadas por la **constitución mínima** aprobada por el owner (2026-10-05): `CLAUDE.md`, `AGENTS.md`, `.agents/{leader,implementer,reviewer}.md`. Sin wrappers de Step 8E: los subagentes se lanzan con la persona por referencia |
| Entorno | Node 20.19.5, npm 10.8.2, Java 17 (DynamoDB Local y ElasticMQ). **El daemon de Docker no estaba disponible** al empezar; el owner decidió arrancarlo él. T-01 y T-14 completan sus verificaciones con Docker cuando el daemon responda |
| Budget (design §13) | 37 tareas · ~8.700 LOC · ~50 rondas de review. Gate A: 23 tareas, ~7.900 LOC |

## Task Execution History

### T-00 — Vincular el workspace al repositorio canónico y excluir el análisis local · **PASS**

| Campo | Valor |
|---|---|
| Fecha | 2026-10-05 |
| Intentos | 1 |
| Archivos | `.gitignore` (nuevo), `.git/` (init + `origin` + `main` siguiendo `origin/main`), `LICENSE` (traído del remoto, sin editar) |
| Verificación (Implementer) | `git status --porcelain` sin los archivos `JENKINS_REPLACEMENT_*`; `git ls-files \| grep -c JENKINS_REPLACEMENT_` = 0; `git check-ignore` → `.gitignore:2` y `:3`; ambos archivos siguen en disco; HEAD `41f4c3e` |
| Red run | Antes del `.gitignore`: ambos `JENKINS_REPLACEMENT_*` aparecían como `??` |
| Falsifier | Quitar la línea `..._AKILI_CONTEXT.md` → reaparece `?? JENKINS_REPLACEMENT_AKILI_CONTEXT.md`; revertido |
| Re-run de evidencia | **VERIFIED** (Leader inline): mismas salidas |
| Reviewer | **PASS** (`opus`, contexto independiente). Override (f), superficie de seguridad, aplicado |
| ADVISORY | (1) Registrar P-26 → hecho; (2) `safe.directory` global → informado al owner; (3) `.env.*` ignora `.env.example`: añadir `!.env.example` si una tarea lo crea; (4) `.local/` y `.codegraph/` ignorados, ninguna tarea debe versionar ahí |
| Requisitos | NFR-02, NFR-10 · design §4.1, §4.2 |
| Decisiones | **Edición de spec en ejecución:** design §11, fila P-26 → verificada (`git ls-tree -r --name-only origin/main` → `LICENSE`, `41f4c3e`) y línea de conteo → 4 verificadas / 23 `UNVERIFIED` (Low 13). No cambia el significado de ningún requisito |
| Decisión del Leader | Se añade `.gitattributes` (`* text=auto eol=lf`, `*.sh eol=lf`) porque la configuración global usa `autocrlf` y el script de deploy debe tener LF para correr en Linux. Es higiene del repo y no amplía el alcance funcional |
| Desviación | El Implementer añadió `git config --global --add safe.directory D:/executor_component` porque Git no operaba por un desajuste de propietario en Windows. Es una configuración de máquina, fuera del repo. Revertible con `git config --global --unset safe.directory D:/executor_component` |
| spawns | implementer 23 calls, 64577 tokens, ended complete; reviewer 8 calls, 51233 tokens, ended complete |

### T-01 — Esqueleto del proyecto Executor y puertos · en curso

| Campo | Valor |
|---|---|
| Intento 1 | Archivos: `executor/` (package.json, tsconfig, eslint, vitest, Dockerfile, .dockerignore, puertos ×9, stubs según §4.2, `test/unit/dockerfile-boundary.test.ts`). Verificación del Implementer: typecheck, lint y tests verdes (3/3). Falsifier: `apt-get install docker.io` → rojo. Re-run de evidencia: **VERIFIED** (Leader inline). Construcción e inspección de la imagen: **DIFERIDAS** (sin daemon de Docker) |
| Reviewer intento 1 | **FAIL** (`opus`). (1) La guarda estática tiene puntos ciegos: `FROM docker:27-cli`, `COPY --from=docker`, `apk add docker`, `get.docker.com`, JDKs ≠ openjdk, `python3-pip`, npm/pnpm/yarn/corepack y `USER 0`. El Red run de la tarea no se pone rojo. (2) La imagen runtime conserva npm/npx/corepack y ejecuta `npm ci` → viola NFR-01. (3) Node 20 terminó su soporte el 2026-04-30 → no es LTS (DD-15). Reporte completo copiado al intento 2 |
| ADVISORY intento 1 | `WriteCondition` solo con `expectedVersion` (considerar `expectedStatus` antes de T-08); `StepHandler` necesitará una forma en dos fases para T6 de `ssh` (T-13); `tsconfig.build.json` con `skipLibCheck: false` para src; `validate` es un TODO que sale con 0 (riesgo de falso verde antes de T-21); el socket montado en ejecución se comprueba en el host (DD-18); vulnerabilidades de solo desarrollo en vitest 2.x |
| Intento 2 | En curso: esfuerzo alto; Node 22 LTS; escáner con fixtures negativos; runtime sin npm |
| spawns | implementer 65 calls, 136483 tokens, ended partial (imagen diferida); reviewer 7 calls, 73126 tokens, ended complete |
| Intento 2 | Archivos: `executor/Dockerfile` (3 etapas, `node:22-slim`, runtime sin npm/npx/corepack, no root), `package.json` (engines `>=22`, `@types/node ^22`), `test/support/dockerfile-boundary-scanner.ts`, `test/unit/dockerfile-boundary{,-scanner}.test.ts`. 27/27 tests. Falsifier `FROM docker:27-cli AS runtime` → rojo. Re-run de evidencia: **VERIFIED** (27/27) |
| Reviewer intento 2 | **FAIL** (`opus`). Hallazgos 2 y 3 resueltos. Quedan bypasses del escáner: (1) alias de etapa (`FROM docker AS tools` + `COPY --from=tools`), `--platform`, `${ARG}`; (2) `FROM builder` como etapa final evita la regla de borrado de npm; (3) se evalúa el primer `USER`, no el último; (4) `NODE_ENV=… npm`, rutas absolutas, forma exec, `npx`, borrado laxo; (5) yarn queda en `/opt/yarn-*` |
| Adjudicación del Leader (antes del intento 3) | Según el texto de T-01, el **gate es la inspección de la imagen construida**. El escáner estático es un pre-check de mejor esfuerzo, no el gate. Un analizador estático completo frente a un revisor adversarial queda fuera del alcance de la tarea (narrow-never-widen). El intento 3 corrige los 5 hallazgos con fixtures y añade `scripts/inspect-image.mjs` (gate real). Sin daemon, ese script devuelve `DEFERRED` con un código distinto y nunca PASS |
| spawns (intento 2) | implementer 34 calls, 99064 tokens, ended partial (imagen diferida); reviewer 10 calls, 67069 tokens, ended complete |
| Intento 3 | Archivos: `test/support/dockerfile-boundary-scanner.ts` (5 hallazgos corregidos), `Dockerfile` (+ `rm -rf /opt/yarn-*`), `scripts/inspect-image.mjs` (gate real; `DEFERRED` con exit 3 sin daemon), `package.json` (`inspect:image`), `test/fixtures/dockerfiles/Dockerfile.falsifier-docker-cli`, tests (44/44). Falsifier: 13 tests nuevos rojos contra la lógica del intento 2 y verdes tras el arreglo. Re-run de evidencia: **VERIFIED** (44/44; `inspect:image` → `DEFERRED`, exit 3) |
| Reviewer intento 3 | **FAIL** (`opus`). Los 5 hallazgos del intento 2 y el Dockerfile están conformes. El gate real tiene (1) un punto ciego en symlinks: el `find` usa solo `-type f`/`-type d`, y en Debian mvn, java, gradle y el npm/yarn de apt son symlinks a `/usr/share` o `/usr/lib/jvm`, fuera de `SCAN_DIRS` → falso PASS; (2) no comprueba el socket montado (`Config.Volumes`, `/var/run/docker.sock`), que la verificación de la tarea exige |
| ADVISORY intento 3 | `process.exit()` dentro de `try` evita el `finally` (no limpia la imagen de prueba); los errores de `find` ocultos → falta un control positivo (`/usr/local/bin/node` debe encontrarse); mensaje de `DEFERRED` más específico; huecos del escáner estático fuera de alcance; pin por digest pendiente |
| spawns (intento 3) | implementer 49 calls, 159899 tokens, ended partial (imagen diferida); reviewer ended complete |

## HALT: T-01

| Campo | Valor |
|---|---|
| Causa | 3 intentos con Reviewer FAIL (límite de rework) |
| FAIL 1 | Guarda regex estrecha; runtime con npm; Node 20 fuera de soporte |
| FAIL 2 | Bypasses del escáner estático (alias de etapa, `FROM builder`, último `USER`, normalización de npm, yarn en `/opt`) |
| FAIL 3 | El gate real `inspect-image.mjs` no sigue symlinks ni amplía las rutas de búsqueda (mvn, java, gradle, npm de apt); no comprueba el socket montado |
| Verificación final | typecheck y lint limpios; 44/44 tests; `inspect:image` → `DEFERRED` (exit 3) |
| Hipótesis del Leader | **No es una ambigüedad de la spec ni un enfoque inviable.** La causa es la combinación de (a) un gate que no puede ejecutarse (sin daemon de Docker), lo que obliga a aproximarlo con lógica estática que el Reviewer ataca de forma adversarial, y (b) huecos reales pero acotados en cada iteración. Los defectos restantes son concretos y pequeños (symlinks y rutas de búsqueda, chequeo de socket) |
| Estado del árbol | Solo los cambios de T-01 sin commitear (`executor/`). T-00 ya estaba commiteado. **No se aplicó rollback:** el Leader suspendió el `git restore`/`git clean` del protocolo hasta la decisión del owner, para no destruir trabajo mayoritariamente conforme (esqueleto, puertos y Dockerfile aprobados por el Reviewer) |
| Decisión del owner tras el HALT | Autoriza un **4.º intento excepcional** limitado al gate de inspección de imagen: symlinks y rutas de búsqueda, chequeo del socket y los tres advisory de robustez (limpieza en `finally`, control positivo y estado de `find`, mensaje `DEFERRED` específico). Si pasa, T-01 queda `[~]` solo por la ejecución real diferida hasta tener Docker, y se continúa con T-02 |
| Intento 4 (excepcional) | Archivos: `scripts/inspect-image.mjs` (reescrito con funciones puras), `scripts/inspect-image.d.mts`, `test/unit/inspect-image.test.ts` (20), `test/fixtures/dockerfiles/Dockerfile.falsifier-maven`, `dockerfile-boundary.test.ts`. 65/65. Falsifiers: el filtro `-type l` y el chequeo de volúmenes se ponen rojos al revertirlos. `inspect:image` → `DEFERRED` específico, exit 3. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 4 | **FAIL** (`opus`). Resueltos: symlinks, volúmenes y los tres advisory. Nuevos huecos de falso PASS en el gate: (1) `/app` se excluye entero → npm/pnpm/yarn como dependencia de producción (o binarios copiados a `/app`) son invisibles; (2) el barrido corre como usuario no root y filtra "permission denied" → no ve toolchains bajo `/root`; (3) el control positivo (`command -v node`) no prueba que `find` corrió; no se lee el estado de salida de `find`; un fallo de `/tmp` o `grep` deja el barrido vacío y "limpio" |
| ADVISORY intento 4 | `VOLUME /run` (en Debian `/var/run` → `/run`); el chequeo del socket dentro del contenedor no puede dispararse, porque el montaje se decide al desplegar: el mensaje no debe sobreafirmarlo; el mensaje PASS debe mencionar los chequeos de volúmenes y socket |
| spawns (intento 4) | implementer 48 calls, 122459 tokens, ended partial (imagen diferida); reviewer ended complete |
| Decisión del owner (validación por entorno) | El owner no puede ejecutar Docker en su máquina Windows por restricciones de permisos y entorno. **Instrucción:** validar localmente todo lo que no requiera Docker. `docker build`, la inspección de la imagen en runtime, la verificación NFR-01 en runtime y el arranque y salud del contenedor quedan como **validación diferida por entorno**, obligatoria antes de desplegar en el servidor de microservicios. No se debilita NFR-01, no se cambia la arquitectura, no se instalan alternativas a Docker ni se cambia la configuración de la máquina. **Edición de spec:** `tasks.md` T-01, nueva fila "Validación por entorno". No cambia el significado de ningún requisito |
| Intento 5 (flujo continúa con la decisión del owner) | Corregir los 3 hallazgos del intento 4 en el gate diferido (barrido de `/app`; barrido como root con chequeo de no-root por separado; el control positivo prueba que `find` se ejecutó y se lee su estado de salida) y los advisory (`/run`, mensajes sin sobreafirmar). Añadir chequeo de dependencias. Verificación solo local |
| Intento 5 | Archivos: `scripts/inspect-image.mjs` (barre `/app`; corre como root con `--user 0`; usuario no root comprobado por `Config.User`; `find` es su propio control positivo; se lee su estado de salida; cualquier error de `find` = FAIL; `/run` incluido; mensaje PASS acotado), `scripts/inspect-image.d.mts`, `test/unit/inspect-image.test.ts` (41), `package.json` (`check:deps`, `check:local`). Verificación local: `check:local` verde (86/86, `npm audit --omit=dev` sin vulnerabilidades). `inspect:image` → `DEFERRED` (exit 3). Falsifiers: 4 mutaciones en rojo, revertidas. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 5 | **PASS** (`opus`). Los 3 hallazgos y el advisory resueltos; sin rutas de falso PASS en el Dockerfile ni en los fixtures; gate local cumplido; sin regresión de NFR-01 |
| ADVISORY final | (1) `evaluateUser` comprueba el nombre, no el UID: un `useradd -o -u 0` pasaría (hoy inalcanzable); conviene resolver el UID efectivo en la ejecución real. (2) Paquetes scoped o renombrados (`@yarnpkg/cli-dist`, `@pnpm/exe`). (3) Comentario desactualizado del Dockerfile ("find/id"). (4) `check:deps` necesita acceso al registry. (5) Pin por digest de `node:22-slim` pendiente |
| **VALIDACIÓN DIFERIDA POR ENTORNO (obligatoria antes de desplegar)** | En un entorno con Docker: `npm run inspect:image` contra el `Dockerfile` real (esperado PASS) y contra `test/fixtures/dockerfiles/Dockerfile.falsifier-docker-cli` y `Dockerfile.falsifier-maven` (esperado FAIL), más arranque y salud del contenedor. Pendiente también el pin por digest |
| Estado final | **PASS (porción local)**. T-01 `[x]` según la decisión del owner, con la validación por entorno diferida y registrada |
| Requisitos | NFR-01, NFR-08 · DD-01, DD-05, DD-15, DD-19, §4.2 |
| Decisiones | Adjudicación del Leader (el gate es la imagen real; el escáner es un pre-check); 4.º intento excepcional autorizado por el owner; reclasificación de la validación por entorno por decisión del owner; `CLAUDE.md` actualizado (Node 22 LTS, `check:local`, `inspect:image`) |
| Budget | T-01 consumió 5 rondas de review (≈1,5 presupuestadas por tarea). Acumulado del spec: 7 rondas en 2 tareas. Dentro del total (~50), con una tendencia que se vigila |
| spawns (intento 5) | implementer 62 calls, 157412 tokens, ended partial (Docker diferido por decisión del owner); reviewer ended complete |

> **Modo de avance (2026-10-05):** la instrucción del owner ("ejecutar T-00 a T-22 y detenerse al final") se trata como aprobación del avance rutinario dentro del Gate A: los gates de continuar o pausar entre tareas se pasan con el registro `auto-approved (owner Gate A mandate)`. HALT, Pivot, budget tripwire, `FATAL_FAIL`, una decisión abierta o una validación diferida por entorno siguen deteniendo para el owner.

### T-04 — Máquina de estados: lista cerrada T1–T13 · en curso

| Campo | Valor |
|---|---|
| Intento 1 | Archivos: `executor/src/domain/state-machine/index.ts`, `executor/src/domain/errors/index.ts`, `executor/test/unit/state-machine.test.ts` (576 tests; cartesiano de 520 casos). Falsifier T9 50→40 → 5 rojos. Red run (rechazar todo) → 69 rojos. Re-run de evidencia: **VERIFIED** (576/576, 0 errores de tipos en sus archivos, lint limpio) |
| Reviewer intento 1 | **FAIL** (`opus`). (1) Falta la máquina de estados de **ejecución** (QUEUED…CANCELLED), dentro del alcance de T-04 según FR-05. (2) Las guardas nunca se prueban con valores falsos: borrar casi cualquier guarda deja la suite en verde. (3) T7/T8 aceptan códigos que evitan §7.2 y la regla canónica (`FAILED(TARGET_BUSY)`, `LOCK_TIMEOUT`, `INVALID_TRANSITION`, `DEPLOY_WINDOW_CLOSED` en no-ssh, FAILED sin código) |
| ADVISORY intento 1 | Tests tautológicos (L259, L489, L210); T3 no incrementa `attempt`; T6 de `ssh` sin entrada V4; deadlines a cargo de la capa de aplicación; `classifyDeployExitCode` lanza excepción con 0 |
| Intento 2 | En curso. Esfuerzo xhigh. Guía del Leader: la cadena de ejecución está especificada en la fuente (proposal §10.6 y la tabla de FR-05): QUEUED→RUNNING→{SUCCEEDED, FAILED, TIMED_OUT, CANCELLED}. No inventar transiciones; un hueco se reporta como hueco de la spec |
| spawns (intento 1) | implementer 49 calls, 184284 tokens, ended complete; reviewer 14 calls, 89825 tokens, ended complete |

### T-02 — Schemas versionados y definición semántica · en curso

| Campo | Valor |
|---|---|
| Intento 1 | Archivos: `schemas/{pipeline,targets,event}.schema.json`, `pipeline-definitions/prms/reporting-dev.yaml`, `pipeline-definitions/targets/dev.yaml`, `executor/test/contract/*` (25 tests), `executor/package.json` (ajv, ajv-formats y yaml como dev). Falsifier: quitar `deployWindowPolicy` de `oneOf[0].required` → rojo. Re-run de evidencia: **VERIFIED** (`check:local` 687/687; búsqueda de identificadores internos limpia) |
| Reviewer intento 1 | **FAIL** (`opus`). (1) Falta un caso negativo para "omite la declaración de desplegadores externos" y un positivo de la rama `none` + `not-required`. (2) Tensión de spec: `none` ⇒ `not-required` en el schema frente a la tabla de §7.7, que permitía `required` + vacío. (3) `interpolableString` acepta `$(...)` y backticks (script embebido, FR-01 `AND IT MUST`) |
| ADVISORY intento 1 | Mensaje "reservado, no habilitado" → T-03 (lista reutilizable en `$defs`); `STEP_RETRY`/`LOCK_RETRY` exigen `status` (validar con T-07); `openedBy`/`externalJobsDisabled` en el nivel superior y falta `closesAt`; ajv y yaml deberán pasar a dependencias de producción en T-03; sin caso dedicado para la omisión de `migrationCompatibility` |
| **Enmienda de spec (tensión → owner)** | El owner aprobó "`none` ⇒ `not-required`". Edición de design §7.7 (tabla y "Forma versionada"): la lista vacía exige `not-required`, y `required` + vacío es inválido. Se registra para el brief del Reviewer de la próxima tarea |
| Intento 2 | En curso: casos de corpus para (1), rechazo de `$(`, backticks y `$` suelto para (3), `$comment` alineado con la enmienda para (2) |
| spawns (intento 1) | implementer 79 calls, 205259 tokens, ended complete; reviewer 12 calls, 92152 tokens, ended complete |
| Intento 2 | Archivos: `schemas/pipeline.schema.json` (`interpolableString` estricto, `argString` sin `;|&<>`), `schemas/targets.schema.json` (`$comment` alineado con la enmienda), `executor/test/contract/{targets,pipeline}-schema.contract.test.ts` (33 tests). Falsifiers: quitar `externalDeployersRef` del `required` → rojo; permitir `$(` → rojo; permitir backtick → rojo. Re-run de evidencia: **VERIFIED** (33/33; búsqueda de identificadores internos limpia) |
| Reviewer intento 2 | **PASS** (`opus`). Los 3 hallazgos resueltos; conforme a design §7.7 enmendado el 2026-10-05; sin regresiones en las interpolaciones permitidas |
| ADVISORY final | (1) `\n`/`\r` no se excluyen en `argString`. (2) Los valores de `env` de CodeBuild aceptan texto con forma de bucle (no los evalúa el Executor). (3) `migration.check`/`run` son texto libre que llega al target. (4) Un solo caso por chequeo en ssh args |
| Forward pointers (registrados) | **T-03:** limitar `migration.check`/`run` a un patrón de nombre de script y considerar cerrar las claves de `env` de CodeBuild; mensaje "tipo reservado, no habilitado"; `ajv`/`yaml` como dependencias de producción. **T-13:** cada arg SSH se pasa escapado (sin interpretación de shell); rechazar o escapar `\n`/`\r` |
| Estado final | **PASS** |
| Requisitos | FR-01, FR-02, FR-04 · §6.1, §7.7 (enmendado), DD-11, DD-21, DD-23 |
| spawns (intento 2) | implementer 50 calls, 120796 tokens, ended complete; reviewer ended complete |
| Intento 2 | Archivos: los mismos 3 (máquina de ejecución E1/E2, falsifiers por guarda, restricción de códigos de T7/T8 con blocklist, advisory). 623 tests. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 2 | **FAIL** (`opus`). Los hallazgos 1–3 del intento 1 resueltos. Nuevos: (1) T9 no comprueba que el código 50 sea del intento vigente (un 50 obsoleto devuelve a `WAITING_LOCK` un intento vivo); (2) la blocklist sigue aceptando `SUPERSEDED`, `TIMED_OUT` como `FAILED` y códigos de exit en T7 desde `DISPATCHING`; (3) T7 no relaciona `reason` y `failureCode`. Advisory: T12 desde `RUNNING` ssh/codebuild con `externalRef` contradice la tabla de recuperación |
| Huecos de spec (para el owner) | (a) Ninguna regla define **qué estado terminal** toma una ejecución (agregado de sus steps). (b) `QUEUED → CANCELLED` (y cualquier disparador de `CANCELLED`) no está especificado. No se inventan transiciones |
| Intento 3 (último) | En curso: allowlists por transición derivadas de §7.2; identidad del intento en T9; `reason` ⇔ código en T7; T12 alineado con la tabla de recuperación |
| spawns (intento 2) | implementer 79 calls, 203145 tokens, ended complete; reviewer ended complete |
| Intento 3 | Allowlists por transición y tipo derivadas de §7.2; T9 con `matchesCurrentAttempt`; T7 con `reason` ⇔ `DEPLOY_WINDOW_CLOSED`; T12 desde `RUNNING` aceptado para lambda/source/notify y rechazado para ssh/codebuild. Hubo una continuación del mismo intento porque la directiva del Leader sobre T12 fue demasiado estrecha y el Leader la corrigió. 646 tests (794 en total). Falsifiers: 6 mutaciones en rojo, revertidas. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 3 | **PASS** (`opus`). Hallazgos del intento 2 resueltos; allowlists fieles a §7.2; T12/T13 conformes con la tabla de recuperación; terminales inmutables |
| ADVISORY final | `notify` sin códigos en T7: el handler debe llegar siempre a T6 o a un resultado (T-16/T-19); un `RUNNING codebuild` cuyo build no encuentra `BatchGetBuilds` no tiene salida → T-11 debe tratarlo; T10 confía en el flag `retryable` del llamador |
| Forward pointers | **T-11 (reconciler):** build no encontrado por `BatchGetBuilds` → definir el cierre sin inventar estados (escalar si la spec no lo cubre). **T-10:** derivar `retryable` de los códigos de §7.2. **T-16/T-19:** el handler `notify` siempre alcanza T6 o un resultado |
| Estado final | **PASS** |
| Requisitos | FR-05, FR-11, FR-16 · §7.2, §7.3, DD-03, DD-04 |
| continuations | 1 (directiva T12, error del Leader) |
| spawns (intento 3) | implementer 86 calls, 231870 tokens, ended complete; reviewer ended complete |

### T-03 — `DefinitionSource` y validación semántica · en curso

| Campo | Valor |
|---|---|
| Intento 1 | Archivos: `application/definition-service/*` (index, semantic-rules, registry-rules, reference-resolution, schema-validation), `adapters/bundled-definition-source`, `schemas/targets.schema.json` (`scriptName` para migraciones, `portRef`), `pipeline-definitions/targets/dev.yaml`, tests unitarios (5 archivos) y de contrato. `ajv`, `ajv-formats` y `yaml` pasan a dependencias de producción. Continuación (el Leader resolvió que no hay bloqueo por OD-Q7, porque el empaquetado DD-19 está en alcance): `Dockerfile` con la raíz del repo como contexto, copia de las 3 carpetas, `.dockerignore` en la raíz, build arg `DEFINITION_REF`, `deploy-scripts/README.md`, `resolveBuildContext` en `inspect-image`. 801/801. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 1 | **FAIL** (`opus`). (1) **Frontera NFR-01:** el arranque resuelve todas las referencias, incluido `envSecretRef` (secreto de aplicación). (2) La detección de duplicados sobre valores resueltos está incompleta: no resuelve `name`, agrupa por el secreto de conexión completo (no por host) y compara el mapeo de puerto entero en lugar del puerto publicado. (3) La imagen arranca en producción sin `DEFINITION_REF` inyectado; `BUILD_INFO.json` malformado se ignora en silencio |
| ADVISORY intento 1 | `portRef` y advisory (b) aceptables; raíz de definiciones por variable de entorno en lugar de recorrer directorios hacia arriba; un caso end-to-end por regla de esquema a través del servicio; T-18 debe llamar a `validateForStartup` antes de consumir; ampliar el test de sustitución cuando existan el planner y los handlers |
| Intento 2 | En curso: allowlist de campos a resolver (`envSecretRef` opaco), forma del valor de conexión resuelto con `host`, puerto publicado, `name` resuelto, `requireInjectedRef` en producción y `CICD_DEFINITIONS_ROOT` |
| spawns (intento 1) | implementer 136 calls, 318403 tokens, ended complete (con continuación); reviewer ended complete |
| continuations | 1 (empaquetado DD-19) |

### T-06 — Política de lock · en curso

| Campo | Valor |
|---|---|
| Intento 1 | Archivos: `executor/src/domain/lock-policy/index.ts`, `executor/test/unit/lock-policy.test.ts` (27). Red run sin recorte → 3 rojos. Falsifiers: tope 1000 → rojo (tras corregir una tautología con el literal 900); elapsed como suma → rojo. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 1 | **FAIL** (`opus`). La lógica es conforme. El test del tope de 10 intentos es tautológico: usa la constante exportada, así que cambiar 10 a 11 no lo pone rojo |
| ADVISORY intento 1 | `delaySeconds` fraccional (SQS exige entero); el token de fencing se reinicia si el TTL borra y recrea el lock → T-08 debe usar una condición monotónica; constante de renovación de 60 s; falta un test de cadena |
| Forward pointers | **T-08:** condición de escritura del target con fencing monotónico (`token ≥ stored`) y no borrar locks vivos por TTL. **T-11:** redondear y usar `LOCK_RENEWAL_INTERVAL_SECONDS` |
| spawns (intento 1) | implementer 49 calls, 149248 tokens, ended complete; reviewer ended complete |
| Intento 2 | El test del tope usa los literales `lockWaitAttempts` 9 y 8. `delaySeconds` es entero (`ceil`, nunca > 900). Se exporta `LOCK_RENEWAL_INTERVAL_SECONDS = 60`. 30/30. Falsifier: tope 11 → rojo. Re-run de evidencia: **VERIFIED** |
| Reviewer intento 2 | **PASS** (`opus`). Hallazgo resuelto; el redondeo `ceil` es conforme con §7.6 |
| Estado final | **PASS** |
| Requisitos | FR-11, FR-16 F17–F18 · DD-09, §7.6 |
| spawns (intento 2) | implementer 23 calls, 81903 tokens, ended complete; reviewer ended complete |
| Attempt 2 | Allowlists for resolved refs (`envSecretRef` never resolved); resolved-value duplicate detection by parsed `host`, resolved container `name`, published host port; `requireInjectedRef` in production; `BUILD_INFO.json` removed; `CICD_DEFINITIONS_ROOT`; end-to-end `validateForCi` cases; English translation of touched files. check:local 846/846. Evidence re-run: **VERIFIED** (T-03 suites 86/86, 0 type errors, 0 prod vulns) |
| Reviewer attempt 2 | **FAIL** (`opus`). Attempt-1 findings resolved; §7.7 (amended) conformant. New: (1) three Spanish fragments left (`.dockerignore`, `definition-service/index.ts`, `reference-resolution.ts`); (2) `parseResolvedExternalDeployers` echoes resolved values into error text (NFR-02, DD-23); (3) **spec tension**: design §7 `definition-service` row prohibits reading secret values, while startup reads GitHub/Slack tokens and the SSH connection secret (host+user+credential) only to prove existence (DD-23) |
| **Owner ruling (spec tension, 2026-10-05)** | **"Existence without reading" (least privilege).** `SecretProvider` gains an existence-only check (AWS: `DescribeSecret`, never the value). Credential refs (`repository.credentialRef`, Slack `tokenRef`, and the new SSH `credentialRef`) are existence-checked only at startup. `getSecret` is used at startup only for non-sensitive identifier refs. The Target Registry splits the connection into `connectionRef` (non-sensitive identity JSON `{host, port, user}`) and `credentialRef` (SSH key or password, read only by the SSH handler at use time and kept in memory). Spec amendment to DD-23 and design §7 to be applied once the in-progress English translation of `design.md` lands |
| Attempt 3 (last) | In progress: the ruling above, plus findings 1–2 and the advisory (no resolved identifiers in error text, target IDs only) |
| spawns (attempt 2) | implementer 137 calls, 236055 tokens, ended complete; reviewer 13 calls, 98641 tokens, ended complete |

### Language normalization (owner directive, 2026-10-05)

| Field | Value |
|---|---|
| Directive | Owner: all code, its documentation and commits must be in English (conversation stays in Spanish). Scope extended by the owner to the spec documents under `docs/specs/` |
| Rule placement | `CLAUDE.md` ("Language"), `AGENTS.md`, `.agents/{leader,implementer,reviewer}.md` (Reviewer item 6: Spanish in committed code is a FAIL) |
| Part 1 (code) | Translated comments, JSDoc and test titles in `domain/{state-machine,errors,lock-policy}`, their tests and `schemas/pipeline.schema.json`. No behavior change: identical test counts (646/30/43/41) green; zero Spanish by scan and manual read. Leader verified counts inline. Commit `7abda3c` |
| Leader slip | Commit `7abda3c` staged `executor/src/domain` broadly and swept in the in-progress T-07 file `domain/events/index.ts` before its review. Not destructive; T-07's review covers the full content (diff vs `206ca9f`) and its final commit will land the rest. Lesson: stage explicit paths only |
| Specs | `proposal`, `requirements`, `design`, `judgment` being translated (separate agent, fidelity checks on table rows/headings/IDs). `tasks.md` and `execution.md` translated at the end of Gate A; new `execution.md` entries already written in English |

### T-07 — Event envelope, normalization and orphan events · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `domain/events/index.ts`, `application/event-router/{index,schema-validation}.ts`, `test/unit/event-{normalizers,router}.test.ts` (23), `test/fixtures/aws/*` (9 synthetic, marked provisional; P-1/P-17/P-18). Falsifier: disabling the externalRef check → STALE_ATTEMPT test red. Evidence re-run: **VERIFIED** (0 type errors, 23/23, lint clean) |
| Reviewer attempt 1 | **FAIL** (`opus`): four Spanish comment fragments (English-only rule). Everything else conformant (schema via DefinitionSource, FR-09/§7.2 classification, orphan paths, poison error, provisional fixtures) |
| Leader decisions for attempt 2 (execute-time, from advisories) | (B) a result for the current attempt arriving while the step is still DISPATCHING without `externalRef` returns `RETRY_LATER` (left unacknowledged for SQS redelivery) instead of being acked as orphan; Lambda correlates on the current `dispatchToken` per design §6.1 (FR-04 names `requestId`; the design is more specific and wins). (C) `environment` comes from the execution record, not hardcoded. (D) Ajv error details (no payload values) in `MalformedEventError` |
| Forward pointers | **T-10 (dispatcher):** for lambda steps `externalRef` is the `dispatchToken`; write it consistently. **T-18 (consumer):** `RETRY_LATER` and `MalformedEventError` must not be acknowledged |
| Attempt 2 | Translated fragments; `RETRY_LATER` for CodeBuild results arriving in DISPATCHING without `externalRef`; Lambda correlates on `dispatchToken`; `environment` from lookup; Ajv paths/messages in `MalformedEventError`; +4 router tests (27 total). Falsifiers: RETRY_LATER removed → red; Lambda by externalRef → red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`). No Spanish; decisions B–D sound; RETRY_LATER bounded by maxReceiveCount→DLQ and reconciler T13/T12 |
| ADVISORY | Log/metric for RETRY_LATER + DLQ triage note in runbook (T-22); EventBridge rule must filter terminal `build-status` (T-28 / infra inventory T-22); internal producers keep `attempt` current (T-10); `MalformedEventError.rawMessage` must not be dumped to logs (T-18) |
| Final status | **PASS** |
| Requirements | FR-04, FR-07, FR-09 · §6.1–§6.3, §7.2, DD-02, DD-19 |
| spawns | implementer attempt 1 113 calls 211801 tokens complete; reviewer 10 calls 93792 tokens complete; implementer attempt 2 66 calls 154269 tokens complete; reviewer complete |

### T-03 — final

| Field | Value |
|---|---|
| Attempt 3 | Owner ruling implemented (`SecretProvider.exists()`; credential refs existence-only; `connectionRef` identity-only with credential-field rejection; required `credentialRef`); no resolved values in any error text; remaining Spanish translated. 93/93. Falsifiers: 4 mutations red, reverted. Evidence re-run: **VERIFIED** |
| Reviewer attempt 3 | **PASS** (`opus`). Ruling conformant; earlier fixes intact; English-only clean; no internal identifiers |
| ADVISORY | Sanitize provider `cause.message` (possible ARN/account ID) in the AWS adapter task; formal DD-23/§7 amendment pending (spec translation); prefer an allowlist `{host, port, user}` for the identity JSON over a credential-key denylist |
| Forward pointers | **Secrets adapter (Gate B):** `exists()` via `DescribeSecret`; never surface ARNs in errors. **T-18:** call `validateForStartup` before consuming |
| Final status | **PASS** |
| Requirements | FR-01, FR-02, NFR-01, NFR-02, NFR-08 · DD-19, DD-23 (+ owner ruling), §7, §7.7 |
| spawns | attempt 1 implementer 136 calls 318403 tokens complete (+1 continuation); attempt 2 implementer 137 calls 236055 tokens complete; attempt 3 implementer 112 calls 205463 tokens complete; 3 reviewers complete |

### T-05 — Planner · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `domain/planner/index.ts`, `test/unit/planner.test.ts` (9). Falsifier `.every`→`.some` → fan-in red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): implementation conformant; missing evidence for FR-06 "dependency failure" clauses — no in-flight-after-failure test; TIMED_OUT never exercised |
| Spec gaps for the owner (added) | (c) outcome precedence when FAILED and TIMED_OUT coexist (implementer chose FAILED > TIMED_OUT, documented); (d) whether independent pending steps keep being dispatched after a failure; (e) execution outcome when a step is SKIPPED by supersede (T4) |
| spawns (attempt 1) | implementer 30 calls, 140812 tokens, complete; reviewer complete |
| Attempt 2 | Added in-flight-after-failure and TIMED_OUT tests; cheap advisories (skip reason, T4 comment, missing finally snapshot as PENDING, ssh finally routing note). 11/11. Falsifiers: 3 mutations red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Forward pointer | **T-10 (dispatcher):** RUN_FINALLY for a step with no Step item must not loop (create items up front or treat absent as PENDING in the conditional write); route ssh finally steps via T2 |
| Final status | **PASS** |
| Requirements | FR-06, FR-16 F5 · DD-06, §7.3 |
| spawns (attempt 2) | implementer 39 calls, 93178 tokens, complete; reviewer complete |

### T-17 — Observability · done

| Field | Value |
|---|---|
| Attempt 1 | Files: `observability/{logger,metrics,heartbeat}/*`, 5 test files (33). Falsifier: PEM pattern removed → red (an inert fixture was found and fixed first). Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): redaction leaks — presigned URL security token and `ASIA` keys; key-only tokens and `Authorization` schemes; Error instances / null-prototype objects / non-string sensitive values; suffix keys (`db_password`), multi-word quoted values, truncated PEM |
| Attempt 2 | In progress (also: fields cannot overwrite context; end-to-end corpus through the logger; heartbeat ticks on start, try/catch, atomic healthcheck write) |

### T-20 — GitHub webhook ingress · in progress

| Field | Value |
|---|---|
| Attempt 1 | New package `ingress/github-webhook/` (pure core + adapters; 25 tests). Falsifier: `timingSafeEqual` swapped → structural test red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): §6.6 requires `WEBHOOK_UNMATCHED` and "ignored and logged" log entries; the package logs nothing |
| Leader ruling (recorded) | The ingress uses its own minimal `PipelineDefinitionReader` (list capability) over the same bundled `pipeline-definitions/` instead of the Executor's `DefinitionSource` (no list capability; task scope limited to the ingress package). Acceptable; a future task may add a list capability to `DefinitionSource` and schema validation to the reader |
| Attempt 2 | In progress (logger port + structured entries + no-secret test; truthful comments on ref resolution; environment from definition; omit empty `after`) |

### Spec translation and amendment

| Field | Value |
|---|---|
| Translation | `proposal`, `requirements`, `design`, `judgment` translated to English; fidelity review **PASS** (identical line/row/heading/ID counts; no meaning changes); review wording suggestions applied. Commit `8081bc8` |
| Amendment applied | design v3.2: DD-23 and §7 `definition-service` row amended per the owner's "existence without reading" ruling (see T-03) |
| T-20 attempt 2 | Logger port + `StdoutJsonLogger`; `WEBHOOK_UNMATCHED`, `EVENT_IGNORED`, `MALFORMED_PAYLOAD`, `MISSING_DELIVERY_ID` entries without payload contents; NFR-02 no-secret test; environment from definition; omit empty `after`; truthful ref-resolution comments. 30/30. Falsifiers: 2 red. Evidence re-run: **VERIFIED** |
| T-20 reviewer attempt 2 | **PASS** (`opus`) |
| T-20 final status | **PASS** · Requirements FR-20, FR-03, NFR-02 · §6.6, DD-20 · spawns: implementer a1 70 calls 136111 tokens; reviewer 14 calls 93037 tokens; implementer a2 73 calls 143413 tokens; reviewer complete |
| T-17 attempt 2 | Widened presigned/AKIA|ASIA patterns, suffix-based sensitive keys with exemptions, Error normalization, generic object walk, suffix key/value and truncated PEM patterns; logger field-override fix; e2e corpus; heartbeat tick-on-start/try-catch; atomic healthcheck write. 83/83. 5 falsifiers red. Evidence re-run: **VERIFIED** |
| T-17 reviewer attempt 2 | **FAIL** (`opus`): tokens inside string content leak (key=value, JSON bodies, `X-Amz-Security-Token:` header, `ghs_`/`github_pat_`); cyclic objects crash the logger (no cycle guard; BigInt throws); `idempotencyToken` (a correlation id per DD-04) over-redacted |
| T-17 attempt 3 (last) | String-content vocabulary extended (`token`, `api_key`, `authorization`, `passwd`, `pwd`, `cookie`, `sshkey`, JSON-quoted keys, header-colon form), `gh[opusr]_`/`github_pat_`, standalone `Signature=`, URL basic-auth credentials, `secretsmanager` ARN over-redaction fixed; `WeakSet` ancestor-path cycle guard; `safeStringify` fallback (BigInt); `idempotencyToken`/`nextToken` exempted (DD-04); `Error.cause`/`AggregateError.errors`; heartbeat split try blocks. 115/115. 4 falsifiers red. Evidence re-run (Leader): typecheck + lint clean, 115/115 — **VERIFIED** |
| T-17 reviewer attempt 3 | **PASS** (`opus`): all three findings resolved; corpus still covers every §12 secret type (PEM falsifier still red when removed); exemptions exact-match only (`xDispatchToken` still redacted); `executionId` cannot be overridden by callers; EMF set matches §12; NFR-01 clean |
| Advisory (non-gating) | (1) add `private[-_]?key` / `secret[-_]?access[-_]?key` to the string-content vocabulary; (2) JSON values with escaped quotes leak the tail — use `"((?:\.|[^"\])*)"`; (3) treat Buffer/typed arrays as opaque; (4) minor over-redaction (`tokenCount=`, presigned tail); (5) test uses the AWS documentation account placeholder — prefer `<AWS_ACCOUNT_ID>`-style (relevant to T-21 guard 4); (6) Map/Set serialize to `{}` |
| Status | **Done** |

### T-22 — Infrastructure inventory and base runbooks · done

| Field | Value |
|---|---|
| Attempt 1 | `infra/RESOURCES.md` (23 resources + IAM by component + checklist), `docs/runbook.md`, `docs/resources.md`, `docs/jenkins-coexistence-log.md`. Sanitization scan clean; falsifier on the 7-day clause flipped the checklist. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): Executor IAM blocks Slack/GitHub credential reads at point of use; S3 lacks SSE/BPA/bucket policy and worker grants; 7-day rule misdescribed; ingress Lambda missing; wrong cross-reference (#6); coexistence log lacks migration-state/snapshot columns |
| Design gap noted | FR-17 requires an alarm for executions past their deadline; design §12 lists none. Implemented as an inventory alarm on a reconciler-emitted metric (forward pointer to T-11) |
| Forward pointer | **T-11:** emit `ExecutionsPastDeadline` metric for the alarm |
| Attempt 2 | Executor IAM: `GetSecretValue` at point of use on #11–#13, `DescribeSecret` limited to #11–#13 (#14 excluded); #4 SSE + BPA + bucket policy, worker S3 grants on #17 (`executions/*/source/*` read, `executions/*/quality/*` write); 7-day expiration from object creation; ingress row #24; #6 → #23; coexistence log columns "Migration state before / after" and "DB snapshot taken"; `ExecutionsPastDeadline` alarm placeholder; `ecr:GetAuthorizationToken` accepted exception; `sqs:GetQueueAttributes`. Cross-reference script OK; falsifier deleting #24 → MISSING. Evidence re-run (Leader): sanitization scan clean, #24 present — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`): all six findings fixed; NFR-01 intact (no ECR push, build, DB or application secrets for the Executor); NFR-09 DEV-only scoping; open decisions untouched |
| Advisory (non-gating) | (a) a `> 0` alarm on `ExecutionsPastDeadline` may fire on routine reconciliation — T-11 should decide on consecutive periods or post-reconciliation counting; (b) #17's S3 grants also apply to the quality worker's Jenkins invocations — worth one sentence in IAM review; (c) #4's bucket policy principal should name the worker role itself |
| Forward pointer | **T-11:** choose the `ExecutionsPastDeadline` alarm semantics (advisory a) |
| Status | **Done** |

### T-14 — Generic deploy-container.sh · in progress

| Field | Value |
|---|---|
| T-14 attempt 1 | `deploy-scripts/deploy-container.sh` (outer orchestrator + `--internal-locked` worker under `flock -n -E 50`; `trap '' HUP` first; previous image from running container; migration before swap; restore on health failure; per-repository pruning keeping previous; 0600 runtime env files under `/tmp/cicd-<executionId>/`; `CICD_RESULT` last line) + shim test suite (9 cases). Declared deviations: `--migration-mode`, `runtime-<container>.env`, usage exit 2, isolated `fetch_runtime_secret()` (OD-Q5 pending). Falsifier (swap before migrate) → container-state assertions red with exit 20 unchanged. shellcheck not installed (SKIPPED, not PASS). Evidence re-run (Leader): `bash deploy-scripts/test/run-tests.sh` → 9 run, 0 failed — **VERIFIED** |
| Deferred (environment) | Real Docker, kernel `flock` and Linux behavior — Gate C, T-33 |
| Reviewer attempt 1 | **FAIL** (`opus`): (1) idempotent re-run (running image == `--image`) sets the restore candidate to the new image and prunes N's image, and reports different `previousImages` — violates FR-13 "previous image" and "script idempotency", §5.3; no idempotency test; (2) codes 30 and 10 and `--migration-mode temp-container` lack container-state assertions (T-14 Done/Disqualifier, DD-11). Deviations (a) `--migration-mode`, (b) `runtime-<container>.env`, (c) usage exit 2, (e) per-repository pruning accepted; (d) `fetch_runtime_secret` does **not** resolve OD-Q5 (proposal §10.10 already prescribes the credentials-file exclusion) |
| T-14 attempt 2 | Idempotent re-run keeps the `--previous` hint as restore candidate (or skips pruning without one) — `test_idempotent_rerun.sh`; container-state tests for codes 10 and 30 and for `temp-container` mode; neutral secret ref; skip semantics in the harness; `validate_token()` strict charset (exit 2 before effects); 0600 capture (environment-limited, SKIP); wording per proposal §10.10; consumer `bundled-definition-source.test.ts` updated. 14 run / 0 failed / 1 skipped; vitest 1006 passed |
| Evidence re-run attempt 2 | **MISMATCH** (Leader): `run_test()` lets `TEST_SKIPPED` override a failure, and `test_secret_not_leaked.sh` marks the whole test skipped because its 0600 sub-check cannot run on this filesystem — the secret-leak assertions can no longer fail here (gate blind). Counts as FAIL |
| T-14 attempt 3 (last) | In progress: failure precedence over skip; 0600 as a skipped assertion only; falsifier proving the leak test reports FAILED |

### T-21 — Boundary guards and validation command · done

| Field | Value |
|---|---|
| Attempt 1 | Six guards in `executor/scripts/guards/*.mjs` orchestrated by `run-all.mjs`, wired to `npm run validate` and `check:local`: (1) static Dockerfile boundary scanner (real `inspect:image` stays DEFERRED); (2) project/application denylist from `proposal.md` (provenance quoted; `risk`/`monitoring`/`swarm` excluded on false-positive grounds — judgment call); (3) schema expression smoke corpus; (4) publication-policy scan over `git ls-files` + staged with masked output, narrow literal and path+rule allowlists, optional gitignored local denylist; (5) local analysis files untracked and ignored; (6) NFR-08 fictitious second definition validated through `validateForCi`. 12 tests. Falsifier `if (project === 'prms')` → guard 2 red. Evidence re-run (Leader): typecheck + lint clean, validate 6/6, 12/12; extra Leader probe (`'aiccra'` in the planner) → guard 2 red at file:line, reverted — **VERIFIED** |
| Consumer drift noted | `bundled-definition-source.test.ts` assumed `deploy-container.sh` absent; T-14 now adds it — fix assigned to T-14 attempt 2 |
| Reviewer attempt 1 | **FAIL** (`opus`, full): (1) guard 2 denylist omits projects cited in the proposal (`clarisa`, `alliance-indicators`, `bi`, `risk`, `monitoring`) — a probe with those names stays green; violates the T-21 Disqualifier and NFR-01. `swarm` exclusion accepted (deployment technology, not a project). (2) "At image build time" neither done nor labeled deferred. Calls (b) allowlists, (c) in-memory transpile, (d) smoke corpus accepted; guards confirmed not to ship in the runtime image |
| Deferred (dependency) | Running `npm run validate` at image build time is deferred to **T-31** as a CI step before `docker build` (guards 4 and 5 need `git ls-files`, unavailable inside a Docker build context). T-31 is blocked on **OD-N1**, which stays open; not resolved by assumption |
| T-21 attempt 2 | Guard 2 adds `clarisa`, `alliance-indicators`, `bi`, re-adds `risk`/`monitoring` with per-entry `word`/`quoted` matching (common words only as whole quoted literals), corrected citations, scans non-comment lines of `deploy-scripts/**/*.sh`; guard 4 masks to ≤2 chars, scans untracked non-ignored files, adds two AWS public documentation literals to the global allowlist, requires a FAKE marker for the observability-test exemptions; whole-line `.gitignore` matching. 22 tests; full vitest 1016 passed. Evidence re-run (Leader): validate 6/6, 22/22; Leader probe (`'bi'`, `'clarisa'`) → 2 violations, reverted — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`, full): denylist now covers every project cited in the proposal (probes flagged; prose not flagged); build-time run deferred to T-31 with OD-N1 open; allowlist literals `AKIAIOSFODNN7EXAMPLE` and `s3.us-west-2.amazonaws.com` accepted as public AWS documentation values (exact match); FAKE-marker exemption verified; guards do not ship in the runtime image |
| Advisory (non-gating) | quoted-only matching misses compound forms (`'risk-dev'`, `startsWith('risk-')`); path-style S3 bucket names are not checked; results observed on Node v20.19.5 locally, not yet on Node 22 |
| Status | **Done** (build-time run deferred to T-31) |

## PAUSE: Gate A — architecture change AC-01 under evaluation (2026-10-06)

| Field | Value |
|---|---|
| Trigger | Owner request: evaluate GitHub Actions as the CI owner and the Executor as CD-only coordinator (START SIMPLE) |
| State at pause | 12/23 Gate A tasks done and pushed (T-00–T-07, T-17, T-20, T-21, T-22) |
| In-flight, frozen (uncommitted, untouched) | T-08 DynamoDB store (implementer report never delivered); T-14 deploy script attempt 3 (implementer reported done; Leader evidence re-run not performed — interrupted) |
| Analysis | `architecture-change-01.md` (status PROPOSED) |
| Resume condition | Owner approval of AC-01, coherent revision of proposal/requirements/design/tasks, scoped Judgment Day APPROVED |

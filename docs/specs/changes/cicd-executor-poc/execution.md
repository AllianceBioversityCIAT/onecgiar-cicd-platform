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

## RESUME: Gate A under Model B (2026-10-06)

| Field | Value |
|---|---|
| Authority | Owner approval 2026-10-06 after the scoped Judgment Day (APPROVED); specs proposal/requirements v3.4, design/tasks v4.4 (commit 6d2fecd) |
| Scope | Gate A only: N-01…N-22 (tasks v4.4). Gate B and C not started |
| Mapping | Old T-tasks map to N-tasks per tasks §3; T-00, T-06 (partly → N-07), T-17, T-21 kept as done |
| Frozen work | T-08 files land in N-08; T-14 attempt-3 evidence is re-verified by the Leader inside N-15 |
| Environment | No local Docker; shim/static validations only; Node observed locally v20.19.5 (project targets 22) |

### N-01 — Obsolescence cleanup and guard · done

| Field | Value |
|---|---|
| Attempt 1 | Deleted `ingress/github-webhook/**`, adapters `git-cli-client`, `s3-artifact-store`, `zip-packager`, `handlers/{lambda,codebuild,notify}`, ports `artifact-store`, `git-client`, `application/step-dispatcher`; new guard 8 `obsolescence` (10 DELETED, 16 PENDING with owners N-03/N-04/N-05/N-07/N-08/N-12; import scan covers `from`, `import()`, `require`, `vi.mock`); 9 negative tests. Red run before deleting: 10 paths + 2 barrel imports. Falsifier: import of `git-cli-client` → red. Pre-review Leader correction: renumbered to guard 8 (guard 7 reserved for action-pinning). Evidence re-run (Leader): typecheck/lint clean, validate PASS, vitest 1025 passed / 17 skipped; Leader falsifier (import of `zip-packager` in the planner) → red, reverted — **VERIFIED** |
| Residual references reported | Dockerfile git comment (N-18); `docs/runbook.md`, `docs/resources.md`, `infra/RESOURCES.md` CodeBuild/Lambda/ingress rows (N-20); stale "step-dispatcher" comments (rework tasks) |
| Reviewer attempt 1 | **PASS** (`opus`, full): every §15 DELETE row deleted or PENDING with the right owner; imports (incl. dynamic, `require`, `vi.mock`) checked; nothing KEEP/REWORK deleted; residual references acceptable with their owners |
| Forward pointers | **Every owner task** (N-03, N-04, N-05, N-07, N-08, N-12) flips its PENDING entries to DELETED when it removes the path or symbol. **N-22:** add a strict mode that fails while any PENDING entry remains (advisory 1). **N-19:** add `executor/scripts` to the scan roots and drop the stale `scripts`/`ingress` roots; cover `vi.doMock`/`vi.importMock`. Next task touching `ports/queue-publisher.ts` fixes its stale comment |
| Status | **Done** |

### N-15 — `deploy-container.sh` adaptation · done

| Field | Value |
|---|---|
| Step 1: T-14 attempt-3 evidence (Leader re-run) | `bash -n` OK; `bash deploy-scripts/test/run-tests.sh` → 14 run, 0 failed, 0 whole-test skips, 1 assertion skipped (0600 bits; not reflected on this filesystem, deferred to Gate C); shellcheck SKIPPED (not installed). Leader falsifier: `cat` of the secret file to stderr in `materialize_runtime_secret` → "secret value leaked into stderr", TEST FAILED; reverted, suite green — **VERIFIED**. T-14 attempt 3 fixed failure-over-skip precedence (Leader MISMATCH of attempt 2) |
| Attempt 1 (N-15) | In progress |

### N-02 — Schemas: deployment, deploy request, internal events · done (commit together with N-05)

| Field | Value |
|---|---|
| Attempt 1 | New `deploy-request.schema.json`, `deployment.schema.json`; `event.schema.json` reduced to `LOCK_RETRY_REQUESTED`, `RECONCILE_TICK`, `DEPLOY_WINDOW_OPEN_REQUESTED`, `DEPLOY_WINDOW_CLOSE_REQUESTED`, `TARGET_RESOLUTION_RECORDED`; flat `deployment-definitions/prms/reporting-dev.yaml`; `deployment-definitions/targets/dev.yaml` copied (old `pipeline-definitions/` kept for N-03). Contract suite 103. Falsifier (nested `additionalProperties`/digest rule removed) → 7 red; permissive red run → 66 failed. Evidence re-run (Leader): `test/contract` 103/103, validate PASS — **VERIFIED** |
| Sequencing | Reducing `event.schema.json` breaks 5 old event-router tests (old types); N-05 rewrites the router. **N-02 is committed together with N-05** so no red tree is pushed |
| Reviewer attempt 1 | **PASS** (`opus`, full): exact §6.1/§6.2/§6.4 fields; nested rules exercised; `*Ref` pattern enforces DD-23; body `source` is an integrity check only — authorization stays with `SenderId` (DD-25) |
| Forward pointers | **N-10:** own the §6.2 "unit set must equal the request's" check (missing-unit and extra-unit tests) at X1 consistency. **N-05:** tighten per-type event fields (`oneOf` + `unevaluatedProperties: false`); authorize only from the `SenderId` mapping, never from body `source`. **N-03:** add negatives for raw `imageRepositoryRef`/`container`, `runtimeSecretRefs`, raw health `url`, extra `observedDigests` key; reword the targets comment that cites an unpublished source; use the same Ajv options at runtime as the contract tests |
| Status | **Done** (commit pending with N-05) |

### N-04 — State machine X1–X16 and errors · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `applyTransition` with X1–X16, effect hints (`clear`, `appendTargetUnresolved`, `raiseHighestDispatched`, `conditionOnDispatchToken`, `terminal`); errors reworked (`classifyExitCode`); planner deleted (guard 8 → DELETED); temporary types-only `legacy-vocabulary.ts` for frozen T-08 files and the old router. 100 tests (72-pair matrix). Red run 92 failed; falsifier X14→QUEUED → 6 failed. Evidence re-run (Leader): typecheck/lint clean, validate PASS, 100/100; Leader falsifier X3→WAITING_LOCK → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): X2 gated on an owned dedupe claim, but rejection precedes the claim (design §3.3, §7 ordering) and `REJECT#MSG#` cases have no dedupe key (§5.1) — would force claiming dedupe for unauthorized senders |
| Attempt 2 | Reject reason first, X2 without a claim; only X1 needs the claim. Leader rulings: legacy shim PENDING in guard 8 (owners N-05, N-08); `DISPATCH_INTERRUPTED` only via the reconciler request; X7 on elapsed ≥ 1,800 s **or** `lockWaitAttempts` ≥ 10 (§7.6), X14/X15 same facts. Falsifier (re-gating X2) → 5 failed. Evidence re-run (Leader): typecheck/lint clean, validate PASS, 116/116 — **VERIFIED** |
| Forward pointers | **N-10/N-12:** maintain `lockWaitAttempts`; own lock release at X6 and resource release at X14; reset `deadlineAt` at X5/X14 (§7.1). **N-05/N-06:** reuse `REJECT_REASONS` |
| Reviewer attempt 2 | **PASS** (`opus`): Issue 1 resolved; rulings (a)–(c) correct; no regressions. Committed snapshot (HEAD + N-04 only) checked in a clean worktree: typecheck 0 errors, guards PASS, vitest 474/474 |
| Status | **Done** |

### N-15 — attempt 1

| Field | Value |
|---|---|
| Attempt 1 | `--artifact <container>=<repo>@sha256:<64-hex>`; `validate_artifact_ref` in `parse_args` before effects (tags, bare repo, short/non-hex digest, `..`, leading `-`/`/` → exit 2); `--previous` validated the same; pull/run/previous by digest; pruning by digest; already-running-same-digest → exit 0 without migration/swap; shims fail loudly on non-digest pulls; 3 new cases; README updated. Suite 17/0, 1 assertion skipped (0600). Falsifier (validation disabled) → tag cases red |
| Evidence re-run (Leader) | `bash -n` OK; suite 17/0; Leader falsifier disabling the `--previous` validation → "--previous with a tag: expected exit 2, got 0", docker invoked, 1 failed; restored — **VERIFIED** |
| Deferred (environment) | `docker ps` image reporting for digest-started containers and `docker images --digests` pruning semantics → Gate C (T-33) |
| Reviewer attempt 1 | **FAIL** (`opus`): the previous image comes from `docker ps` unchanged, so a container started by tag (normal first deploy where Jenkins deploys by tag) is recorded, restored and pruning-compared by tag — violates DD-26 and FR-13 ("identified by digest", "never run by tag"). Probe: exit 30 restored `…app:123` |
| Leader ruling | Resolve the running image to `<repo>@sha256:<digest>` via image ID + matching RepoDigests; fallback without a matching RepoDigest = restore by image ID (content-addressed), reported as unresolved, never a tag. Also exclude ALREADY_CURRENT containers from restore |
| Attempt 2 | `resolve_running_image`: a `docker ps` value already in digest form is used as is; otherwise image ID → matching RepoDigest → `<repo>@sha256:<digest>`; no match → image ID marked `unresolved:sha256:<id>` (content-addressed, never a tag). Feeds RESTORE_IMAGE, previousImages, restore, already-running comparison and the pruning keep-set. ALREADY_CURRENT containers excluded from restore; README and §6.5/N-15 references updated; 3 new cases. Falsifiers (raw docker ps value stored; restore skip removed) → red. Evidence re-run (Leader): suite 20/0, 1 assertion skipped — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`): Issue 1 resolved (probe: tag-started container restored by image ID, never by tag); no regressions; genericity intact |
| Accepted deviation | `previousImages.<c> = "unresolved:sha256:<id>"` when no RepoDigest matches (DD-26 spirit: immutable, content-addressed; never a tag). Documented in the README |
| Committed snapshot | HEAD + `deploy-scripts/**` + the consumer `bundled-definition-source.test.ts` (T-14 update: script now exists): typecheck 0, lint clean, guards PASS, vitest 494/494 |
| Forward pointers | **N-08/N-09/N-12:** recognize the `unresolved:` prefix in `previousImages` and never treat it as a digest; runbook §12.2 mentions it. **Gate C (T-33):** real `docker ps`/`docker inspect`/RepoDigests/`rmi`-by-digest semantics; a container whose image cannot be inspected (today treated as absent). Advisory: empty-string `previousImages` on an already-current re-run without a hint; stray spaces at line 588 |
| Status | **Done** |

### N-07 — Supersede policy · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `domain/supersede-policy`: `compareOrdering` (OLDER/EQUAL/NEWER/DIFFERENT_SOURCE; equal never older; no cross-source order), `evaluateS1` (lastDeployed, highestDispatched, highestAccepted), `evaluateS2` (max of lastDeployed and highestDispatched only), `decideRaiseMax` (absent or `stored <= new`); invalid `runNumber` throws. `evaluateSupersede` deleted from lock-policy; guard 8 entry → DELETED. 22 tests mixing arrival and run order. Falsifier `<` → `<=` → 5 failed. Evidence re-run (Leader): 49/49; Leader falsifier (different-source check removed) → 4 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-07 only (guard file staged with the N-07 hunk alone, because N-05 shares it): typecheck 0, lint clean, guards PASS, vitest 493/493 |
| Forward pointers | **Callers (N-10/N-12):** map `REJECTED_SOURCE_MISMATCH` to an audited outcome; FR-23 notification and "listed as unresolved" clauses; build `sourceRef` identically everywhere (repository + workflow + environment, DD-27 item 1). **N-03:** two-sources startup validation. Advisory: `SUPERSEDED.by` names the first newer attribute, not the max |
| Status | **Done** |

### N-05 — Request contract, internal events and message router · done (commit together with N-02 and N-08)

| Field | Value |
|---|---|
| Attempt 1 | `domain/request-contract` (types, 8 KB UTF-8 limit before parsing, `requestIdMatches`, `consistentWithSource`), `application/message-router` (parse → eventType → authorize via `SenderAuthorizer` port → schema → requestId → lookup → consistency → handler); rejected `DEPLOY_REQUESTED` → X2 via `applyTransition` + ack; unparseable / unknown type / invalid internal event → no ack; per-type `oneOf` + `unevaluatedProperties: false` in `event.schema.json`; `domain/events`, normalizers, `test/fixtures/aws`, old router tests deleted. Falsifier (ack unparseable) → 7 failed. Evidence re-run (Leader): tsc 0, lint clean, validate PASS, 146/146; Leader falsifier (requestId check disabled) → red — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Rulings accepted: unknown/invalid internal events → DLQ; unauthorized internal sender acked; `workflowRef` exact equality (fail closed); handler errors → no ack; oversized `DEPLOY_REQUESTED` → DLQ (never parse oversized untrusted input) |
| Sequencing | N-08 (in progress) already removed the types-only `event-router/index.ts` shim that N-05 left for the frozen T-08 files and observability. N-05 cannot be committed alone without that shim → **N-02, N-05 and N-08 land in one commit** after N-08's review |
| Forward pointers | **N-24 / DD-29:** pin which GitHub value `ci.workflowRef` carries and what `source.workflowRef` resolves to (caller `workflow_ref` vs SHA-pinned `job_workflow_ref`, P-G11) before N-32, or every real request ends `CONSISTENCY_MISMATCH`. **N-06/N-10:** carry `senderId` (role-ID prefix only) as audit data into `EXEC#.senderRef` and rejection records; N-06 records the intended reason when an unknown `deploymentId` makes the authorizer fail first. **N-17:** remove leftover orphan vocabulary in observability if any remains after N-08 |
| Status | **Done** (commit pending with N-08) |

### N-20 — Infrastructure inventory and runbooks · done

| Field | Value |
|---|---|
| Attempt 1 | `infra/RESOURCES.md` rewritten for Model B (OIDC provider; per-repository/environment CI role with the DD-24 trust shape — six exact `StringEquals` keys, `job_workflow_ref` at `<PINNED_COMMIT_SHA>`, 1 h; queue policy with the DD-25 per-type rule; Scheduler target role; operator principal; reduced Executor role; GitHub-side configuration incl. admin-only `CICD_BOUND_REF`, secrets only, SHA-pinned actions; DynamoDB items/TTLs; alarms); `docs/runbook.md` (§12.1 kept, §12.2 resolution procedure with the OD-A8 boundary), `docs/resources.md`, `docs/jenkins-coexistence-log.md`. Checklist derived from design §11/§5/§12: 77 items. Red run vs HEAD: 40+ missing; mutations (StringLike `sub`, `job_workflow_ref@*`) → 3 and 2 failed. Evidence re-run (Leader): 77/0, publication scan 0, Leader mutation → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, checklist) |
| Spec gap recorded | FR-17 requires an alarm for executions past their deadline, but design §12 names no metric; `ExecutionsPastDeadline` is a placeholder name. Owner: **N-14** (reconciler) emits it; design §12 to be amended in the Gate A closure spec sync |
| Forward pointers | **N-24 (Gate B):** the queue policy needs an explicit `Deny` for principals outside the four (an `Allow` alone does not block same-account IAM principals); CI role states DEV-only scope; shared `<ECR_REPOSITORY>` across environments recorded as residual (P-7 / OD-A7); operator principal is a role (no static keys); add `ecr:BatchGetImage` only if digest capture needs it. **N-11:** deliver `tools/resolve-target` (design §12.2 has a stray space: `tools/ resolve-target`) and mark it in runbook step 6. Removals list to name `<WEBHOOK_SECRET_REF>` (editorial) |
| Status | **Done** |

### N-03 — DefinitionService rework · done (lands in the combined N-02/N-03/N-05/N-08 commit)

| Field | Value |
|---|---|
| Attempt 1 | Port `getDeploymentDefinition`; `validateForCi`/`validateForStartup` on `deployment.schema.json` + `targets.schema.json` with the contract-test Ajv options; issues name the field; step-graph rules removed; new semantic rules (id match, unique unit/container, targetRef exists, migration requires `migrationCompatibility` + `attestedBy`); single-source rules (`lock-key-multiple-deployments`, `deployment-duplicate`; bundled source rejects duplicate ids); identifier refs resolved at startup (allowedSenderRef, source.*Ref, principal refs from the composition root); credential refs existence-only; `runtimeSecretRefs` values never touched. Deleted the pipeline schema, `pipeline-definitions/`, the pipeline contract test and the substitution test. Out of brief, to keep the build green: guards 3 and 6 retargeted to the deployment schema, `schema-paths.ts`, Dockerfile COPY path. Falsifier (one-per-lockKey rule off) → 2 failed. Evidence re-run (Leader, full tree): tsc 0, lint clean, validate PASS, vitest 590/23 skipped — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Rulings: guard edits acceptable (N-19 keeps the rename, guard 7 and negatives; the NFR-08 fixture rework is already done); principal-ref location is a spec gap; lockKey compared as the logical key is the real lock identity; substitution test deletion is what the task asked; `runtimeSecretRefs` untouched and Slack token existence-only are correct |
| Forward pointers | **N-17:** read principal refs from configuration (not hard-coded); look definitions up only from the validated startup result or enumerate them, so no unvalidated definition is served. **N-19:** rename guard 3 file to `deployment-schema-expressions`, add guard 7. Editorial: stale comment in `targets-schema.contract.test.ts`, the targets YAML comment citing an unpublished source; FR-01 lists `lockKey` but §6.2 keeps it in the registry (spec sync at closure) |
| Status | **Done** (commit pending with N-08) |

### N-08 — DynamoDB store reduction · done

| Field | Value |
|---|---|
| Attempt 1 | Step, step-attempt-lookup and instance-lease repositories deleted; keys per §5.1 (`DEDUPE#{deploymentId}#{requestId}`, `REJECT#…`, `DEPLOYMENT#…/SEQ`); execution-level `ExecutionItem` with conditional `update` (status + version, plus `dispatchToken`); GSI1 dropped, sparse GSI2 kept; new rejection repository (attribute_not_exists, 30 d TTL); legacy-vocabulary and event-router shims removed (observability seam types inlined). Integration (DynamoDB Local, Java 17, no Docker): 7 files / 23 tests, race 50 × 5 writers → one winner per round. Falsifier `version >=` → "expected 5 to be 1". Evidence re-run (Leader, full tree): tsc 0, lint, validate, vitest 590; integration 23/23 PASS, but the runner never exited (timeout, exit 124) |
| Reviewer attempt 1 | **FAIL** (`opus`): (1) the integration runner never exits and leaks one JVM per run — on Windows `child.kill()` ends only the javapath shim, the real jdk JVM keeps the pipes open; (2) Spanish text in landed files (comments and one runtime error message) |
| Environment cleanup | Leader stopped 5 leaked DynamoDB Local JVMs (command line under `executor\.local\dynamodb-local` only); no other java process touched |
| Attempt 2 | `stop()` kills the process tree (`taskkill /T /F`; POSIX process group) and waits for the port to close; stdout ignored; new `dynamodb-local-lifecycle.int.test.ts`; Spanish removed; `create()` and `update()` share `assertSparseIndexCovenant` + test. Evidence re-run (Leader): tsc 0, lint, validate, vitest 590 / 25 skipped; `npm run test:integration` exits 0 by itself in 14 s, 8 files / 25 tests, race min=max=1; no DynamoDB Local JVM left; no Spanish — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Forward pointers | **N-09:** replace `lastDeployedSequence` with the ordering fields. **N-16/N-17:** remove pre-AC-01 step names left in observability (`stepId`, `STEP_NOT_FOUND`, `recordStepDuration`, orphan vocabulary). **N-22 / CI (OD-N1):** treat the integration runner SKIP path as a failure in CI; confirm the POSIX kill path on the first Linux run |
| Landing | One combined commit with N-02, N-03 and N-05 (shared files: guard 8, `schema-paths.ts`, the definition port; splitting would require hand-built intermediate versions). The full working tree was verified green before the commit |
| Status | **Done** |

### N-06 — Sender authorizer · done

| Field | Value |
|---|---|
| Attempt 1 | `createSenderAuthorizer` with the router's port shape; per-type rule (DEPLOY_REQUESTED ← that deployment's allowedSender; LOCK_RETRY_REQUESTED ← Executor; RECONCILE_TICK ← scheduler; DEPLOY_WINDOW_* and TARGET_RESOLUTION_RECORDED ← operator); role-ID prefix only, session discarded, body never an input; fail-closed reasons; `decide()` returns `{authorized, senderRef, reason}`. 26 tests. Falsifier (stub authorizing from `ci.repository`) → 3 failed. Evidence re-run (Leader): 67/67; Leader falsifier (RECONCILE_TICK mapped to CI) → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): metric emitted as `UnauthorizedSender`, but design §12 and DD-25 define `RejectedRequests` by reason with the alarm on `RejectedRequests{UNAUTHORIZED_SENDER}` — the specified alarm would never fire |
| Forward pointers | **N-17:** widen the router port to `decide()`, write `senderRef` into `REJECT#…` and `EXEC#…` (FR-21 audit); decide whether to log the session suffix as labeled untrusted audit data; avoid double-counting rejections |

### N-09 — Target state with ordering and fencing · done

| Field | Value |
|---|---|
| Attempt 1 | `TargetStateRepository` rewritten (replaces `lastDeployedSequence`): `recordDeployed` fenced `token >= stored`, refuses a different source, opaque previous images (`unresolved:` marker); `highestDispatchedUpdate` (Update spec for the X9 transaction, `stored <= new`, unfenced) and standalone raise; `raiseHighestAccepted` as a separate conditional update after X1 (E2; tasks text was stale); `unresolvedAppendUpdate` for X16; `removeUnresolved` never touches ordering fields. Ordering via `decideRaiseMax` (N-07). 14 integration tests, 60-rep races. Falsifier (condition removed) → 8 failed. Evidence re-run (Leader): integration exit 0, 8 files / 37 tests, no JVM left — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full): token order implies run order under S2 + the X9 condition, so the fence alone keeps `lastDeployed` monotonic |
| Committed snapshot | HEAD + N-09 files: tsc 0, lint, guards PASS, vitest 590 / 37 skipped |
| Forward pointers | **N-12:** owns the lock-owner half of the §5.1 `lastDeployed` condition (check ownership before `recordDeployed`, or request a transaction builder); assert the companion `Put` is absent when the X9 transaction is cancelled. Editorial (closure spec sync): design §5.1 line still says `highestAccepted` is written in the X1 transaction; tasks N-09/N-10 scope text likewise |
| Status | **Done** |

### N-11 — Deploy windows: service and operator CLI · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `domain/window-policy` (all external deployers covered, ≤ 8 h, `none` ⇔ `not-required`, fail-closed `isDeployAllowed`); `deploy-window-service` (idempotent open/close; `revalidate` V1→X4, V2→X8, V3→X15, V4→X10, fail-fast, never waits); `TargetResolutionService` (Executor-side preconditions; audit before the single conditional `removeUnresolved`; ports cannot write ordering fields or terminal states); operator CLI core in `executor/src/operator-cli` with `tools/deploy-window` and `tools/resolve-target` wrappers. 52 tests. Falsifier (coverage check disabled) → 3 failed. Evidence re-run (Leader): 52/52; Leader falsifier (8 h → 9 h) → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-11 files: tsc 0, lint, guards PASS, vitest 642 / 37 skipped |
| Forward pointers | **N-17:** real SQS publisher adapter for the operator CLI (today it refuses unless `--dry-run`); pass `senderId` to the resolution handler; adapters for `TargetPolicyLookup`, `UnresolvedStore`, `ExecutionLookup`, `LockOwnerLookup`, `ResolutionAuditWriter`. **N-14:** the reconciler's GSI2 sweep closes expired open windows. Advisory: redelivered resolution after success could return an idempotent `ALREADY_RECORDED`; runbook line "close, then reopen" to extend a window |
| Status | **Done** |
| Attempt 2 (N-06) | `Metrics.recordRejectedRequest(reason)` emits `RejectedRequests` = 1 with dimension `reason` (design §12); `UnauthorizedSender` removed; the authorizer records `UNAUTHORIZED_SENDER` on every rejection; tests assert name, value and EMF dimensions; prototype-key test; redundant guard removed. Falsifier (old name) → 2 failed. Evidence re-run (Leader): 70/70; Leader falsifier (`in` instead of own-property) → prototype test red — **VERIFIED** |
| Reviewer attempt 2 (N-06) | **PASS** (`opus`). Leader alignment: `infra/RESOURCES.md` alarm row now names `RejectedRequests{reason=UNAUTHORIZED_SENDER}` (checklist 77/0) |
| Committed snapshot (N-06) | HEAD + N-06 files: tsc 0, lint, guards PASS, vitest 671 / 37 skipped |
| Status (N-06) | **Done** |

### N-10 — Identity, dedupe and execution creation · done

| Field | Value |
|---|---|
| Attempt 1 | `createExecutionService` → `deployRequested` / `rejected`: catalog lookup and unit-set equality (X2 `UNKNOWN_DEPLOYMENT` / `CONSISTENCY_MISMATCH`, no claim, no sequence) → DD-20 leased claim (BOUND → no-op; live foreign claim → not acked; expired → conditional takeover reusing the stored sequence) → sequence after the claim → X1 → bind → separate `highestAccepted` raise (E2) → S1/X3. Rejection records `REJECT#{dep}#{req}` or `REJECT#MSG#{sqsMessageId}`; `senderRef` stored as audit data. One injective `buildSourceRef` helper (`repository=…;workflow=…;environment=…`, percent-encoded). 27 unit + 7 integration tests (50 reps × 8 contenders → one execution, sequence 1; CC-2 pre-claim). Falsifier (sequence before claim) → "expected 9 to be 1". Evidence re-run (Leader): 27/27; integration exit 0, 9 files / 44 tests — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Redelivery table matches DD-20 incl. R2-I3; 120 s lease = DD-20's "now + 2 min" |
| Committed snapshot | HEAD + N-10 files: tsc 0, lint, guards PASS, vitest 698 / 44 skipped |
| Forward pointers | **N-17:** adapter from `TargetStateRepository` (`raiseHighestAccepted` → `{raised}`) to the `TargetOrderingPort` (`{accepted}`) and `readOrdering` from `get()`, with one integration test on the real repository; `DeploymentCatalog` over DefinitionSource; supply `senderRef` and `sqsMessageId` from the router. **N-12 / N-09 consumers:** import `buildSourceRef` — never rebuild the string. **N-19 (optional):** grep guard that no other module builds `repository=` strings. Advisory: consistent reads in `DedupeRepository.get`; tests for concurrent expired-claim takeovers and the `recordSequence` fallback; JSDoc on the lease constant citing DD-20 |
| Status | **Done** |

### Incident — staged rename leaked into commit 2f0031a (2026-10-06)

| Field | Value |
|---|---|
| What happened | N-19's in-progress `git mv` (guard 3 rename) was already staged in the index when the Leader staged and committed N-10 by explicit paths; `git commit` took the whole index, so 2f0031a contained the rename without its importer updates. `npm run validate` and `boundary-guards.test.ts` were broken at HEAD (pushed) |
| Detection | The clean-worktree check for N-18 (HEAD + N-18 files) failed on a module-not-found in `boundary-guards.test.ts` |
| Fix | Hotfix 5a39c58: import path updated in `run-all.mjs` and `boundary-guards.test.ts` (HEAD versions, path only); worktree check tsc 0, guards PASS, vitest 698 / 44 skipped. A staged deletion from N-12 (`ports/step-handler.ts`) was also unstaged before it could leak |
| Process change | Before every commit: the index must be empty before staging (`git diff --cached` empty), and the staged list must equal the task's list. Implementers must not stage (`git mv`/`git rm` → plain file operations) |

### N-18 — Dockerfile and image inspection without git · done

| Field | Value |
|---|---|
| Attempt 1 | `git` removed from the runtime stage (only `ca-certificates`); guard 1 rule `forbidden-package:git` (comment lines stripped); `inspect-image.mjs` `FORBIDDEN_NAMES` includes `git` (command -v, find -name, node_modules). Tests: real Dockerfile clean; three git fixtures red. Red run before the change → `final stage installs git package`. Evidence re-run (Leader): tests green, tsc 0; Leader falsifier (git re-added) → guard 1 red, restored → PASS. `npm run inspect:image` → **DEFERRED** (no Docker daemon; environment-dependent, mandatory before deployment) — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`) |
| Committed snapshot | HEAD (after hotfix 5a39c58) + N-18 files: tsc 0, lint, guards PASS, vitest 703 / 44 skipped |
| Deferred (environment) | Real image inspection incl. the git falsifier fixture (`npm run inspect:image -- --dockerfile test/fixtures/dockerfiles/Dockerfile.falsifier-git`) on a Docker-capable host; a file named exactly `git` in the image must be triaged |
| Status | **Done** |

### N-16 — Notifications (Slack) · done

| Field | Value |
|---|---|
| Attempt 1 | `notification-service` per design §6.6: ACCEPTED root; replies SUPERSEDED, DEPLOY_WINDOW_CLOSED, LOCK_TIMEOUT, DEPLOY_FAILED(code), UNKNOWN_TARGET_STATE (runbook link), SUCCEEDED (root rewritten with outcome/duration); REJECTED to the platform channel (reason + sender ref only); no CI notifications (OD-A5). `EVT#` claim before send (best-effort, at-most-once); `notify` never rejects; failures logged with redaction + `NotificationFailures{provider}`. Slack provider via injectable HTTP client (Node fetch), token from `SecretProvider` at point of use, never logged. Observability cleanup: pre-AC-01 step/orphan/retry-later names removed; Slack token redaction pattern added. Falsifier (EVT# check removed) → two messages. Evidence re-run (Leader): suites green, tsc 0 — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-16 files: tsc 0, lint, guards PASS, vitest 719 / 44 skipped |
| Forward pointers | **N-17:** wire the service (callers, `slackThreadTs` persistence, `resolveChannel`, real `EventMarkRepository`, always supply `logsUrl` + test; platform channel/token refs for REJECTED; mark key for rejections must reuse the rejection identity `{deploymentId}#{requestId}` or `MSG#{sqsMessageId}`). **Closure spec sync:** add `NotificationFailures{provider}` and the rejection event-mark key shape to design §12/§5.1; reconcile §12 metric names (`ExecutionsAccepted`, `ExecutionsSuperseded`, `DeployDurationMs` vs code). Advisory: dedicated Slack-token entry in the redaction corpus |
| Status | **Done** |

### N-19 — Guards retarget and guard 7 "action-pinning" · done

| Field | Value |
|---|---|
| Attempt 1 | Guard 3 renamed to `deployment-schema-expressions`; guard 4 also walks `.github/workflows/`; new guard 7 `action-pinning` (YAML-parsed `uses:` at step and job level; full 40-hex SHA, `docker://…@sha256:<64-hex>`, `./` local; masked values; absent workflow → PASS with note); obsolescence scan roots fixed (`executor/scripts` added, stale roots removed, `vi.doMock`/`vi.importMock`). Evidence re-run (Leader): 56/56, validate PASS; Leader probe in a temp dir: `@v4` flagged, pinned SHA accepted — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): the local exemption `/^\.\.?\//` also accepted `../evil` — DD-29 allows only `./` |
| Attempt 2 | `LOCAL_REF = /^\.\//`; case-insensitive `uses` keys; `*.reusable.yaml` scanned too; strict mode (`--require-workflow` / `CICD_REQUIRE_REUSABLE_WORKFLOW=1`) fails when no reusable workflow exists; unused import removed. The implementer's `../` falsifier was blocked by the permission classifier (it would weaken a repo file); the Reviewer ran it on a scratch copy: loosened regex accepts `../evil`, so the new test would go red. Evidence re-run (Leader): 60/60, lint 0 warnings, validate PASS, strict mode fails as designed — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Committed snapshot | HEAD + N-19 files (guard 8 file staged with the N-19 hunks only; the N-12 `step-handler` line stays PENDING until N-12 lands): tsc 0, lint, guards PASS, vitest 748 / 44 skipped |
| Forward pointers | **N-22 and CI (OD-N1):** run `validate` with `--require-workflow`. **N-21:** avoid local actions and local job-level calls in the trusted workflow (nested workflows not named `*.reusable.*` are not scanned), or forbid them in its contract test. **Closure spec sync:** record the owner's wording that the trailing version comment is "where useful" in DD-29 |
| Status | **Done** |

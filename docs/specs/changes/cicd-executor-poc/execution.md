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

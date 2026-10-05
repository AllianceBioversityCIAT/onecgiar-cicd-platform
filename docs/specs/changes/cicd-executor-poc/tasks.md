# Tasks — CI/CD Executor PoC (PRMS Reporting DEV)

> **En una línea:** 37 tareas en cuatro gates. Las **23 de Gate A** (T-00 a T-22) se pueden implementar ya: núcleo, contratos, handlers con dobles de prueba, script de deploy y tests locales. Las 9 de Gate B y las 5 de Gate C están **bloqueadas** por decisiones abiertas o premisas `UNVERIFIED` que aquí no se resuelven. Gate D (retirar Jenkins) queda fuera del PoC y solo se registra.

---

## 1. Document Control

| Campo | Valor |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Fase | Phase 3: Tasks |
| Fuentes de verdad | `proposal.md` (aprobado), `requirements.md` (aprobado), `design.md` v3.1 (APPROVED por Judgment Day + ajustes editoriales autorizados), `judgment.md` |
| Repositorio | `AllianceBioversityCIAT/onecgiar-cicd-platform` (design §4.1). Se commitea **solo** en `/akili-execute`, con aprobación del owner |
| Política de publicación | Sin identificadores internos en Git (design §4.1, DD-23). Los valores reales se resuelven fuera de Git |
| Archivos solo locales | `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` y `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`: van a `.gitignore` en T-00 y se verifican antes de **cada** commit con `git status` + `git ls-files` |
| Approval Mode | `gated` |
| Plantillas | No hay `general-setup`; se usa la estructura del comando |

**Regla de frontera (NFR-01), aplicada a cada tarea:** el Executor coordina; no compila, no construye imágenes, no ejecuta migraciones localmente, no se conecta a BD, no contiene lógica de aplicaciones ni de proyectos, no interpreta expresiones y no se convierte en otro Jenkins. Si una tarea lo requiriera, se detiene y se escala (Pivot Protocol).

---

## 2. Resumen por gate

| Gate | Tareas | Estado |
|---|---|---|
| **A**: núcleo implementable | T-00 a T-22 (23) | **Ejecutables** tras la aprobación del owner. T-20 es SHOULD |
| **B**: infra y despliegue DEV | T-23 a T-31 (9) | **Bloqueadas** por OD-Q11, OD-Q12, OD-Q7, OD-Q13, OD-Q15, OD-N1 y las premisas P-1, P-2, P-7, P-8, P-8b, P-9, P-10, P-11, P-15 a P-19 y P-22 |
| **C**: E2E en el target DEV | T-32 a T-36 (5) | **Bloqueadas** por OD-Q5 y las premisas P-3 a P-6, P-13, P-14, P-23, P-24, además de la ventana, SSH, migración y snapshot |
| **D**: retirar Jenkins | D-1 a D-8 (registro) | **Fuera del PoC**; iniciativas separadas |

**Decisión abierta nueva (detectada en esta fase, no resuelta):** **OD-N1**, qué sistema de CI corre los tests y la validación del propio repo `onecgiar-cicd-platform`. No bloquea Gate A: la validación se aplica también al construir la imagen y al arrancar (design §7.7, DD-23), y los tests corren localmente. Bloquea solo T-31.

---

## 3. Orden recomendado y estrategia de PRs

| PR | Tareas | Contenido | Revisar primero |
|---|---|---|---|
| PR-1 | T-00, T-01, T-02 | Repo, `.gitignore`, esqueleto, schemas y definición semántica | `.gitignore` y schemas |
| PR-2 | T-03, T-04, T-05, T-06, T-07 | Definiciones, máquina de estados, planner, política de lock y eventos (dominio puro) | §7.3 (T1–T13) en T-04 |
| PR-3 | T-08, T-09, T-10, T-11, T-12 | Persistencia, identidad, despachador, reconciler y ventanas | Escrituras condicionales en T-08 |
| PR-4 | T-13, T-14, T-15 | Handler SSH, deploy script y fuente | Tabla de recursos §7.5 y orden del script |
| PR-5 | T-16, T-17, T-18, T-19 | Notificaciones, observabilidad, consumidor + bootstrap, handlers Lambda y CodeBuild | Reglas de ack y heartbeat |
| PR-6 | T-20, T-21, T-22 | Webhook (SHOULD), guardas de frontera, inventario de infra y runbooks | Guardas NFR-01 |
| PR-7+ | Gate B (T-23 a T-31) | Uno por tarea, a medida que se resuelvan sus bloqueos | — |
| PR-n | Gate C (T-32 a T-36) | Operativos, principalmente documentos y registros | — |

```text
T-00 → T-01 → T-02 → T-03 ─┬→ T-05 ─┐
                  T-04 ────┼→ T-06 ─┼→ T-08 → T-09 → T-10 → T-11 → T-12
                  T-07 ────┘        │                 │
                                    └→ T-13 (+T-14) ──┴→ T-15 → T-16 → T-17 → T-18 → T-19
T-14 (script) puede avanzar en paralelo desde T-01 · T-20 desde T-07 · T-21/T-22 al final de Gate A
Gate B: T-23 → T-24 → T-25 → T-26 → {T-27, T-28, T-29} → T-30 · T-31 independiente (OD-N1)
Gate C: T-32 → T-33 → T-34 → T-35 → T-36
```

**Estimación total:** ~8.700 LOC (Gate A ~7.900; Gate B ~700 de infra según OD-Q7; Gate C casi solo documentos). Supera las ~400 LOC, así que **se implementa en varios PRs**, como arriba. Cada descripción de PR indica qué revisar primero, qué queda fuera y enlaza el PR anterior y el siguiente.

**Tareas `skip-eligible`: ninguna.** Todas llevan revisión de conformidad.

---

## 4. Convenciones de cada tarea

- **Verificación:** cada tarea nombra su *Falsifier* (la mutación que debe poner rojo el gate). Su *Red run* se **observa y se cita** en la ejecución, no se predice. Como el código no existe todavía, la línea base roja es la primera observación de la tarea.
- **Primer paso:** si una tarea es dueña de una premisa `UNVERIFIED` (design §11), la resuelve **antes** de construir. Si la refuta, se aplica el Pivot Protocol.
- **Datos sensibles:** ningún test, fixture ni documento versionado contiene identificadores internos reales; se usan referencias lógicas.
- **Commits:** solo en `/akili-execute`, con aprobación. Antes de cada commit: `git status` + `git ls-files` sin los dos archivos de análisis.

---

## 5. Gate A: implementable ya

### T-00 — Vincular el workspace al repositorio canónico y excluir el análisis local
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · S · **A** |
| Objetivo | Dejar el workspace ligado a `onecgiar-cicd-platform`, con `.gitignore` creado **antes** de cualquier otro archivo versionado y los dos archivos de análisis fuera de Git |
| Depends on | — |
| Requisitos / Diseño | NFR-02, NFR-10 · design §4.1, §4.2, P-25, P-26 |
| Archivos | `.gitignore`, integración del commit inicial del remoto |
| Primer paso | Resolver **P-26**: obtener el remoto (`main` @ `41f4c3e`), inspeccionar el commit inicial y reportar conflictos con la estructura de §4.2 antes de continuar |
| Alcance | Incluye: vincular (clonar o `init` + fetch), integrar el contenido existente, `.gitignore` con ambos nombres y los secretos locales habituales. Excluye: cualquier push sin aprobación |
| Tests / verificación | `git status` y `git ls-files \| grep -c "JENKINS_REPLACEMENT_"` = 0; `git check-ignore` devuelve ambos archivos; los archivos siguen existiendo en disco |
| Falsifier | Quitar una línea del `.gitignore` → `git status` muestra el archivo como no trackeado → el gate falla |
| Red run | Observar el estado antes de crear `.gitignore` (ambos archivos visibles en `git status`) |
| Disqualifier | Si el remoto trae un `.gitignore` propio que se pisa en lugar de fusionarse, la evidencia no vale |
| Consumers | none |
| Review | checklist: archivo de seguridad crítico pero pequeño |
| Done | Ambos archivos ignorados y no trackeados; P-26 resuelta y registrada; ningún commit hecho sin aprobación |
| Skills | — |

### T-01 — Esqueleto del proyecto Executor y puertos
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done (local)**, validación por entorno DIFERIDA (Docker) · M · **A** |
| Objetivo | Proyecto TypeScript estricto con la estructura hexagonal de §4.2, interfaces de puertos y un `Dockerfile` mínimo **sin toolchains de build de aplicaciones** |
| Depends on | T-00 |
| Requisitos / Diseño | NFR-01, NFR-08 · DD-01, DD-05, DD-15, §4.2, §3.2 |
| Archivos | `executor/package.json`, `tsconfig`, `executor/src/ports/*` (StateStore, ArtifactStore, QueuePublisher, DefinitionSource, SecretProvider, GitClient, StepHandler, NotificationProvider, Clock), `executor/Dockerfile`, configuración de lint y tests |
| Alcance | Excluye implementaciones de adaptadores |
| Tests / verificación | type-check + lint + suite vacía verde; build de la imagen; inspección de que la imagen no tiene `npm` de build de aplicaciones, `mvn`, CLI de Docker ni socket montado |
| Validación por entorno (decisión del owner, 2026-10-05) | **Local, sin Docker (gate de T-01 en Gate A):** `npm install`, typecheck, lint, build de TypeScript, tests unitarios y de integración que no requieren Docker, chequeo de dependencias, inspección estática del Dockerfile y guardas NFR-01 con sus fixtures negativos. **Diferida por entorno, obligatoria antes de desplegar en el servidor de microservicios:** `docker build`, inspección de la imagen en ejecución (`npm run inspect:image`, incluidos los fixtures de falsificación), verificación NFR-01 en runtime, arranque y salud del contenedor. Los criterios de Docker **no se eliminan ni se debilitan**: se reclasifican como dependientes del entorno. No se añaden a la imagen runtime npm, CLI de Docker ni toolchains para facilitar el desarrollo local |
| Falsifier | Añadir la CLI de Docker al `Dockerfile` → la inspección de frontera falla |
| Red run | Ejecutar la inspección con una imagen base que incluya la CLI de Docker y citar la salida roja |
| Disqualifier | Un type-check que pasa con `skipLibCheck` sobre puertos mal tipados no es evidencia: los puertos deben compilar sin desactivar la comprobación |
| Consumers | none (código nuevo) |
| Review | full: fija la frontera de toda la base de código |
| Done | Estructura creada; puertos compilan; inspección de imagen verde; DD-15 aplicada (o el cambio de framework, si el owner lo decide antes) |
| Skills | `tdd`, `error-handling-patterns` |

### T-02 — Schemas versionados y definición semántica de PRMS Reporting DEV
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · M · **A** |
| Objetivo | `pipeline.schema.json`, `targets.schema.json` y `event.schema.json`, más `pipeline-definitions/prms/reporting-dev.yaml` y `targets/dev.yaml` **solo con referencias lógicas** (DD-23) |
| Depends on | T-01 |
| Requisitos / Diseño | FR-01, FR-02, FR-04 · design §6.1, §7.7, DD-11, DD-21, DD-23, proposal §10.4 |
| Archivos | `schemas/*.schema.json`, `pipeline-definitions/**` |
| Alcance | Incluye: tipos de step cerrados (PoC y reservados), `needs`, `finally`, `timeoutMinutes`, interpolación de lista blanca, `deployWindowPolicy` y `externalDeployersRef`/`none` obligatorios, `migrationCompatibility` con `attestedBy`, `connectionRef`/`hostKeyRef`. Excluye: valores reales de host, puertos, contenedores, repos ECR o jobs |
| Tests / verificación | Validación de ejemplos válidos y de un corpus negativo (tipo desconocido, expresión, `environment: prod`, política omitida, `not-required` con referencia, migración sin atestación, valor de secreto en línea) |
| Falsifier | Hacer opcional `deployWindowPolicy` → el caso negativo "política omitida" pasa → el gate falla |
| Red run | Ejecutar el corpus negativo contra un schema que todavía no tiene la regla y citar qué casos pasan indebidamente |
| Disqualifier | Si el corpus negativo no contiene cada regla de FR-01 y FR-02 (un caso por regla), un verde no prueba nada |
| Consumers | none |
| Review | full: es el contrato de todo el sistema |
| Done | Schemas y definición válidos; corpus negativo rojo uno por uno; `grep` de identificadores internos sobre `pipeline-definitions/` = 0 |
| Skills | `api-design-principles` |

### T-03 — `DefinitionSource` y validación semántica
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · M · **A** |
| Objetivo | Puerto `DefinitionSource` con adaptador `bundled-definition-source` y `definition-service`, que valida reglas semánticas y produce `definitionRef` |
| Depends on | T-02 |
| Requisitos / Diseño | FR-01, FR-02, NFR-08 · DD-19, DD-23, §7 (`definition-service`), §7.7 |
| Archivos | `application/definition-service`, `adapters/bundled-definition-source` |
| Alcance | Incluye: ciclos, `needs` inexistentes, tipos reservados rechazados, interpolación fuera de la lista blanca, `environment ≠ dev`, puertos o nombres duplicados por host (sobre los nombres lógicos y los resueltos), host key ausente, política de ventana coherente, atestación de migraciones, modo "validar en CI" (estructura) y modo "validar al arrancar" (resolución de referencias con un `SecretProvider` falso). **El núcleo no lee archivos directamente** |
| Tests / verificación | Unit: cada regla; test de que planner y handlers dependen solo del puerto (sustituir el adaptador por uno en memoria y que nada cambie) |
| Falsifier | Que `definition-service` lea `pipeline-definitions/` del sistema de archivos sin pasar por el puerto → el test de sustitución falla |
| Red run | Ejecutar el test de sustitución con un acceso directo al sistema de archivos y citar el fallo |
| Disqualifier | Un fixture con un solo target no puede revelar duplicados de puertos: debe haber ≥ 2 targets en el mismo host lógico |
| Consumers | none |
| Review | full |
| Done | Todas las reglas rojas en su caso negativo; arranque abortado con un registro inválido o una referencia sin resolver; `definitionRef` presente en el resultado |
| Skills | `tdd` |

### T-04 — Máquina de estados: lista cerrada T1–T13
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · M · **A** |
| Objetivo | Implementar exactamente las transiciones de design §7.3, con sus guardas, la única vuelta atrás T9 (solo `ssh` y solo con código 50), T10 (nunca `ssh`), T13 (mismo token; solo `codebuild`/`lambda`; una vez) y la regla canónica `LOCK_TIMEOUT` |
| Depends on | T-01 |
| Requisitos / Diseño | FR-05 (todos los escenarios, incluida "única vuelta atrás"), FR-11 (`AND IT MUST` canónico), FR-16 (F4–F7, F11–F13, F16–F19) · §7.3, DD-03 |
| Archivos | `domain/state-machine`, `domain/errors` |
| Alcance | Excluye I/O. Estados de ejecución y de step de FR-05; terminales inmutables; `INVALID_TRANSITION` |
| Tests / verificación | Tabla exhaustiva: **todos** los pares (origen, destino, tipo) → solo los 13 permitidos aceptan; T9 con cualquier código ≠ 50 se rechaza; T9 en `DISPATCHING` se rechaza; T10/T13 para `ssh` se rechazan; `WAITING_LOCK` vencido solo admite `FAILED(LOCK_TIMEOUT)` |
| Falsifier | Permitir `RUNNING → WAITING_LOCK` con código 40 → el caso exhaustivo correspondiente se pone verde indebidamente y el test rojo lo detecta |
| Red run | Primero se escribe la tabla de pares completa contra una máquina vacía (todo rechazado) y se cita qué pares permitidos fallan |
| Disqualifier | Un test que solo cubre las transiciones permitidas no prueba que las demás se rechacen: debe recorrer el producto cartesiano completo |
| Consumers | none |
| Review | full: es el corazón de la corrección |
| Done | Producto cartesiano cubierto; mutaciones de guardas en rojo; cada escenario de FR-05 mapeado a un test |
| Skills | `tdd` |

### T-05 — Planner (DAG, fan-in, skip en cascada, finally)
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · M · **A** |
| Objetivo | Función pura: estados de steps + definición → acciones |
| Depends on | T-03, T-04 |
| Requisitos / Diseño | FR-06 (paralelismo, fan-in, fallo de dependencia, finally y su `BUT`), FR-16 F5 · DD-06 |
| Archivos | `domain/planner` |
| Tests / verificación | Grafo PRMS (server/client ∥, fan-in en `deploy`), cascada de `SKIPPED`, `finally` una sola vez, un fallo de `finally` no cambia el terminal, `when` reservado rechazado en el PoC |
| Falsifier | Que el planner emita `deploy` cuando solo uno de los dos builds está `SUCCEEDED` → test de fan-in rojo |
| Red run | Fixture con un solo build terminado; citar la acción emitida antes de la corrección |
| Disqualifier | Un grafo lineal no puede revelar errores de paralelismo ni de fan-in: el fixture debe tener ramas paralelas y una unión |
| Consumers | none |
| Review | full |
| Done | Todos los escenarios de FR-06 con tests y mutaciones en rojo |
| Skills | `tdd` |

### T-06 — Política de lock: lease, fencing, supersede y calendario de espera
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · S · **A** |
| Objetivo | Lógica pura de DD-09 y §7.6: cálculo de retrasos (≤ 900 s, recorte al restante), espera acumulada sobre `lockWaitStartedAt`, tope de 10 intentos, supersede, propiedad y renovación |
| Depends on | T-01 |
| Requisitos / Diseño | FR-11 (todos los escenarios y la regla canónica), FR-16 F17–F18 · DD-09, §7.6 |
| Archivos | `domain/lock-policy` |
| Tests / verificación | Calendario exacto 30/60/120/240/480/870; 7 intentos y 6 reencolados sin contención; con 50 retoma el siguiente valor; ningún retraso > 900; a ≥ 1.800 s → `LOCK_TIMEOUT`; supersede con secuencia mayor |
| Falsifier | Cambiar el tope a 1.000 s → el test "ningún retraso > 900" se pone rojo |
| Red run | Ejecutar los tests contra un calendario sin recorte y citar el retraso de 900 que excede el presupuesto |
| Disqualifier | Medir la espera como suma de retrasos (y no como `now − lockWaitStartedAt`) da una aprobación falsa: el test inyecta un reloj con latencia adicional |
| Consumers | none |
| Review | full |
| Done | Calendario y bordes verificados con reloj inyectado |
| Skills | `tdd` |

### T-07 — Sobre de eventos, normalización y eventos huérfanos
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · M · **A** |
| Objetivo | Tipos y validación del sobre (§6.1); normalizadores de Lambda Destinations y de EventBridge CodeBuild; detección de `ORPHAN_EVENT` |
| Depends on | T-02 |
| Requisitos / Diseño | FR-04 (sobre válido, resultados nativos y su `AND IT MUST` de correlación, envenenado, huérfano), FR-07 · §6.1 |
| Archivos | `domain/events`, `application/event-router` |
| Tests / verificación | Fixtures **sintéticos** de las formas de AWS, marcados como provisionales hasta T-27 y T-28 (P-17, P-18); un evento de un intento anterior → huérfano sin efectos; un mensaje malformado → error que provoca la no confirmación |
| Falsifier | Correlacionar solo por `executionId` (ignorando `externalRef`) → el test de intento anterior se pone rojo |
| Red run | Fixture con un `buildId` de un intento previo; citar la mutación de estado indebida |
| Disqualifier | Los fixtures sintéticos no prueban las formas reales de AWS: las tareas T-27 y T-28 las reemplazan por capturas reales saneadas |
| Consumers | none |
| Review | full |
| Done | Todos los escenarios de FR-04 cubiertos; los fixtures provisionales quedan anotados |
| Skills | `tdd`, `aws-serverless` |

### T-08 — StateStore DynamoDB y repositorios (DynamoDB Local)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · L · **A (ejecutable)** |
| Objetivo | Adaptador de la tabla única (design §5.1) con escrituras condicionales, GSI1 y GSI2 (`EXECUTION`/`STEP`/`WINDOW`), repositorios de lock, ventana, target, instancia y marcas `EVT#` |
| Depends on | T-04, T-06 |
| Requisitos / Diseño | FR-05 (reinicio), FR-07 (concurrencia entre instancias), FR-11 (propiedad, lock huérfano) · §5.1, DD-03, DD-09 |
| Archivos | `adapters/dynamodb-state-store` |
| Alcance | Excluye la creación de la tabla real (Gate B) |
| Tests / verificación | Integración con DynamoDB Local: dos escritores concurrentes sobre la misma transición (solo uno gana); renovar o liberar un lock ajeno no tiene efecto; lease vencido → adquirible; escritura del target con fencing obsoleto rechazada; consultas a GSI2 sin scans; eliminar `activeStatus` al terminar |
| Falsifier | Quitar la condición de `version` → el test de dos escritores concurrentes muestra ambos aplicados |
| Red run | Ejecutar la prueba de concurrencia sin condición y citar el doble éxito |
| Disqualifier | Ejecutar los "concurrentes" en secuencia no ejercita la carrera: el test debe lanzarlos en paralelo con una barrera, repetido ≥ 50 veces, y reportar la dispersión |
| Consumers | none |
| Review | full |
| Done | Patrones de acceso de §5.1 implementados; los tests de carrera son estables en 50 repeticiones |
| Skills | `tdd`, `aws-serverless` |

### T-09 — Identidad y dedupe (DD-20)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable)** |
| Objetivo | Creación de ejecuciones con reclamo arrendado, secuencia guardada y todas las filas de redelivery de DD-20 |
| Depends on | T-08 |
| Requisitos / Diseño | FR-03 (manual, duplicada y su `AND IT MUST NOT` de secuencia, pipeline desconocido), FR-07 · DD-20 |
| Archivos | `application/execution-service` |
| Tests / verificación | Cada fila de la tabla de DD-20; dos procesos concurrentes con el mismo `requestId` → una ejecución; caída simulada entre los pasos → reanudación sin duplicar; pipeline desconocido → confirmado sin crear |
| Falsifier | Derivar el `executionId` del contador en vez de la `sequence` guardada → el test de toma tras lease vencido crea una segunda ejecución |
| Red run | Simular la caída tras el incremento y citar las dos ejecuciones creadas |
| Disqualifier | Sin un reloj inyectado no se puede probar el vencimiento del lease del reclamo; un test que espera en tiempo real no vale |
| Consumers | none |
| Review | full |
| Done | Todas las filas de DD-20 con test; huecos de secuencia aceptados y documentados |
| Skills | `tdd` |

### T-10 — Step dispatcher e interfaz de handlers
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable)** |
| Objetivo | Intent-then-act (T1/T3 → handler → T6), `dispatchToken` por intento y reintentos T10 según §7.2, con handlers falsos |
| Depends on | T-04, T-05, T-08, T-09 |
| Requisitos / Diseño | FR-07 (fallo entre registrar y despachar, `AND IT MUST` del token), FR-16 F3, F4 y F9 · DD-04, §7.2 |
| Archivos | `application/step-dispatcher` |
| Tests / verificación | Redelivery tras registrar la intención → el handler no se llama dos veces con tokens distintos; T10 incrementa `attempt` y crea un token nuevo; T10 nunca para `ssh` |
| Falsifier | Generar un token nuevo en cada re-entrega → el test de idempotencia del token se pone rojo |
| Red run | Citar el doble despacho observado con tokens distintos |
| Disqualifier | Un handler falso que ignora el token no puede revelar el defecto: el doble registra cada token recibido |
| Consumers | none |
| Review | full |
| Done | Escenarios de FR-07 cubiertos con el handler falso registrador |
| Skills | `tdd` |

### T-11 — Reconciler (lógica)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable)** |
| Objetivo | `RECONCILE_TICK`: consultas a GSI2 por partición; tabla de recuperación de §7.3 (T8, T13, T12); `LOCK_TIMEOUT` canónico; `UNKNOWN_TARGET_STATE`; cierre de ventanas vencidas |
| Depends on | T-08, T-10 |
| Requisitos / Diseño | FR-15 (los tres escenarios y su `BUT` de no re-ejecutar el deploy), FR-16 F16–F17, FR-18 (cierre), FR-11 (canónico) · §7.3, §7.7, DD-13 |
| Archivos | `application/reconciler` |
| Tests / verificación | Build perdido adoptado (T8); `DISPATCHING` sin `externalRef` → T13 con el **mismo** token, solo una vez; segundo vencimiento → T12; `WAITING_LOCK` vencido → `FAILED(LOCK_TIMEOUT)`, nunca `TIMED_OUT`; carrera handler/reconciler → el mismo resultado; un SSH vencido nunca se re-despacha; ventana vencida → `CLOSED/EXPIRED` |
| Falsifier | Usar T12 para `WAITING_LOCK` → el test canónico se pone rojo |
| Red run | Citar `TIMED_OUT` obtenido en el borde antes de aplicar la regla |
| Disqualifier | Una carrera handler/reconciler ejecutada en secuencia no prueba el determinismo: se lanzan en paralelo con barrera y repetición |
| Consumers | none |
| Review | full |
| Done | Tabla de recuperación completa con tests; ningún scan en el adaptador (verificado con un doble que falla si se llama a scan) |
| Skills | `tdd` |

### T-12 — Ventanas de deploy: servicio y CLI de operador
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable)** |
| Objetivo | `deploy-window-service` (`isDeployAllowed(lockKey, needUntil)`, apertura con cobertura completa de `externalDeployers`, cierre manual) y CLI de `tools/` que publica `DEPLOY_WINDOW_*` y `PIPELINE_REQUESTED` |
| Depends on | T-03, T-08 |
| Requisitos / Diseño | FR-18 (ventana, Jenkins global `BUT`, precondición, respaldo técnico `BUT`, revalidación `AND IT MUST NOT`), FR-03 (disparo manual), FR-16 F19 · DD-21, §7.7 |
| Archivos | `application/deploy-window-service`, `tools/*` |
| Alcance | **Sin lógica Jenkins**: solo comparación de listas opacas. Sin integración con la API de Jenkins |
| Tests / verificación | Apertura rechazada si falta algún desplegador externo; ventana que no cubre `needUntil` → no permitida; máximo 8 h; el CLI no acepta valores de secretos |
| Falsifier | Aceptar la apertura con una lista parcial → el test de cobertura se pone rojo |
| Red run | Citar la apertura aceptada con un desplegador faltante |
| Disqualifier | Si el fixture tiene un solo desplegador externo, "parcial" y "vacía" coinciden: el fixture usa ≥ 2 |
| Consumers | none |
| Review | full |
| Done | `grep -i jenkins` sobre `executor/src` = 0 (salvo comentarios de documentación); escenarios de FR-18 cubiertos |
| Skills | `tdd` |

### T-13 — Handler SSH (transporte falso y servidor SSH de prueba local)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · L · **A (ejecutable)** |
| Objetivo | Secuencia de §7.5: V1/V2 → lock → supersede → semáforo global → sesión → SFTP del script versionado → V4 → T6 → exec con args escapados → mapeo del código (incluido 50 → T9 + V3) → estado del target con fencing → liberación en **toda** salida |
| Depends on | T-06, T-08, T-10, T-12, T-14 |
| Requisitos / Diseño | FR-11, FR-12 (los seis escenarios con su `BUT` y su `AND IT MUST`), FR-13 (segunda barrera `BUT`), FR-16 F10–F13, F17–F19, FR-18 (revalidación) · DD-09, DD-10, DD-22, §7.3, §7.5, §7.7 |
| Archivos | `adapters/handlers/ssh` |
| Alcance | Servidor SSH de prueba **local** (contenedor de test) con un host key fijado; credenciales de prueba generadas en el test. Sin targets reales |
| Tests / verificación | Host key distinta → `HOST_KEY_MISMATCH` sin exec; reintentos de conexión solo antes del exec; un script que ya empezó no se reintenta; tabla de §7.5 fila por fila (semáforo y lock liberados con el 50); el step en `WAITING_LOCK` no ocupa semáforo; credencial nunca en disco ni en logs; args con metacaracteres llegan literales |
| Falsifier | No liberar el semáforo en la rama del 50 → tras N códigos 50 un deploy nuevo se bloquea, y el test de "50 repetidos" se pone rojo |
| Red run | Citar el bloqueo observado con el semáforo en 1 y dos códigos 50 seguidos |
| Disqualifier | Un transporte SSH totalmente simulado no prueba la verificación de host key: ese caso exige el servidor SSH local real |
| Consumers | none |
| Review | lenses: seguridad (credenciales, args) y concurrencia (semáforo, lock) |
| Done | Tabla de §7.5 completa; escaneo de logs de test sin secretos |
| Skills | `tdd`, `error-handling-patterns` |

### T-14 — `deploy-container.sh` genérico y tests locales
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable, validación real en Gate C)** |
| Objetivo | Script del lado target con el contrato de §6.4: mutex del kernel no bloqueante (50), HUP ignorado en la sección crítica, imagen previa tomada del contenedor en ejecución, migración **antes** del swap, health, restauración, poda que conserva la previa, directorio temporal por ejecución, `CICD_RESULT` |
| Depends on | T-01 |
| Requisitos / Diseño | FR-13 (todos los escenarios y códigos), FR-16 F11–F13, F18 · DD-11, DD-22, §5.3, §6.4 |
| Archivos | `deploy-scripts/deploy-container.sh`, tests del script |
| Alcance | **Genérico**: nada de PRMS en el script; todo llega por argumentos. Contiene la variante "migración efímera" y la de "contenedor temporal" (DD-11, P-5), elegida por argumento. Excluye validación contra imágenes reales (T-33) |
| Tests / verificación | Docker de prueba local con imágenes ficticias: migración que falla → 20 y el contenedor viejo sigue corriendo; health que falla → 40 y la previa restaurada; segundo proceso concurrente → 50 sin efectos; imagen previa nunca podada; `.env` temporal borrado en todas las salidas; HUP durante la sección crítica no interrumpe |
| Falsifier | Detener el contenedor viejo antes de migrar → el test "migración falla, el viejo sigue" se pone rojo |
| Red run | Citar el contenedor viejo detenido con una migración ficticia rota |
| Disqualifier | Comprobar solo el código de salida no prueba la disponibilidad: el test consulta el contenedor viejo en ejecución |
| Consumers | none |
| Review | full |
| Done | Todos los códigos y escenarios de FR-13 cubiertos con contenedores ficticios; `grep` de identificadores de aplicación en el script = 0 |
| Skills | `tdd` |

### T-15 — Handler de fuente y propiedad de `/work`
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable; tamaño real en T-29)** |
| Objetivo | Fetch del commit exacto, ZIP en streaming con exclusiones obligatorias, subida vía `ArtifactStore`, rutas `/work/{instanceId}/{executionId}/{stepId}-{attempt}/`, limpieza por ejecución y de rezagados, borrado de `executions/{id}/source/` al terminar |
| Depends on | T-08, T-10 |
| Requisitos / Diseño | FR-08 (los cinco escenarios y su `BUT`/`AND IT MUST NOT`), FR-16 F1–F3, FR-19 (borrado explícito) · §5.2, §7.4, DD-04 |
| Archivos | `adapters/handlers/source`, `adapters/git-cli-client`, `adapters/zip-packager` |
| Alcance | **Prohibido** instalar dependencias o ejecutar scripts del repo. Repos git locales de fixture; `ArtifactStore` falso |
| Tests / verificación | El ZIP no contiene `.git`, `node_modules`, `.env*` ni archivos de entorno con secretos (fixture con secretos ficticios); dos ejecuciones concurrentes → rutas disjuntas; nunca se toca otro `instanceId`; un fallo limpia; el semáforo de concurrencia se respeta |
| Falsifier | Quitar `.env*` de las exclusiones → el escaneo del ZIP encuentra el secreto ficticio |
| Red run | Citar el hallazgo del escaneo sobre un ZIP sin la exclusión |
| Disqualifier | Un fixture sin archivos de secretos no puede fallar la exclusión: el fixture los incluye a propósito |
| Consumers | none |
| Review | lenses: seguridad (exclusiones) y aislamiento (rutas) |
| Done | Escenarios de FR-08 cubiertos |
| Skills | `tdd` |

### T-16 — Servicio de notificación y proveedor Slack
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · S · **A (ejecutable)** |
| Objetivo | `NotificationProvider`, Slack (Web API, hilo por ejecución) con HTTP falso, best-effort, dedupe `EVT#` |
| Depends on | T-08 |
| Requisitos / Diseño | FR-14 (contenido `BUT`, fallo del proveedor `AND IT MUST NOT`, separación), FR-16 F14 · DD-12, §6.5 |
| Archivos | `application/notification-service`, `adapters/notify/slack-provider` |
| Tests / verificación | Slack caído → el estado de la ejecución no cambia; redelivery → no duplica el mensaje; el contenido no incluye valores de secretos |
| Falsifier | Propagar el error de Slack → el test de "estado no cambia" se pone rojo |
| Red run | Citar el estado alterado por la excepción no capturada |
| Disqualifier | Un proveedor falso que nunca falla no prueba el best-effort |
| Consumers | none |
| Review | checklist |
| Done | Escenarios de FR-14 cubiertos |
| Skills | `tdd` |

### T-17 — Observabilidad: logger con redacción, métricas y heartbeat
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · S · **A** |
| Objetivo | Logger JSON con contexto y redacción (tokens, password, secret, PEM, URLs presignadas); métricas EMF de §12; heartbeat y archivo de healthcheck |
| Depends on | T-01 |
| Requisitos / Diseño | FR-17 (reconstrucción, redacción), NFR-02, NFR-05, NFR-06 · §12 |
| Archivos | `observability/*` |
| Tests / verificación | Corpus de secretos ficticios → 0 apariciones en la salida; cada línea con `executionId` cuando aplica |
| Falsifier | Quitar el patrón PEM → el corpus encuentra la llave ficticia |
| Red run | Citar la llave ficticia en la salida antes de añadir el patrón |
| Disqualifier | Un corpus sin uno de los tipos de secreto listados no prueba su redacción |
| Consumers | none |
| Review | checklist |
| Done | Redacción verificada por corpus |
| Skills | `tdd` |

### T-18 — Consumidor SQS y bootstrap (`main`)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable con emulador local)** |
| Objetivo | Long-poll, concurrencia acotada, heartbeat de visibilidad, reglas de ack; `main` con lease `INSTANCE#`, limpieza de `/work/{instanceId}` y wiring de puertos |
| Depends on | T-07, T-08, T-15, T-17 |
| Requisitos / Diseño | FR-04 (envenenado), FR-05 (reinicio), FR-16 F9 y F15, NFR-03, NFR-04 · DD-14, §7.4, §7 (`main`, `sqs-consumer`) |
| Archivos | `inbound/sqs-consumer`, `main` |
| Alcance | Emulador SQS local; el límite real de 900 s se valida en T-26 (P-22) |
| Tests / verificación | Handler largo → la visibilidad se extiende; caída → el mensaje reaparece y el reprocesamiento es no-op; mensaje envenenado → nunca se confirma (la DLQ real se prueba en T-26); segundo contenedor con el mismo `instanceId` → arranque abortado |
| Falsifier | No extender la visibilidad → el mensaje reaparece durante el handler y el test de doble procesamiento se pone rojo |
| Red run | Citar la segunda entrega observada con el handler aún vivo |
| Disqualifier | Un emulador que no implementa la visibilidad igual que SQS puede dar falsos verdes: se documenta qué propiedades replica y T-26 repite el test contra SQS real |
| Consumers | none |
| Review | full |
| Done | Reglas de ack y lease de instancia verificados localmente |
| Skills | `tdd`, `aws-serverless` |

### T-19 — Handlers Lambda y CodeBuild (SDK simulado)
| Campo | Valor |
|---|---|
| Status / Size / Gate | pending · M · **A (ejecutable; integración real en T-27 y T-28)** |
| Objetivo | Invocación `Event` del alias `cicd` y `StartBuild` con overrides e `idempotencyToken`; sin polling en el camino normal |
| Depends on | T-07, T-10 |
| Requisitos / Diseño | FR-09 (no bloqueo `BUT`, enlace a logs), FR-10 (tag único `AND IT MUST NOT`, finalización por evento `BUT`, fuente de la ejecución `BUT`, salidas), FR-14 (separación) · DD-07, DD-08, §6.2, §6.3 |
| Archivos | `adapters/handlers/lambda`, `adapters/handlers/codebuild` |
| Tests / verificación | El handler Lambda nunca usa `RequestResponse`; el tag sigue `<pipelineId>-<sequence>` con labels de commit y `executionId`; el handler CodeBuild no consulta estado tras arrancar; los handlers no llaman a notificación |
| Falsifier | Invocar en modo síncrono → la aserción de `InvocationType` se pone roja |
| Red run | Citar la llamada registrada por el SDK simulado |
| Disqualifier | Un SDK simulado no prueba la semántica real del `idempotencyToken` (P-18): queda para T-28 |
| Consumers | none |
| Review | checklist |
| Done | Contratos de §6.2 y §6.3 cumplidos contra el SDK simulado |
| Skills | `tdd`, `aws-serverless` |

### T-20 — Ingress de webhook GitHub (código) · SHOULD
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** (deployment in T-30) · M · **A** |
| Objetivo | Contrato de §6.6: HMAC en tiempo constante, eventos aceptados, mapeo rama → definiciones vía `DefinitionSource`, `requestId` por entrega y pipeline |
| Depends on | T-03, T-07 |
| Requisitos / Diseño | FR-20 (firma inválida, rama no configurada) · §6.6, DD-20 |
| Archivos | `ingress/github-webhook/*` |
| Tests / verificación | Firma ausente o inválida → 401 sin encolar; rama sin coincidencia → 202 sin encolar; reintento de GitHub → mismo `requestId` |
| Falsifier | Comparar la firma con igualdad simple → el test de tiempo constante (llamada a la primitiva segura) se pone rojo |
| Red run | Citar la llamada a una comparación no segura detectada |
| Disqualifier | Probar solo firmas válidas no prueba el rechazo |
| Consumers | none |
| Review | lenses: seguridad |
| Done | Escenarios de FR-20 cubiertos |
| Skills | `tdd`, `aws-serverless`, `api-design-principles` |

### T-21 — Guardas de frontera (NFR-01) y comando de validación
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** (build-time run deferred to T-31) · S · **A** |
| Objetivo | Comprobaciones automáticas de la frontera y de la política de publicación, ejecutables localmente y al construir la imagen |
| Depends on | T-01, T-02, T-03 |
| Requisitos / Diseño | NFR-01, NFR-02, NFR-08, NFR-10 · design §4.1, DD-23, §8 de requirements (defect classes) |
| Archivos | Scripts de verificación del repo |
| Alcance | (1) Inspección de la imagen: sin toolchains ni socket; (2) búsqueda de identificadores de proyecto o aplicación en `executor/src` = 0; (3) el schema rechaza expresiones; (4) escaneo de identificadores internos y secretos en archivos versionados; (5) los dos archivos de análisis no están trackeados; (6) prueba NFR-08: una segunda definición ficticia del mismo patrón valida sin cambios de código |
| Tests / verificación | Cada guarda con su caso negativo |
| Falsifier | Añadir `if (project === 'prms')` en un handler → la guarda (2) se pone roja |
| Red run | Citar la salida de la guarda sobre una rama con la mutación |
| Disqualifier | Una búsqueda de identificadores sin la lista de nombres de proyectos conocidos no prueba nada: la lista sale de los proyectos citados en el proposal |
| Consumers | none |
| Review | full: protege el principio rector |
| Done | Seis guardas verdes en el estado limpio y rojas con su mutación |
| Skills | — |

### T-22 — Inventario de infraestructura y runbooks base
| Campo | Valor |
|---|---|
| Status / Size / Gate | **[x] done** · S · **A** |
| Objetivo | `infra/RESOURCES.md` (contrato de recursos DEV, DD-17) y `docs/runbook.md` (incluye §12.1), `docs/resources.md` y la plantilla de `docs/jenkins-coexistence-log.md`, **saneados** |
| Depends on | T-02 |
| Requisitos / Diseño | FR-17, FR-18, FR-19 (lifecycle 7/30/1), NFR-06, NFR-09 · design §5.2, §12, §12.1, proposal §14.1 (en forma lógica) |
| Archivos | `infra/RESOURCES.md`, `docs/*.md` |
| Alcance | Excluye código IaC (T-24) |
| Tests / verificación | Revisión cruzada: cada recurso de design §5 y proposal §14.1 presente; lifecycle de S3 7/30/1 declarado; escaneo de identificadores internos = 0 |
| Falsifier | Omitir la regla de lifecycle de 7 días → la revisión cruzada contra FR-19 falla |
| Red run | Citar el ítem faltante en la primera pasada de la lista de verificación |
| Disqualifier | Una lista de verificación que no deriva de FR-19 y de design §5 no prueba completitud |
| Consumers | none |
| Review | checklist |
| Done | Inventario completo y saneado; runbook con §12.1 |
| Skills | `cognitive-doc-design` |

---

## 6. Gate B: infraestructura y despliegue DEV (bloqueadas)

| ID | Tarea | Objetivo | Depends on | Requisitos / Diseño | Bloqueado por (sin asumir respuesta) | Verificación y falsifier | Review |
|---|---|---|---|---|---|---|---|
| **T-23** | Spike de red desde el host del Executor | Validar salida 443 (AWS, GitHub, Slack), 22 al target DEV y proxy | — | NFR-04, NFR-09 · DD-18, design §10.2 del proposal | **OD-Q11** (host), **P-11**, **P-19** (¿host PROD?) | Pruebas de conexión documentadas, sin identificadores internos en Git. Falsifier: un destino bloqueado tiene que aparecer como fallo, no como timeout silencioso | checklist |
| **T-24** | IaC de los recursos DEV | Traducir `infra/RESOURCES.md` a la herramienta elegida (SQS+DLQ, DynamoDB+GSI, S3+lifecycle, EventBridge, Scheduler, IAM mínimo) | T-22, T-23 | FR-04, FR-19, NFR-02, NFR-09 · DD-17 | **OD-Q7** (herramienta), **P-7** | Plan sin recursos fuera de DEV; políticas sin comodines amplios. Falsifier: una política con `*` sobre recursos debe fallar la revisión | full |
| **T-25** | Desplegar el contenedor del Executor en el host | Contenedor con límites, `instanceId`, volumen `/work`, sin Swarm, credenciales vía la cadena del SDK | T-18, T-24 | NFR-02, NFR-04 · DD-16, DD-18, §7.4 | **OD-Q11**, **OD-Q12** (mecanismo de credenciales sin exponerlas a otros contenedores) | Pipeline no-op manual → Slack; credenciales no accesibles desde otro contenedor del host (prueba negativa) | full |
| **T-26** | Integración real de SQS, DLQ, DynamoDB, S3 y Secrets | Repetir los tests de T-08 y T-18 contra AWS DEV; DLQ tras 5 recepciones; `DelaySeconds` > 900 rechazado; resolución de DD-23 | T-25 | FR-04 (envenenado), FR-19, NFR-03 · DD-02, DD-14, DD-23 | **P-22** (se resuelve aquí), entradas de Secrets Manager creadas por el owner | Falsifier: `maxReceiveCount` mal configurado → el mensaje envenenado no llega a la DLQ | full |
| **T-27** | Integración Lambda (alias `cicd` + Destinations) | Configurar la invocación async en el alias, sin tocar la función sin calificar; reemplazar los fixtures sintéticos de T-07 por capturas reales saneadas | T-19, T-26 | FR-09, FR-16 F4–F6 · DD-07, §6.2 | **OD-Q13** (secretos en tests), **P-1**, **P-2**, **P-15** (consumers: los pipelines que invocan la función), **P-17** | Consumers: pipelines de Jenkins que usan `<QUALITY_WORKER_FUNCTION>` (cinco `<JENKINS_JOB_ID>`); verificar que su configuración no cambió. Plan B (wrapper) si P-2 o P-17 son falsas | full |
| **T-28** | CodeBuild `prms-reporting-dev` + buildspec + regla EventBridge | Proyecto por app y ambiente (server y client comparten, salvo evidencia en contra), secretos de build DEV y fuente S3 de la ejecución | T-19, T-26 | FR-10, FR-16 F7–F8 · DD-08, §6.3 | **P-8**, **P-8b**, **P-9**, **P-16** (consumers: lifecycle y limpieza del repo ECR), **P-18** | Tag único en `<ECR_REPOSITORY>`; `BUILD_COMPLETED` duplicado = no-op; el `idempotencyToken` no crea un segundo build. Si server y client difieren en entorno, IAM o red → **escalar** antes de crear un segundo proyecto | full |
| **T-29** | Fuente contra el repo real | Medir el tamaño de `<PRMS_REPORTING_REPO>`, dimensionar `/work` y la concurrencia, y configurar la credencial de lectura | T-15, T-26 | FR-08, NFR-04 | **OD-Q15** (autenticación y tamaño), **P-10** | Falsifier: con un límite de disco menor que el clon, el fallo tiene que ser `SOURCE_PREP` limpio. Disqualifier: una sola medición no basta; se toman 3 y se reporta la dispersión | checklist |
| **T-30** | Desplegar el webhook (SHOULD) | Function URL + secreto HMAC; webhook en el repo de la aplicación | T-20, T-26 | FR-20 | Decisión del owner sobre la activación del trigger automático frente a la coexistencia con Jenkins (FR-18) | Firma inválida → 401 en DEV real | checklist |
| **T-31** | CI del repositorio de la plataforma | Correr tests, guardas (T-21) y validación de definiciones en cada PR | T-21 | NFR-01, NFR-08 | **OD-N1** (nueva; sistema de CI del repo) | Las guardas fallan el PR con su mutación | checklist |

---

## 7. Gate C: E2E en el target DEV (bloqueadas)

| ID | Tarea | Objetivo | Depends on | Requisitos / Diseño | Bloqueado por | Verificación | Review |
|---|---|---|---|---|---|---|---|
| **T-32** | Preparación y configuración del target | Entradas de Secrets Manager (conexión, host key), usuario de deploy, permisos AWS del target **sin** borrar llaves existentes, valores reales del registro fuera de Git (DD-23), `externalDeployersRef` con los jobs reales | T-25, T-28 | FR-02, FR-12, FR-13 (credenciales del target `AND IT MUST NOT`), FR-18, NFR-10 | **OD-Q5**, **P-3**, **P-4**, **P-13**, **P-14** | El Executor arranca y resuelve todas las referencias; los jobs que usan llaves sobrantes siguen funcionando (prueba de no regresión del owner) | full |
| **T-33** | Preparación de migraciones | Verificar la migración efímera (Dockerfile), la ruta de red target → BD, la atestación de compatibilidad y el snapshot de la BD DEV | T-14, T-32 | FR-13 (precondición), NFR-03 · DD-11, §12 | **P-5**, **P-6**, **P-23**, **P-24** | `migration:check:ci` en solo lectura desde el target; atestación registrada en el registro (fuera de Git si revela datos); snapshot confirmado. **Sin atestación no se habilitan migraciones** | full |
| **T-34** | Validación de SSH y de ventana (sin deploy) | Un operador valida la conexión, el host key y el usuario con el runbook; abre y cierra una ventana de prueba y verifica `DEPLOY_WINDOW_CLOSED` con un deploy fuera de ventana | T-32, T-12 | FR-12 (host key), FR-18 (todos) · DD-21, §7.7 | Ventana aprobada por el admin de Jenkins | Deploy sin ventana → falla sin SSH (prueba negativa real) | checklist |
| **T-35** | E2E de aceptación y caminos de fallo, en ventana | AC1–AC14 del proposal §17: duplicados, concurrencia, migración rota (rama de prueba), health roto, caída del Executor a mitad, mensaje envenenado, código 50 inducido | T-33, T-34, T-26, T-27, T-28, T-29 | FR-01 a FR-19, NFR-03, NFR-05, NFR-06 | Ventana abierta; snapshot; P-23 | Cada AC con evidencia citada (sin identificadores internos). Disqualifier: NFR-05 con menos de 10 ejecuciones o con una dispersión mayor que el efecto no es evidencia; se reporta la dispersión | full |
| **T-36** | Informe de medición y cierre de la coexistencia | Duraciones y recursos (Lambda, CodeBuild, Executor), costo frente a proposal §14.2, registro de las ventanas, rehabilitación de los jobs verificada (AC14) | T-35 | NFR-05, NFR-07, FR-18 | — (sigue a T-35) | Jobs de Jenkins rehabilitados y funcionales | checklist |

---

## 8. Gate D: retirar Jenkins (fuera del PoC; solo registro)

| ID | Prerrequisito | Iniciativa |
|---|---|---|
| D-1 | Inventario de la configuración de Jenkins (`config.xml`, triggers, parámetros, concurrencia, globales, plugins, credenciales, librería compartida). Resuelve P-12 | `jenkins-config-inventory` |
| D-2 | Runtime de builds sin Docker (B1) probado | `cicd-build-runtime-poc` |
| D-3 | Reubicar las migraciones que hoy corren desde el host de Jenkins (H1) | Olas de migración |
| D-4 | Inventario y versionado de scripts en hosts y en Secrets Manager (H2) | `jenkins-config-inventory` |
| D-5 | Remediación de IAM: instance profiles, rotación de credenciales y separación prod/no-prod (H3) | `cicd-security-remediation` |
| D-6 | Familia de steps SDK (`lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check`) y Jira Builds API | Specs futuras |
| D-7 | Validación de los demás patrones de pipeline (P2 a P9) y olas de migración, con Jenkins en paralelo | Olas |
| D-8 | Consumidores de `<JENKINS_EXECUTIONS_TABLE>` (OD-Q14) | `jenkins-config-inventory` |

**El PoC se completa en T-36. Ningún ítem de Gate D es criterio de finalización del PoC.**

---

## 9. Cobertura a nivel de escenario y cláusula

| Requisito / escenario (cláusulas) | Tareas |
|---|---|
| FR-01: válida (`definitionRef`), inválida (`BUT` no crear, `AND IT MUST` rechazar expresiones), CodeBuild por ambiente (`BUT` sin implícito), reservado, ambiente | T-02, T-03, T-21 |
| FR-02: puertos o nombres, host key (`AND IT MUST`), política obligatoria (`BUT` sin default), secretos en el registro (`BUT`) | T-02, T-03, T-21 |
| FR-03: manual (commit exacto), duplicada (`AND IT MUST NOT` secuencia), desconocido (`BUT`) | T-09, T-12 (CLI) |
| FR-04: sobre, nativos (`AND IT MUST` correlación), envenenado (`BUT` no bloquear), huérfano | T-07, T-18, T-26 |
| FR-05: válida, inválida, única vuelta atrás (`BUT`), paralelos (`BUT`), reinicio (`AND IT MUST NOT`) | T-04, T-08, T-18 |
| FR-06: paralelismo, fan-in, fallo de dependencia, finally (`BUT`) | T-05 |
| FR-07: duplicado (`BUT` no deploy, SSH ni migración), concurrencia entre instancias, registrar y despachar (`AND IT MUST` token) | T-08, T-10, T-13, T-35 |
| FR-08: preparación, exclusiones (`BUT`), keys fijas (`AND IT MUST NOT`), fallo y huérfanos, concurrencia (`BUT`) | T-15, T-29 |
| FR-09: clasificación, no bloqueo (`BUT`), enlace a logs | T-19, T-27 |
| FR-10: tag (`AND IT MUST NOT`), evento (`BUT`), fuente (`BUT`), salidas | T-19, T-28 |
| FR-11: adquisición, ocupado + `AND IT MUST` canónico, propiedad, renovación, huérfano (`AND IT MUST`), supersede | T-06, T-08, T-11, T-13 |
| FR-12: host key (`BUT`), credenciales (`BUT`, `AND IT MUST`), versión, argumentos (`BUT`), resultado, reintentos (`BUT`) | T-13, T-34 |
| FR-13: códigos 0–50, segunda barrera (`BUT`), precondición (`AND IT MUST`, `BUT`), migración fallida (`BUT`), health, imagen previa (`BUT`), configuración temporal, credenciales del target (`AND IT MUST NOT`), idempotencia | T-14, T-32, T-33 |
| FR-14: contenido (`BUT`), fallo del proveedor (`AND IT MUST NOT`), separación | T-16, T-19 |
| FR-15: CodeBuild perdido, atascado, SSH interrumpido (`BUT`) | T-11 |
| FR-16: F1–F3 | T-15 · F4–F6: T-10, T-27 · F7–F8: T-28 · F9: T-10, T-18 · F10–F13: T-13, T-14 · F14: T-16 · F15: T-18 · F16–F17: T-11 · F18: T-06, T-13 · F19: T-12, T-13 |
| FR-17: reconstrucción, redacción | T-17, T-35 |
| FR-18: ventana, Jenkins global (`BUT`), precondición, respaldo técnico (`BUT`), revalidación (`AND IT MUST NOT`) | T-12, T-13, T-34, T-36 |
| FR-19: ejecución abandonada; borrado explícito | T-15, T-22, T-24 |
| FR-20: firma inválida, rama no configurada | T-20, T-30 |
| NFR-01 | T-01, T-21 · NFR-02: T-13, T-15, T-17, T-21, T-25 · NFR-03: T-08, T-18, T-26 · NFR-04: T-15, T-18, T-25, T-29 · NFR-05: T-35 · NFR-06: T-22, T-35 · NFR-07: T-36 · NFR-08: T-03, T-21 · NFR-09: T-23, T-24 · NFR-10: T-00, T-21, T-32 |

Ninguna cláusula se da por cubierta citando otro requisito.

---

## 10. Riesgos de frontera revisados

| Tarea | Riesgo de expansión del Executor | Control |
|---|---|---|
| T-14 | El script podría acumular lógica de aplicación | Es **genérico** y vive en el target; todo llega por argumentos; la guarda T-21 busca identificadores de aplicación |
| T-15 | Tentación de "preparar" la fuente (instalar dependencias o ejecutar scripts del repo) | Prohibido en el alcance; la guarda de la imagen (sin toolchains) lo impide |
| T-12 / T-32 | Lógica de Jenkins en el núcleo | Solo listas opacas; sin API de Jenkins; `grep -i jenkins` en `executor/src` |
| T-28 | Crear más proyectos CodeBuild "por simetría" | Solo con evidencia de entorno, IAM o red distintos, y escalando antes |
| T-31 | Elegir un CI sin decisión | Bloqueada por OD-N1 |

Ninguna tarea introduce orquestación específica de proyectos, expresiones, builds de aplicaciones, conexión a BD ni código de deploy de aplicaciones en el Executor.

# Judgment Day — `design.md` (cicd-executor-poc)

| Campo | Valor |
|---|---|
| Target | `design.md` (borrador v1 del 2026-10-05) contrastado con `requirements.md` y `proposal.md` (aprobados) |
| Modo | Dos jueces ciegos, de solo lectura y en paralelo. Modelo `sonnet` (el autor del diseño fue `opus`) |
| Ronda | 1 de 2 |
| Estado | **Abierto**: esperando la decisión del owner antes de la corrección de la ronda 1 |
| Referencias de la skill | `references/` no está empaquetado; se aplicó el contrato de `SKILL.md` |

Leyenda: **A** = juez A; **B** = juez B.

## Ledger congelado — ronda 1

### Confirmados por ambos jueces (SEVERE → auto-fix elegible)

| ID | Hallazgo | A | B | Verificación del arquitecto |
|---|---|---|---|---|
| C-1 | DD-09: espera de lock "con `DelaySeconds` creciente hasta 30 min". SQS limita `DelaySeconds` a 900 s, así que el mecanismo no alcanza el `LOCK_TIMEOUT` de 30 min de FR-11 | J-02 | J1 | Correcto: límite documentado de SQS |
| C-2 | P-21 "verificado" (`grep -rni "akilia" .` → 0 hits) es falso: el propio `design.md` contiene la cadena (Document Control y la fila P-21) | J-01 | J2 | Correcto: la fila se refuta a sí misma |

### Sospechosos (SEVERE según un solo juez → sin auto-fix; decide el owner)

| ID | Hallazgo | Juez | Verificación del arquitecto |
|---|---|---|---|
| S-1 | DD-20: el dedupe en dos fases no tiene lease. Dos redeliveries concurrentes del mismo `requestId` en estado `CLAIMED` podrían completar ambas los pasos 2–4, consumir dos secuencias y crear dos ejecuciones (viola FR-03 y FR-07) | A (J-03) | **De acuerdo**: carrera real |
| S-2 | Lease vencido con la sesión SSH viva: si falla la renovación del lock (partición con DynamoDB) mientras el script sigue corriendo, otra ejecución puede adquirir el lock y lanzar un segundo deploy o migración. El `fencingToken` protege solo la escritura en DynamoDB, no el efecto físico | B (J5) | **De acuerdo**: requiere un mutex del lado del target o un riesgo aceptado explícito |
| S-3 | Falta la premisa "las migraciones son compatibles hacia atrás". Estaba en el proposal §10.11 y desaparece en requirements y design; el rollback del código 40 depende de ella | B (J3) | **De acuerdo** |
| S-4 | FR-18 (coexistencia con Jenkins) no tiene respaldo de diseño: no hay mecanismo que impida un deploy real sin una ventana confirmada | B (J6) | **De acuerdo**: se puede respaldar con un gate de configuración |

### Hallado por ambos con severidad distinta → decide el owner

| ID | Hallazgo | A | B | Verificación del arquitecto |
|---|---|---|---|---|
| D-1 | El riesgo R9 del proposal (BD DEV compartida con variantes de Jenkins de otras ramas) no aparece en el Premise Ledger (shared-state) ni en los riesgos del diseño | SUGGESTION (J-09) | SEVERE (J4) | Disparador de clase `shared-state` sin fila → por la regla de la skill, **severo** |

### WARNING (info, sin auto-fix)

| ID | Hallazgo | Juez |
|---|---|---|
| W-1 | `handlers/ssh` sin semáforo global de sesiones (NFR-04; el proposal fijaba un default de 4) | A (J-06), B (J11) |
| W-2 | FR-20 (webhook) sin módulo ni contrato (firma, rama) | A (J-07), B (J7) |
| W-3 | FR-04 "evento huérfano" sin manejo explícito en `event-router` | A (J-04) |
| W-4 | Barrido de `/work` al arrancar (FR-08) sin módulo asignado | A (J-05) |
| W-5 | DD-19 (redesplegar por cada definición nueva) en tensión con la redacción de NFR-08 y QAS-5 | B (J8) |
| W-6 | P-15: la cita no establece que las invocaciones actuales sean síncronas (es una inferencia) | B (J9) |

### SUGGESTION (info)

| ID | Hallazgo | Juez |
|---|---|---|
| I-1 | Ruta temporal renombrada (`/tmp/deploy-{id}.env` → `/tmp/cicd-{id}/runtime.env`) sin explicar | A (J-08) |
| I-2 | P-14 debería citar FA §9.3.5 en vez de L1123 | A (J-10) |
| I-3 | P-8: "tags no numéricos" no tiene pista en el FA | A (J-11) |
| I-4 | P-10: su impacto High es condicional | B (J10) |

### Controles que pasaron (ambos jueces)

Conteo del Premise Ledger consistente. Filas `shared-state` y `consumer` presentes. Ninguna decisión abierta (OD-Q5, Q7, Q11–Q15) asumida. Números (retención, plazos, códigos de salida, F1–F17) consistentes. Frontera NFR-01 sin desviaciones.

## Veredictos

| Juez | Veredicto |
|---|---|
| A | FAIL |
| B | FAIL |

## Correcciones — ronda 1 (aprobadas por el owner el 2026-10-05: opción "Fix and Re-judge")

Instrucciones del owner: aplicar C-1, C-2, S-1 a S-4, D-1 y los informativos. S-2 con dos capas (DynamoDB sigue siendo el lock; el mutex local es una segunda barrera, no un reemplazo). S-4 transitorio y por target, sin lógica Jenkins en el núcleo. C-1 con reencolados acotados y espera acumulada. S-3 como precondición explícita. DD-19 como simplificación del PoC detrás de una abstracción.

| ID | Corrección (delta) | Dónde |
|---|---|---|
| C-1 | Espera de lock con una cadena de `LOCK_RETRY_REQUESTED` de como máximo 900 s cada uno, `lockWaitStartedAt` y `lockWaitAttempts` en el step, presupuesto de 30 min acumulados, tope de 10 intentos y red de seguridad del reconciler. Nueva premisa P-22 | design DD-09, §5.1, §7, §7.1, §7.2, §11 |
| C-2 | P-21 reformulada y re-ejecutada (2 archivos dentro de la spec, 0 fuera) | design §11, Document Control |
| S-1 | Dedupe con `claimToken` + `claimLeaseExpiresAt` + `sequence` guardada. Tabla de redelivery por estado | design DD-20, §5.1 |
| S-2 | DD-22: mutex local no bloqueante por `lockKey` en el target, código 50 `TARGET_BUSY` (vuelve a la espera), `lockLostDuringRun`, rollback desde la imagen que realmente corre. FR-13 añade el código 50 y su escenario | design DD-22, DD-11, §5.3, §6.4, §7, §7.2; requirements FR-13, FR-16 F18 |
| S-3 | Precondición atestada `migrationCompatibility: backward-compatible` en el registro; validación; premisa P-23 (High, Gate C) | design DD-11, §7 `definition-service`, §11, §12; requirements FR-13, FR-02 |
| S-4 | DD-21: ventanas de deploy genéricas y transitorias por target (`requiresDeployWindow`), eventos `DEPLOY_WINDOW_*`, `deploy-window-service`, CLI en `tools/`, ítem `WINDOW#`, formato del log de coexistencia, `DEPLOY_WINDOW_CLOSED` | design DD-21, §2, §3.3, §4, §5.1, §6.1, §7, §7.2; requirements FR-18, FR-16 F19 |
| D-1 | Premisa `shared-state` P-24 (BD DEV compartida) y fila de riesgo con mitigaciones | design §11, §12 |
| W-1 | Semáforo global de sesiones SSH (default 4) | design §7 `handlers/ssh` |
| W-2 | Contrato del webhook §6.6 | design §6.6, §4 |
| W-3 | Eventos huérfanos (`ORPHAN_EVENT`) | design §6.1, §7 `event-router` |
| W-4 | Barrido de `/work` asignado a `main` (volumen exclusivo por instancia) | design §4, §7 |
| W-5 | Puerto `DefinitionSource` y empaquetado como simplificación del PoC; QAS-5 y NFR-08 aclarados | design DD-19, §2, §4, §7, QAS-5; requirements NFR-08 |
| W-6 | P-15 sin afirmar el modo de invocación | design §11 |
| I-1…I-4 | Ruta temporal explicada; P-14 cita §9.3.5; P-8 dividida en P-8 y P-8b; P-10 marcada como High condicional | design §5.3, §11 |

Barrido de cierre de correcciones ejecutado (grep de `0/10/20/30/40`, `hasta 30 min`, `DelaySeconds`, `sin cambios al Executor`, `/tmp/deploy-`): sin restos de valores reemplazados en design ni requirements. `proposal.md` (aprobado) no se reescribe: conserva su texto histórico.

## Ronda 2 — re-juicio acotado (ledger congelado + delta)

| Juez | Veredicto | Ítems de la ronda 1 |
|---|---|---|
| A | **PASS** (condicionado a cerrar R2-1, R2-W2 y R2-W3 antes del Gate C) | Todos RESOLVED |
| B | **PASS** (recomienda una enmienda acotada para R2-1) | Todos RESOLVED |

Ambos jueces volvieron a ejecutar el grep de P-21 (2 archivos dentro de la spec, 0 fuera) y recontaron el Premise Ledger a mano: 25 filas, 2 verificadas y 23 `UNVERIFIED` (10 High y 13 Low). Coincide. Ninguno encontró un **problema arquitectónico crítico**. La frontera NFR-01 se mantiene y ninguna OD quedó resuelta en silencio.

### Hallazgos nuevos causados por las correcciones

| ID | Severidad | Hallazgo | A | B |
|---|---|---|---|---|
| R2-1 | **SEVERE (confirmado por ambos)** | El código 50 (DD-22) exige la transición hacia atrás `DISPATCHING/RUNNING → WAITING_LOCK` del step `ssh`, que no está en la tabla de transiciones (FR-05 / `state-machine`). Una implementación literal la rechazaría | J-01 | R2-1 |
| R2-W1 | WARNING | No dice que la comprobación de ventana se repite en cada reintento de lock y tras el código 50; una ventana cerrada durante la espera podría no detectarse | — | R2-2 |
| R2-W2 | WARNING | `requiresDeployWindow` es opt-in. Si falta en un target compartido conocido (P-13), la protección de S-4 se anula en silencio | J-02 | — |
| R2-W3 | WARNING | El cierre de ventanas vencidas por el reconciler no tiene una ruta de consulta indexada (los ítems `WINDOW#` no están en GSI2) | J-03 | — |
| R2-W4 | WARNING | El barrido de `/work` es seguro solo si el volumen es exclusivo de cada instancia; eso se afirma, pero no se exige en DD-18 | J-04 | — |
| R2-I1 | SUGGESTION | DD-09 dice "unos 7 reencolados": con el calendario indicado son 6 | J-06 | R2-3 |
| R2-I2 | SUGGESTION | Liberación del semáforo SSH también ante el código 50 (evitar la fuga de cupos) | — | R2-4 |
| R2-I3 | SUGGESTION | Falta una fila en la tabla de redelivery de DD-20: el mismo `claimToken` con lease vigente | J-05 | — |
| R2-I4 | SUGGESTION | Runbook para liberar un mutex local atascado tras `UNKNOWN_TARGET_STATE` | J-07 | — |

### Estado del ciclo

- Rondas de corrección usadas: **1 de 2**. Re-juicios usados: **1 de 2**.
- R2-1 está confirmado por ambos jueces → elegible para la **ronda final de corrección** (con aprobación del owner), seguida del último re-juicio acotado.
- Estado de la transacción: **abierta**, esperando la decisión del owner (no está `approved` ni `escalated`).

## Correcciones — ronda 2 (final; aprobada por el owner el 2026-10-05)

Instrucciones del owner: corregir R2-1, R2-W1 a R2-W4 y R2-I1 a R2-I4. T9 solo para el código 50 (no es una vuelta atrás genérica). Revalidar la ventana en cada punto. Configuración segura por construcción y sin lógica Jenkins en el núcleo. Reconciliación de ventanas sin scans. `/work` con propiedad explícita. Preservar las dos capas, la precondición de migraciones, `DefinitionSource`, el runtime en el servidor existente, CodeBuild por app y ambiente y NFR-01. Añadir el repositorio canónico y la exclusión de los dos archivos de análisis.

| ID | Corrección (delta) | Dónde |
|---|---|---|
| R2-1 | Nueva §7.3: lista cerrada T1–T12. **T9 `RUNNING → WAITING_LOCK` solo `ssh` y solo con código 50.** Detalle: estados que lo reciben (solo `RUNNING`; se explica por qué no `DISPATCHING`), recursos liberados, identidad preservada, reintento, revalidación V3, idempotencia. Cualquier otra transición se rechaza (`INVALID_TRANSITION`). Los reintentos de `source`/`lambda`/`codebuild` quedan formalizados como T10 (nunca `ssh`) | design §7.3, §7 (`state-machine`, `step-dispatcher`), §2; requirements FR-05 (escenario nuevo) |
| R2-W1 | Revalidación en V1 (primer intento), V2 (cada reintento de lock), V3 (tras el 50) y V4 (justo antes del exec, con todo tomado). La ventana debe cubrir `now + timeout del step`. Motivos `NO_WINDOW`/`EXPIRED`/`INSUFFICIENT_REMAINING`. Ventana vencida durante un script en curso: no se aborta; `windowClosedDuringRun` | design §7.7, DD-09, DD-21, §7.2; requirements FR-18 (escenario nuevo) |
| R2-W2 | `externalDeployers` y `deployWindowPolicy` **obligatorios y sin default**. Desplegadores externos no vacíos ⇒ solo `required`. La apertura de ventana debe cubrir todos los `externalDeployers`. Validación en CI y al arrancar | design §7.7, DD-21, §7 (`definition-service`, `deploy-window-service`), P-13; requirements FR-02 (escenario nuevo) |
| R2-W3 | Ventanas `OPEN` con `activeStatus = WINDOW` y `deadlineAt = closesAt` en GSI2 disperso. Una `Query` por partición. Cierre condicional `EXPIRED`. Interacción con steps documentada | design §5.1, §7 (`reconciler`), §7.7 |
| R2-W4 | `instanceId` estable y único con lease `INSTANCE#` (no arranca si está duplicado). `/work/{instanceId}/{executionId}/{stepId}-{attempt}/`. Limpieza por ejecución, al arrancar (solo el propio subárbol) y de rezagados. Seguro con varias instancias | design §7.4, §5.1, DD-18, §7 (`main`) |
| R2-I1 | Calendario exacto en §7.6: 7 intentos y 6 reencolados como máximo sin contención, último retraso recortado a 870 s; decisión por espera real persistida | design §7.6, DD-09 |
| R2-I2 | Tabla de adquisición y liberación del handler SSH para cada salida; con el 50 se liberan el semáforo y el lock | design §7.5, DD-22 |
| R2-I3 | DD-20: filas "mismo `claimToken` con lease vigente" y "toma condicional fallida". Garantías de idempotencia reafirmadas | design DD-20 |
| R2-I4 | Runbook §12.1: el mutex es el bloqueo del kernel, no el archivo; evidencia por pasos; distingue deploy activo de estancado; nunca borrar el archivo; escalar si hay una migración en curso | design §12.1, §5.3 |
| Repo | §4.1: repositorio canónico; la raíz del repo reemplaza a `cicd-platform/`; `.gitignore` primero con los dos archivos de análisis; verificación con `git status`/`git ls-files` antes de cada commit; sin push en especificación; revisión del owner sobre detalles internos en specs antes del primer commit. P-25 verificada (`git ls-remote`), P-26 `UNVERIFIED` | design §4.1, §4.2, §11, Document Control |
| Gates | Nueva §14: bloqueos por gate A/B/C/D | design §14 |

Barrido de cierre: sin restos de `requiresDeployWindow` como mecanismo, `cicd-platform/` como raíz, "unos 7 reencolados" ni "quitando la marca". P-21 re-ejecutada tras la v3: `grep -rnil "akilia" .` → 2 archivos dentro de la spec y 0 fuera (exit 1).

## Ronda 3 — re-juicio final

| Juez | Veredicto | Ítems de la ronda 2 |
|---|---|---|
| A | **PASS** | R2-1, R2-W1 a R2-W4 y R2-I1 a R2-I4: todos RESOLVED |
| B | **PASS** | R2-1, R2-W1 a R2-W4 y R2-I1 a R2-I4: todos RESOLVED |

Ambos jueces volvieron a ejecutar `git ls-remote` (P-25: hash exacto `41f4c3e…`) y el grep de P-21 (2 archivos dentro de la spec, 0 fuera), y recontaron el Premise Ledger (27 filas: 3 verificadas y 24 `UNVERIFIED`, 10 High y 14 Low). Coincide. Ambos validaron que el código 50 **no** puede llegar en `DISPATCHING` (T6 ocurre justo antes del exec) y que T10 no reabre una vuelta atrás genérica ni aplica a `ssh`.

**Sin hallazgos CRITICAL ni SEVERE. Nada bloquea el Gate A.**

### Hallazgos informativos (sin auto-fix: se agotaron las rondas de corrección)

| ID | Severidad | Hallazgo | A | B |
|---|---|---|---|---|
| R3-1 | WARNING | En `design.md` la §14 "Gates" está físicamente antes de la §13 "Budget" (orden 12 → 14 → 13). Solo estructural | J-01 | R3-1 |
| R3-2 | WARNING | La lista cerrada de §7.3 no deja explícito cómo la recuperación de un build perdido por el reconciler (`BatchGetBuilds`, DD-04) se descompone en transiciones: `RUNNING` con `externalRef` → T8 es claro; `DISPATCHING` sin `externalRef` (re-despacho con el **mismo** token, DD-04) no tiene fila propia. Conviene explicitarlo antes de escribir el reconciler | J-02 | — |
| R3-3 | SUGGESTION | La fila "Revisión" de `requirements.md` menciona solo la ronda 1, aunque el cuerpo ya contiene los escenarios de la ronda 2 (FR-02, FR-05, FR-18) | — | R3-2 |
| R3-4 | SUGGESTION | Cerca del límite de 30 min, T5 (`LOCK_TIMEOUT`, en el handler) y T12 (`TIMED_OUT`, en el reconciler) compiten. La concurrencia optimista garantiza un único estado terminal, pero el código final no es determinista. Documentarlo como inocuo | — | R3-3 |

## Recibo terminal

| Campo | Valor |
|---|---|
| Target | `design.md` v3 (+ `requirements.md` ajustado) de `changes/cicd-executor-poc` |
| Rondas | 3 juicios (1 inicial + 2 re-juicios acotados) · 2 rondas de corrección (el máximo) |
| Confirmados SEVERE | Ronda 1: 2 (C-1, C-2) + 5 aprobados por el owner (S-1 a S-4, D-1) · Ronda 2: 1 (R2-1) · Ronda 3: 0 |
| Pendientes | 0 SEVERE · 4 informativos (R3-1 a R3-4), cuya aplicación como ajuste editorial decide el owner |
| Estado | **approved** |

**JUDGMENT: APPROVED ✅**

## Posterior al APPROVED — ajustes editoriales autorizados por el owner (2026-10-05)

No reabren el juicio: aplican los informativos R3-1 a R3-4 y la política de publicación.

| ID | Cambio |
|---|---|
| R3-1 | En `design.md`, §13 "Budget" ahora precede a §14 "Gates" |
| R3-2 | §7.3: nueva **T13**, re-despacho idempotente con el **mismo** `attempt` y `dispatchToken` (solo `codebuild` y `lambda`, una vez, controlado por `reconcileRedispatchCount`), más una tabla de recuperación del reconciler (T8/T13/T12). Ajustadas T12 y DD-04 |
| R3-3 | La fila "Revisión" de `requirements.md` refleja el Judgment Day completo (3 rondas, APPROVED) |
| R3-4 | **Regla canónica:** agotar la espera de lock termina **siempre** en `FAILED (LOCK_TIMEOUT)` por T5, la detecte el handler o el reconciler. T12 ya no aplica a `WAITING_LOCK`. Nuevo `AND IT MUST` en FR-11 |
| Publicación | Specs saneadas: ID de cuenta, región, hosts, IDs de credenciales, nombres de secretos, contenedores, puertos, repos ECR, función y bucket del PoC previo, tabla de Jenkins, canal de Slack, nombres y rutas de jobs de Jenkins, scripts residentes y detalles de vulnerabilidades de otros sistemas → referencias lógicas (`<…>`). Nueva DD-23: los valores reales se resuelven fuera de Git |
| Budget | Re-estimado en Phase 3: 37 tareas (antes 25) y ~50 rondas; LOC sin cambios (~8.700) |

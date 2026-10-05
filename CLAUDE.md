# onecgiar-cicd-platform

Plataforma CI/CD event-driven que reemplaza, por fases, las responsabilidades de Jenkins. Su pieza central es un **Executor liviano** que **coordina**: no compila, no construye imágenes y no se convierte en otro Jenkins.

## Fuentes de verdad

| Documento | Rol |
|---|---|
| `docs/specs/changes/cicd-executor-poc/proposal.md` | Intención aprobada. Hace de PRD del PoC |
| `docs/specs/changes/cicd-executor-poc/requirements.md` | Requisitos (FR/NFR) aprobados |
| `docs/specs/changes/cicd-executor-poc/design.md` | Diseño aprobado (Judgment Day APPROVED). Hace de TRD del PoC |
| `docs/specs/changes/cicd-executor-poc/tasks.md` | Plan por gates (A/B/C/D) |
| `docs/specs/changes/cicd-executor-poc/execution.md` | Bitácora de ejecución |

No hay `docs/prd.md`, `docs/trd/trd.md` ni `docs/ux-ui/design.md` (constitución mínima): los documentos de la spec cumplen ese papel. No hay UI.

## Stack

- Node.js 22 LTS (runtime e imagen), TypeScript estricto, ESM. Sin framework web (design DD-15). Ver `executor/package.json` (`engines`).
- Tests: `vitest`. Schemas: JSON Schema con `ajv`. AWS SDK v3. SSH: `ssh2`.
- Script del target: `bash` (corre en Linux; design §6.4).

## Comandos (dentro de `executor/`)

| Comando | Qué hace |
|---|---|
| `npm ci` | Instala dependencias del Executor |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Lint |
| `npm test` | Tests unitarios y de integración locales |
| `npm run validate` | Valida definiciones y registro, y corre las guardas de frontera (T-21) |
| `npm run check:local` | Gate local sin Docker: typecheck, lint, build, tests, `check:deps` |
| `npm run inspect:image` | Inspección real de la imagen (**requiere Docker**; validación diferida por entorno, obligatoria antes de desplegar) |

## Reglas no negociables

1. **Frontera del Executor (NFR-01).** El Executor no compila, no construye imágenes, no instala dependencias de aplicaciones, no ejecuta migraciones, no se conecta a BD de aplicación, no lee secretos de aplicación, no contiene lógica por proyecto (PRMS, Tanzania, MARLO, AICCRA…) ni lógica de Jenkins, y no interpreta expresiones. Si una tarea lo exige: **detenerse y escalar**.
2. **Máquina de estados cerrada** (design §7.3, T1–T13). Ninguna transición fuera de la lista.
3. **Corrección por escrituras condicionales** en DynamoDB (DD-03). Nada de estado en memoria como fuente de verdad.
4. **Dos capas de lock:** lock distribuido en DynamoDB y mutex local en el target. Ninguna reemplaza a la otra (DD-09, DD-22).
5. **`DefinitionSource`** es la única vía del núcleo a las definiciones (DD-19).
6. **Política de publicación** (design §4.1, DD-23): nunca commitear IDs de cuenta, hosts, IPs, IDs de credenciales, nombres de secretos reveladores, nombres de jobs de Jenkins, ni valores sensibles. Usar referencias lógicas (`<AWS_ACCOUNT_ID>`, `<PRMS_REPORTING_DEV_TARGET>`, …).
7. **Archivos solo locales:** `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` y `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` están en `.gitignore`. Antes de cada commit: `git status` y `git ls-files`, y comprobar que no aparecen.
8. **Decisiones abiertas** (OD-Q5, OD-Q7, OD-Q11 a OD-Q15, OD-N1): nunca se resuelven por suposición.
9. Commits con prefijo `[SPEC:changes/cicd-executor-poc]`.

## Model Routing

| Tier | Rol | Modelo |
|---|---|---|
| T1 | Leader / arquitectura / especificación | `opus` |
| T2 | Implementer | `sonnet` |
| T3 | Reviewer (author ≠ auditor) | `opus` |

## Skill Map

`tdd` (dominio y adaptadores) · `aws-serverless` (adaptadores AWS) · `error-handling-patterns` · `api-design-principles` (contratos y schemas) · `cognitive-doc-design` (documentación).

## Agentes

Personas en `.agents/` (`leader.md`, `implementer.md`, `reviewer.md`).

## Module Guides

Ninguno todavía.

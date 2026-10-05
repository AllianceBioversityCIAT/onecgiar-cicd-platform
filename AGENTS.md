# AGENTS.md

Las instrucciones del proyecto para cualquier agente están en `CLAUDE.md`, que es canónico; este archivo existe para herramientas que leen `AGENTS.md`. Las personas del triad Leader → Implementer → Reviewer están en `.agents/`.

Resumen operativo (si hay conflicto, manda `CLAUDE.md`):

- El Executor **coordina**: sin builds, sin BD, sin secretos de aplicación, sin lógica por proyecto ni de Jenkins, sin expresiones (NFR-01).
- La spec activa está en `docs/specs/changes/cicd-executor-poc/`.
- Nunca commitear identificadores internos ni los dos archivos `JENKINS_REPLACEMENT_*.md`.
- **Scope only grows through approval:** ningún agente amplía el alcance de una tarea sin aprobación del owner.

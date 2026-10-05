# AGENTS.md

The canonical project instructions for any agent are in `CLAUDE.md`. This file exists for tools that read `AGENTS.md`. The Leader → Implementer → Reviewer personas live in `.agents/`.

Operational summary (`CLAUDE.md` wins on any conflict):

- Everything committed to the repo (code, comments, tests, docs, commits) is in **English**.
- The Executor **coordinates**: no builds, no databases, no application secrets, no per-project or Jenkins logic, no expressions (NFR-01).
- The active spec is `docs/specs/changes/cicd-executor-poc/`.
- Never commit internal identifiers or the two `JENKINS_REPLACEMENT_*.md` files.
- **Scope only grows through approval:** no agent widens a task without the owner's approval.

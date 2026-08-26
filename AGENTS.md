# OrchBun agent workflow

- Before starting non-trivial project work, read `memory/agents/working/project-state.md`, `active-tasks.md`, `decisions.md`, `contracts.md`, and `risks.md`.
- Keep `memory/` local and ignored by Git. Keep this file and `ROADMAP.md` versioned as project-level contracts.
- Record durable outcomes that were directly prompted as immutable notes under `memory/agents/direct/YYYY/MM/`. Then run `npm run build`, `node dist/cli.js memory rebuild`, and `node dist/cli.js memory verify`.
- Files under `memory/agents/working/` are projections. Make persistent human edits through the Memory 1.0 web editor; it records local overrides under `memory/agents/manual/` and reapplies them after rebuilds.
- Do not scan raw run history or `memory/design/` unless the task explicitly requires it.
- Review mode is read-only. Use work mode only when edits are intended, and delegate bounded work only from a managed work-mode run.
- Mark a roadmap step complete only after both its work and its evidence pass. Approve a milestone manifest only after every step is checked and memory verification succeeds.
- Keep secrets in environment variables. Never write provider credentials to project memory.

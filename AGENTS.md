# OrchBun agent workflow

- Read `memory/agents/working/project-state.md`, `active-tasks.md`, `decisions.md`, `contracts.md`, and `risks.md` before non-trivial project work.
- Keep `memory/` local and ignored by Git. Keep this file and `ROADMAP.md` versioned as project-level contracts.
- Record durable directly prompted outcomes as immutable notes under `memory/agents/direct/YYYY/MM/`, then run `npm run build`, `node dist/cli.js memory rebuild`, and `node dist/cli.js memory verify`.
- Files under `memory/agents/working/` are projections. Persistent human edits belong in the Memory 1.0 web editor, which records local overrides under `memory/agents/manual/` and reapplies them after rebuilds.
- Do not scan raw run history or `memory/design/` unless a task explicitly requires it.
- Review mode is read-only. Use work mode only when edits are intended, and delegate bounded work only from a managed work-mode run.
- Mark a roadmap step complete only after its work and evidence pass. Approve a milestone manifest only after every step is checked and memory verification succeeds.
- Keep secrets in environment variables. Never write provider credentials into project memory.

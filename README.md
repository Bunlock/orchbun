<p align="center"><img src="ORCHBUN-logo.png" alt="OrchBun — open source AI agent memory" width="760"></p>

# OrchBun

OrchBun is a local-first agent manager for solo developers. It runs Codex, Claude Code, and OpenRouter agents with bounded context, records auditable results, maintains compact project memory, and provides a small local web workspace for everyday memory and roadmap work.

The memory server binds to `127.0.0.1`. Project memory remains in the project, is ignored by Git by default, and is never uploaded by OrchBun itself.

## What 1.0 includes

- Review-first agent runs with explicit work mode and bounded delegation.
- Optional managed work-run isolation with retained Git worktrees and narrowly mediated Compose runtimes.
- Immutable run journals plus compact direct-agent notes.
- Five persistent memory pages: project state, tasks, decisions, operational constraints, and risks/blockers.
- Markdown preview, syntax-colored raw view, and textarea editing in the local web workspace.
- A roadmap-backed Tasks page with Active, Blocked, and Done views.
- Severity and business-urgency selectors for tasks and risks, deriving P1–P5 action levels.
- Project-relative editors for the versioned roadmap and master `AGENTS.md`.
- Checklist-gated milestone approval and manifest-gated memory compaction.
- Deterministic Sleep and sweep maintenance—no model call required.
- A provider-neutral image-generation MCP surface with an optional Leonardo adapter.

## Requirements

- Node.js 22.5 or newer
- One or more provider CLIs/credentials for the agents you choose to run

## Install

From npm after publication:

```sh
npm install --global orchbun
```

From a source checkout:

```sh
npm install
npm run check
npm run build
npm link
```

## Initialize a project

Run this once at the project root:

```sh
orchbun init
```

Initialization is non-destructive. Existing files are preserved; missing `orchbun.yaml`, `ROADMAP.md`, `AGENTS.md`, and the `memory/` ignore rule are created. Local memory is initialized under `memory/agents/`.

Then open Memory 1.0:

```sh
orchbun memory web
```

Visit [http://127.0.0.1:4312](http://127.0.0.1:4312). Use `--port 4313` for another port.

The header derives the project name from its package metadata or directory and displays:

```text
<project name> | OrchBun memory 1.0
```

### Editing and project files

Each memory page supports Preview, Raw, Edit annotations, and Save. Human annotations stay under `memory/agents/manual/` and appear alongside generated state. Existing full-page overrides are preserved as annotations without rewriting their source files. They no longer hide newer recorded outcomes, task status, or risk resolution. The editor edits annotations only; Preview shows the combined result. Saves carry a source revision and reject outdated drafts before applying them.

The Project files page opens and edits project-relative Markdown paths. `ROADMAP.md` and `AGENTS.md` are the defaults. Absolute paths, non-Markdown files, and paths outside the project are rejected.

Roadmap checkboxes are validation gates. A milestone can be approved only when all of its steps are checked and `memory verify` passes. Approval creates a schema-valid local manifest under `memory/agents/milestones/<milestone>/approved.yaml`; compaction remains a separate, explicit publish action.

### Keeping project state current

`orchbun memory refresh` reads the roadmap, compact baseline, normalized run records, direct notes, and human annotations/qualifications. It publishes one revision shared by the web workspace and generated Markdown. Unchanged inputs keep the same revision and refresh time and do not rewrite pages. No model call, raw transcript scan, roadmap completion, archival, or rebuild hook is involved.

Managed agents calculate current context before a run and refresh after recording its outcome. `orchbun context`, run dry-runs, and `memory refresh --dry-run` calculate state without initializing memory or writing files. The web workspace checks on opening, refocusing, every 15 seconds while visible, and when Refresh is clicked. Saves refresh before returning. Unsaved drafts survive background refresh; a conflicting save reports that the draft has not been applied. Review updates displays the newer content alongside the preserved draft, so you can reconcile it before saving.

The header shows the last successful refresh and revision, separately from the last **recorded** verification. Refresh does not rerun tests. A failed refresh keeps the last valid snapshot available and shows the failure. Interrupted working-directory publication is recovered on the next publishing refresh.

For a direct agent outcome, prepare a project-relative Markdown file:

```markdown
# Task outcome
- **Agent:** codex
- **Recorded at:** 2026-09-05T12:00:00Z
- **Task:** APP-A1
- **Outcome:** Implemented the change; browser verification remains pending.
- **Decisions:** Keep the existing storage contract.
- **Risks or blockers:** Browser verification pending.
- **Next actions:** Verify APP-A1 in the browser.
- **Changed files:** src/example.ts
- **Verification:** Focused unit tests passed.
- **Status:** active
- **Work status:** partial
```

```sh
orchbun memory record --file outcome.md --json
orchbun memory refresh --dry-run --json
orchbun memory verify
```

Use the actual recording time. The record command fills missing Agent and Recorded at fields, validates the complete note before writing it, and gives it an immutable ID. Supplying Recorded at makes retrying identical content idempotent. `Supersedes` explicitly replaces older notes; `Subjects` groups them without deciding which is current. Work status is optional (`completed`, `partial`, `blocked`, or `cancelled`) and does not check a roadmap task. A note saved before a refresh failure remains recorded; correct the source issue and run `memory refresh`.

Risk bullets can carry a stable identity, for example `- [risk:browser-proof] Browser verification pending.` Keep the identity when editing the wording to retain its qualification and resolution. Existing unlabelled risks retain their content-based IDs.

### Roadmap format

A milestone is a level 2 to 4 heading of the form `<ID> — <Title>`, with an optional `Phase ` prefix: `## A — Foundation`, `### Phase E0 — Environment contract`. Headings without that shape are ordinary prose and leave the current milestone in place. A step is `- [ ] **<TASK-ID>** <title>`, continued on indented lines; checklist lines without a bold task ID are ignored by every gate.

`active-tasks.md` leads with the first incomplete milestone, then lists the remaining open steps under `## Scheduled`, so no known roadmap work is hidden while the current milestone stays in front.

`memory rebuild` also projects ad-hoc work back into the roadmap. Direct notes whose task and next actions name no roadmap step are written as a plain checklist between `<!-- orchbun:phase-p:start -->` and `<!-- orchbun:phase-p:end -->` under `## Phase P — Product work tracked in direct notes`, appended once if those markers are absent. Entries are checked only when their note explicitly records `Work status: completed`. Retired, superseded, or cancelled records without completed work appear separately; retiring memory does not establish delivery. Previously recorded delivered entries whose source has been archived remain in the historical checklist. Everything outside the markers is left byte for byte; the generated lines carry no task ID, so they never gate a milestone approval. A project with no ad-hoc notes and no markers is not touched.

### Severity, urgency, and priority

Tasks and risks use two independent inputs:

| Severity (technical impact) | High urgency | Medium urgency | Low urgency |
|---|---:|---:|---:|
| Critical — system/core flow down | P1 | P2 | P3 |
| Major — core function broken | P2 | P3 | P4 |
| Minor — cosmetic or typo | P3 | P4 | P5 |

- P1: immediate, all hands; workaround or fix within hours.
- P2: urgent; address within the same business day.
- P3: standard weekly sprint work.
- P4: target the next scheduled release.
- P5: retain in the backlog until capacity permits.

## CLI reference

OrchBun rejects unknown options and options that do not apply to the selected command.

| Command | Purpose | Relevant options |
|---|---|---|
| `orchbun init` | Initialize config, versioned master files, and ignored local memory | `--root`, `--json` |
| `orchbun context` | Print the exact bounded context without invoking an agent | run options, `--json` |
| `orchbun run` | Run an agent; review mode is the default | `--agent`, `--prompt`/`--prompt-file`, `--task`, `--mode`, `--context`, `--model`, `--dry-run`, `--json`, `--root` |
| `orchbun delegate` | Run a bounded child from a managed work-mode parent | run options |
| `orchbun workspaces list` | List retained managed worktree leases | `--json`, `--root` |
| `orchbun workspaces inspect` | Inspect one worktree/runtime lease | `--run`, `--json`, `--root` |
| `orchbun workspaces cleanup` | Remove one clean, merged worktree and its isolated runtime data | `--run`, `--json`, `--root` |
| `orchbun runtime status` | Show the current run's allowlisted Compose status | managed isolated runs only |
| `orchbun runtime rebuild` | Rebuild/recreate the current run's configured services | managed isolated runs only |
| `orchbun runtime logs` | Read the last 200 lines from the current run's configured services | managed isolated runs only |
| `orchbun memory show` | Refresh and print the five working pages | `--root` |
| `orchbun memory runs` | List managed runs and direct notes | `--root` |
| `orchbun memory refresh` | Refresh local project views, or calculate a read-only preview | `--dry-run`, `--json`, `--root` |
| `orchbun memory record` | Validate and append an immutable note, then refresh | `--file`, `--agent`, `--json`, `--root` |
| `orchbun memory rebuild` | Explicitly maintain the roadmap projection, refresh views, and run the configured hook | `--root` |
| `orchbun memory verify` | Validate runs, direct notes, manifests, archives, and image records | `--root` |
| `orchbun memory sleep` | Preview or publish deterministic roadmap reconciliation | `--dry-run`, `--json`, `--root` |
| `orchbun memory sweep` | Preview or publish lifecycle-aware archival and verification | `--dry-run`, `--json`, `--root` |
| `orchbun memory compact` | Publish one accepted manifest or all unpublished accepted manifests | `--milestone`/`--all`, `--manifest`, `--scope shared`, `--json`, `--root` |
| `orchbun memory web` | Start the local Memory 1.0 workspace | `--port`, `--root` |

Examples:

```sh
orchbun context --prompt "Review authentication boundaries" --task APP-A1
orchbun run --agent codex --prompt "Review APP-A1" --task APP-A1
orchbun run --agent codex --mode work --prompt "Implement APP-A1" --task APP-A1
orchbun memory sleep --dry-run
orchbun memory sweep --dry-run
orchbun memory compact --milestone a
orchbun memory compact --all
```

`--prompt-file` and `--context` paths must stay inside the project. Review mode is read-only. Work mode must be explicit. Delegation is accepted only inside a managed work-mode run and is bounded by `orchbun.yaml`.

To run a project-local command after a successful memory rebuild, configure the optional hook in `orchbun.yaml`:

```yaml
hooks:
  after_memory_rebuild: node scripts/update-roadmap.mjs
```

The command runs through the system shell with the project root as its working directory. A non-zero exit makes the rebuild fail, so hook commands should be trusted, deterministic project tooling.

## Managed work-run isolation

Isolation is opt-in. When enabled, each top-level work-mode run branches from the clean tracked `HEAD` into an ignored worktree under `memory/agents/worktrees/`. Review runs stay in the control checkout. Delegates inherit their parent's worktree and optional runtime, so they can inspect the same uncommitted changes instead of receiving a disconnected checkout.

```yaml
isolation:
  enabled: true
  branchPrefix: orchbun/
  worktreeDir: memory/agents/worktrees
  runtime:
    driver: compose
    composeFiles: [docker-compose.yml]
    services: [postgres, backend]
    projectPrefix: orchbun-myapp
    frontendPorts: [4201, 4299]
    backendPorts: [3201, 3299]
    databasePorts: [5501, 5599]
    backendPortEnv: BACKEND_PORT
    databasePortEnv: POSTGRES_PORT
    frontendUrlEnv: FRONTEND_URL
    healthUrl: http://127.0.0.1:{backendPort}/healthz
    healthTimeoutMs: 120000
```

The Compose project name, ports, endpoint environment, service allowlist, and Compose files come only from the recorded lease and trusted project configuration. During the run, a local run-scoped broker accepts only `status`, `rebuild`, and bounded `logs`; it does not accept arbitrary Docker or Compose arguments. The agent process is not put in Docker and is instructed not to invoke Docker directly. Adapter sandboxing remains part of the security boundary: this feature does not make an otherwise unrestricted same-user shell safe against deliberate Docker access.

At the end of a run, Orchbun stops the Compose project without deleting its isolated volumes and retains the branch/worktree for human review. `orchbun workspaces cleanup --run <id>` refuses dirty worktrees and branches not merged into the control checkout; after those checks pass, it removes only that lease's Compose volumes, worktree, and branch. Lease metadata remains under ignored memory for audit. The normal project stack and its ports are never selected by the allocator unless explicitly placed in the configured ranges.

## Memory layout

```text
project/
  AGENTS.md                 versioned agent contract
  ROADMAP.md                versioned milestone checklist
  orchbun.yaml              versioned OrchBun configuration
  memory/                   local and ignored
    agents/
      direct/               immutable compact notes
      manual/               persistent web edits and qualifications
      milestones/           accepted manifests
      runs/                 immutable managed-run journals
      leases/               worktree/runtime lease receipts
      worktrees/            retained isolated work checkouts
      working/              generated projections
      archive/              compaction and sweep snapshots
      sleep/                deterministic reconciliation snapshots
      refresh/              current project-state snapshot and recovery receipt
```

Raw prompts and native provider responses are retained for audit but never loaded automatically into future prompts. `memory/design/` is also opt-in context only.

Direct notes use `memory/agents/direct/YYYY/MM/<UTC timestamp>-<task-slug>.md` and record Agent, Recorded at, Task, Outcome, Decisions, Risks or blockers, Next actions, Changed files, Verification, and Status. `Supersedes` can retire obsolete state without deleting history. Optional `Subjects` entries use stable lowercase keys such as `memory/sleep` for deterministic grouping.

`memory sleep` resolves transitive supersession and lifecycle status before selecting follow-ups. Its content-addressed snapshot also contains a stable subject index: explicit `Subjects` first, exact roadmap task IDs second, and `unclassified` as the fallback. Multiple current heads under one subject are reported as parallel heads rather than merged implicitly.

## Accepted milestone compaction

Compaction consumes only schema-valid manifests whose review decision is `accepted`. It never summarizes a raw conversation. A manifest records validated outcomes, durable decisions, contracts, risks, pending work, artifacts, and exact superseded items.

```yaml
schema_version: "1.0"
milestone: a
scope: shared
review:
  decision: accepted
  accepted_at: 2026-08-12T12:00:00Z
  accepted_by: project-review
summary: Foundation is accepted.
validated_outcomes: [The acceptance suite passes.]
decisions: [Keep memory local-first.]
contracts: [The web server binds to 127.0.0.1.]
risks: []
pending_work: [Plan the next milestone.]
artifacts:
  - path: ROADMAP.md
    description: Validated project roadmap.
supersedes: []
```

Compaction archives the prior working tree with its manifest and publication receipt, publishes the accepted baseline atomically, and preserves human annotations alongside the accepted baseline.

## Provider-neutral image generation

The `orchbun-mcp` executable exposes `generate_image` and `get_image_generation`. Leonardo is the currently implemented adapter. `LEONARDO_API_KEY` is read only from the environment and is never written to memory.

```json
{
  "mcpServers": {
    "orchbun-images": {
      "command": "orchbun-mcp",
      "env": {
        "ORCHBUN_ROOT": "/absolute/path/to/project",
        "LEONARDO_API_KEY": "${LEONARDO_API_KEY}"
      }
    }
  }
}
```

Generation records are local, auditable, and excluded from prompt-loaded memory. A fake adapter can be used in tests without consuming provider credits.

## Contributing

OrchBun is MIT licensed and open to focused pull requests from humans and from agents working with human maintainers. Agent-authored PRs are welcome: disclose substantial agent assistance, include verification, and remain accountable for the submitted change. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Bunlock.

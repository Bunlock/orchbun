<p align="center"><img src="ORCHBUN-logo.png" alt="OrchBun — open source AI agent memory" width="760"></p>

# OrchBun

OrchBun is a local-first agent manager for solo developers. It runs Codex, Claude Code, and OpenRouter agents with bounded context, records auditable results, maintains compact project memory, and provides a small local web workspace for day-to-day memory and roadmap work.

The memory server binds to `127.0.0.1`. Project memory stays in the project, is ignored by Git by default, and is never uploaded by OrchBun itself.

## What 1.0 includes

- Review-first agent runs with explicit work mode and bounded delegation.
- Immutable run journals plus compact direct-agent notes.
- Five persistent memory pages: project state, tasks, decisions, APIs/contracts, and risks/blockers.
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

Each memory page supports Preview, Raw, Edit, and Save. Saved memory pages become persistent local overrides under `memory/agents/manual/`; rebuild and compaction reapply them instead of silently discarding edits.

The Project files page opens and edits project-relative Markdown paths. `ROADMAP.md` and `AGENTS.md` are the defaults. Absolute paths, non-Markdown files, and paths outside the project are rejected.

Roadmap checkboxes are validation gates. A milestone can be approved only when all of its steps are checked and `memory verify` passes. Approval creates a schema-valid local manifest under `memory/agents/milestones/<milestone>/approved.yaml`; compaction remains a separate, explicit publish action.

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
| `orchbun memory show` | Rebuild and print the five working pages | `--root` |
| `orchbun memory runs` | List managed runs and direct notes | `--root` |
| `orchbun memory rebuild` | Regenerate projections and reapply local overrides | `--root` |
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
      working/              generated projections
      archive/              compaction and sweep snapshots
      sleep/                deterministic reconciliation snapshots
```

Raw prompts and native provider responses are retained for audit but never loaded automatically into future prompts. `memory/design/` is also opt-in context only.

Direct notes use `memory/agents/direct/YYYY/MM/<UTC timestamp>-<task-slug>.md` and record Agent, Recorded at, Task, Outcome, Decisions, Risks or blockers, Next actions, Changed files, Verification, and Status. `Supersedes` can retire obsolete state without deleting history.

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

Compaction archives the prior working tree with its manifest and publication receipt, publishes the accepted baseline atomically, and reapplies intentional manual overrides.

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

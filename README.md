<p align="center"><img src="ORCHBUN-logo.png" alt="OrchBun — open-source AI multi-agent orchestration and memory" width="760"></p>

# OrchBun

**Local-first multi-agent orchestration and auditable project memory for solo developers.**

OrchBun runs Codex, Claude Code, and OpenRouter agents with bounded project context. It keeps an auditable local journal of prompts and results, maintains compact project memory, and lets an interactive Codex or Claude Code session coordinate background agents with isolated worktrees for work runs.

By default, memory stays under your project and is ignored by Git. When you run an agent, OrchBun sends the bounded memory and explicit context selected for that run to the chosen provider.

[npm](https://www.npmjs.com/package/orchbun) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/Bunlock/orchbun/issues) · [MIT license](LICENSE)

**Get started:** [Quick start](#quick-start) · [Agent providers](#agent-providers) · [Trust boundaries](#understand-the-trust-boundaries) · [Common workflows](#common-workflows)

**Reference:** [Configuration](#configuration) · [MCP setup](#orchestrate-from-codex-or-claude-code) · [Isolation](#managed-work-run-isolation) · [Memory lifecycle](#memory-lifecycle) · [CLI](#cli-reference) · [Troubleshooting](#troubleshooting)

## Quick start

You need Node.js 22.5 or newer, the Git CLI on `PATH` for agent runs, and at least one configured [agent provider](#agent-providers). The examples use Codex; replace `codex` with `claude` or `openrouter` when appropriate for your setup.

```sh
npm install --global orchbun
cd /path/to/your-project
orchbun init
```

`init` is non-destructive. It never overwrites existing project contracts; it creates missing files and may append the local-memory rule to `.gitignore`. A default setup adds `orchbun.yaml`, `AGENTS.md`, local memory, and an internal `ROADMAP.md`. A new interactive project opens a setup wizard; redirected input and `--json` use compatibility defaults.

Inspect the exact bounded prompt without invoking a provider:

```sh
orchbun context --agent codex --prompt "Review this project's error handling"
```

Run a review. Review mode is the default, so the agent should inspect and report without editing:

```sh
orchbun run --agent codex --prompt "Review this project's error handling"
```

Open the local Memory 1.0 workspace in another terminal:

```sh
orchbun memory web
```

Visit [http://127.0.0.1:4312](http://127.0.0.1:4312). The command keeps running until you stop it; use `--port 4313` if the default port is busy.

## What OrchBun does

### Bounded agent runs

- Runs Codex and Claude Code in review or work mode, and OpenRouter in review mode.
- Builds a size-limited prompt from the current project-memory pages and any project-relative files passed with `--context`.
- Records the source prompt, expanded prompt, provider-native response, normalized result, available usage metadata, and verification evidence locally.
- Rejects unknown options and options that do not apply to the selected command.

### Auditable project memory

- Keeps immutable run journals and schema-validated direct notes under ignored local memory.
- Projects current project state, tasks, decisions, operational constraints, and risks into compact Markdown pages.
- Provides deterministic local search, lifecycle-aware maintenance, and review-gated synthesis and compaction.
- Offers a loopback-only web workspace for memory, roadmap, task, and `AGENTS.md` work.

### Multi-agent orchestration

- Starts background agents, waits for them, resumes finished Codex and Claude sessions, and cancels runs from the CLI or MCP.
- Separates the master from managed runs: children return validated results; the master owns durable memory, integration, and end-to-end verification.
- Optionally gives each top-level work run a retained Git worktree and a narrowly mediated Compose runtime; delegates and follow-ups reuse it.

## Agent providers

`--agent` defaults to `agents.default`, which is `codex` unless configured otherwise.

| Provider | Setup | Modes | Session follow-up |
|---|---|---|---|
| Codex | Install the `codex` CLI and authenticate it in a terminal | Review and work | Yes |
| Claude Code | Install the `claude` CLI and authenticate it in a terminal | Review and work | Yes |
| OpenRouter | Set `OPENROUTER_API_KEY` | Review only | No |

OpenRouter uses `agents.openrouterModel` unless `--model` overrides it. Credentials belong in environment variables, never in `orchbun.yaml` or project memory.

Optional integrations have additional requirements:

- Isolated work runs additionally require an initialized Git repository. Detached work runs require `isolation.enabled: true`.
- Managed runtimes require Docker Compose and project-specific runtime configuration.
- MCP image tools appear only when `LEONARDO_API_KEY` is set; Leonardo is the currently implemented image provider.

## Understand the trust boundaries

OrchBun is local-first, not offline-only and not an isolation boundary for hostile code.

- The default `memory/` store is local plaintext and Git-ignored; it is not encrypted. `memoryDir` can be configured to another local directory.
- A run sends its bounded expanded prompt to the selected provider. That prompt can contain enabled memory pages and files explicitly passed with `--context`.
- Raw prompts and provider-native responses are retained locally for audit, but are not automatically loaded into later prompts.
- The Memory web workspace has no authentication. It binds to `127.0.0.1` and must not be exposed through a public bind or reverse proxy.
- Review mode uses provider-specific read-only or planning controls. In a Git workspace, OrchBun also checks Git-visible state afterward and marks the run failed if that state changed; this extra check is unavailable outside Git, does not detect ignored-file changes, and does not revert changes automatically.
- Work mode can edit files. Without isolation, a foreground work run edits the current checkout.
- External roadmap executables and `hooks.after_memory_rebuild` are trusted local code.
- The Compose broker limits normal managed-runtime commands, but it does not secure an otherwise unrestricted same-user shell against deliberate Docker access.

## Core concepts

| Term | Meaning |
|---|---|
| Review run | Read-only inspection. This is the default mode. |
| Work run | An explicit `--mode work` run that may edit files. |
| Master | The interactive human-facing session that starts runs, reviews work, integrates it, records durable memory, and performs final verification. |
| Managed run | A child agent that receives bounded context and returns one validated result. The CLI refuses durable record, compaction, rebuild, accepted-dream, published Sleep/sweep, and starting or steering background runs from that run. |
| Refresh | Reconciles current sources into generated views. It does not change roadmap completion or run rebuild hooks. |
| Rebuild | Validates direct notes, maintains the internal roadmap projection, refreshes views, and runs the configured trusted hook. |
| Sleep | Deterministically reconciles follow-ups, lifecycle state, and subject indexes. |
| Sweep | Previews or publishes lifecycle-aware archival and verification. |
| Dream | Produces a source-cited synthesis proposal; nothing changes until a reviewed proposal is explicitly accepted. |
| Compaction | Publishes an accepted milestone manifest and archives the prior working state. |

## Common workflows

### Review safely

The [quick start](#quick-start) shows the basic review flow. Add a stable roadmap task, a prompt file, or explicit project-relative context when the review needs them:

```sh
orchbun context --task APP-A1 --prompt-file request.md \
  --context docs/security.md,src/auth.ts
```

`memory/design/` and historical run output are never added automatically.

### Run foreground work

```sh
orchbun run --agent codex --mode work --task APP-A1 \
  --prompt "Implement APP-A1 and run its focused tests"
```

If isolation is disabled, this edits the current checkout. If isolation is enabled, OrchBun creates a retained worktree from tracked `HEAD`. A completed work run whose `--task` matches an internal-roadmap task checks that task automatically; external roadmap tasks change only through an explicit user action.

### Run work in the background

Background work requires isolation so parallel agents never share a checkout:

```yaml
isolation:
  enabled: true
```

Commit changes the child must see, and stash or discard unrelated tracked changes. Isolated work starts from tracked `HEAD`; staged and unstaged tracked changes and untracked files are not copied into the child worktree.

```sh
orchbun run --agent codex --mode work --task APP-A1 \
  --prompt "Implement APP-A1" --detach --json

# Copy run_id from the JSON response and replace RUN_ID below.
orchbun runs wait --run RUN_ID --timeout 1800
orchbun runs send --run RUN_ID --prompt "Also cover the empty-input case"
orchbun workspaces inspect --run RUN_ID
```

Review and merge the retained branch yourself. Cleanup is deliberately conservative:

```sh
orchbun workspaces cleanup --run RUN_ID
```

Cleanup refuses a dirty worktree or a branch that is not merged into the control checkout.

### Record durable memory

Create a project-relative Markdown note:

```markdown
# Authentication boundary completed

- **Agent:** codex
- **Recorded at:** 2026-10-05T12:00:00Z
- **Task:** APP-A1
- **Subjects:** security/auth
- **Outcome:** Added the boundary and focused tests.
- **Decisions:** Keep authorization in the service layer.
- **Risks or blockers:** Browser verification remains pending.
- **Next actions:** Verify the flow in the browser.
- **Changed files:** src/auth.ts, test/auth.test.ts
- **Verification:** Focused tests passed.
- **Status:** active
- **Work status:** partial
```

Then validate, record, and verify it:

```sh
orchbun memory record --file outcome.md
orchbun memory verify
```

`memory record` appends an immutable note and refreshes current views. Supplying `Recorded at` makes an identical retry idempotent. `Supersedes` retires older notes explicitly; `Subjects` groups notes without silently choosing a winner.

For routine state work:

```sh
orchbun memory refresh --dry-run   # read-only projection preview
orchbun memory refresh             # publish generated views
orchbun memory rebuild             # also maintain roadmap projection and run the hook
orchbun memory verify              # validate the complete local memory store
```

Refresh timestamps are not verification timestamps: refreshing does not rerun tests.

## Memory 1.0 workspace

```sh
orchbun memory web
```

The workspace provides:

- Preview, raw, and revision-checked editing for human annotations and custom memory pages.
- Active, blocked, and done roadmap views with severity and urgency ratings for tasks and risks.
- Project-confined Markdown editors for `AGENTS.md` and an internal roadmap.
- Explicit refresh, rebuild, verification, Sleep, sweep, milestone approval, and compaction actions.
- Conflict handling that preserves an unsaved draft while showing the newer source.

Built-in pages are generated from recorded sources; the editor saves only their human annotations. Custom pages store their full Markdown under `memory/agents/manual/pages/`. A milestone can be approved only after every step is checked and `memory verify` passes. Approval and compaction remain separate actions.

## Configuration

`orchbun init` creates `orchbun.yaml`. Omitted settings use validated defaults; this is a representative configuration:

```yaml
version: 1
memoryDir: memory/agents

budgets:
  maxInputChars: 12000
  maxFileChars: 3500
  maxOutputTokens: 1200
  recentRuns: 6

agents:
  default: codex
  openrouterModel: anthropic/claude-sonnet-4.5

delegation:
  maxDepth: 2
  defaultMode: review
  maxConcurrent: 4

memoryPages:
  enabled: [project-state, active-tasks, decisions, contracts, risks]
  custom: []

roadmap:
  provider: internal
  path: ROADMAP.md
```

Run the interactive configuration wizard later to change memory pages or the roadmap provider:

```sh
orchbun configure
```

`configure` requires a terminal. It previews and validates the change, preserves unrelated YAML keys and comments, and publishes atomically. Other settings remain manual YAML configuration.

### Custom memory pages

Custom pages are local processes such as invoices or release checklists. They are excluded from agent context unless `includeInContext` is explicitly enabled:

```yaml
memoryPages:
  enabled: [project-state, active-tasks, decisions, contracts, risks]
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
      starter: |
        # Invoices

        - [ ] Send this month's invoices.
```

Removing a custom page from configuration makes it dormant without deleting its Markdown. Re-adding the same stable ID restores it.

### External roadmaps

An external roadmap is a trusted local executable that maps Jira, Notion, or another system into OrchBun's provider-neutral protocol:

```yaml
roadmap:
  provider: external
  name: Jira
  command: [node, tools/orchbun-roadmap-provider.mjs]
```

OrchBun starts the command from the project root with `shell: false`, writes one JSON request to stdin, and reads one JSON response from stdout. A list request is:

```json
{"schema_version":"1.0","operation":"list"}
```

A successful response returns a stable revision and the complete ordered task snapshot:

```json
{
  "schema_version": "1.0",
  "revision": "jira-42",
  "tasks": [
    {
      "id": "APP-1",
      "title": "Connect the roadmap provider",
      "completed": false,
      "milestone_id": "A",
      "milestone_title": "Foundation"
    }
  ]
}
```

Completion requests include `task_id`, `completed`, and `expected_revision`; successful responses return the full new snapshot and `result: updated|unchanged`. Providers can return structured `conflict`, `not_found`, `unauthorized`, `unavailable`, or `invalid_request` errors. Credentials stay in the executable's environment. Stale cached data can be displayed, but cannot update tasks, publish Sleep, approve milestones, or pass a configuration preview.

## Orchestrate from Codex or Claude Code

The CLI works on its own. To let an interactive Codex or Claude Code master start and steer agents directly, register `orchbun-mcp`.

For Claude Code, add a project `.mcp.json`:

```json
{
  "mcpServers": {
    "orchbun": {
      "command": "orchbun-mcp",
      "env": { "ORCHBUN_ROOT": "/absolute/path/to/project" }
    }
  }
}
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.orchbun]
command = "orchbun-mcp"
env = { ORCHBUN_ROOT = "/absolute/path/to/project" }
tool_timeout_sec = 120
```

The server always exposes:

- `agent_start`
- `agent_send`
- `agent_status`
- `agent_wait`
- `agent_cancel`

`agent_start` returns immediately. `agent_wait` can wait for any or all selected runs, `agent_send` resumes a finished Codex or Claude session in the same mode and workspace, and cancellation retains any isolated workspace for inspection.

The intended master role records durable memory, runs end-to-end verification, reviews and merges worktrees, and commits. Managed agents should return outcomes, decisions, risks, blockers, file changes, and focused verification through their validated result.

When `LEONARDO_API_KEY` is present, the same MCP server also exposes `generate_image` and `get_image_generation`. Generation records remain local and are excluded from prompt-loaded memory.

## Managed work-run isolation

Isolation is disabled by default. When enabled:

- Top-level work runs receive a retained branch and worktree under ignored local memory.
- Review runs remain in the control checkout.
- Delegates and follow-ups reuse the original worktree and optional runtime.
- The tracked control checkout must be clean before a worktree is provisioned.
- Completion or cancellation stops the optional Compose project without deleting its volumes and retains the worktree for review.

An optional Compose runtime is configured entirely from trusted project settings:

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

Inside a managed runtime, agents can use only:

```sh
orchbun runtime status
orchbun runtime rebuild
orchbun runtime logs
```

The run-scoped broker derives the Compose project and ports from the recorded lease, and files, services, and environment names from trusted configuration. It accepts no arbitrary Docker or Compose arguments.

## Memory lifecycle

| Command | Effect |
|---|---|
| `memory show` | Publishes a refresh, then prints enabled pages. |
| `memory runs` | Lists managed runs and direct notes. |
| `memory search` | Deterministically searches current heads and accepted compact memory; `--history` opts into inactive and archived sources. |
| `memory dream` | Produces a cited proposal by task, subject, or all current memory; `--accept` records only an explicitly reviewed, revision-bound proposal. |
| `memory refresh` | Reconciles and publishes current views; `--dry-run` is read-only. |
| `memory record` | Validates and appends one immutable direct note, then refreshes. |
| `memory rebuild` | Validates direct notes, maintains the internal roadmap projection, refreshes, and runs the configured hook. |
| `memory verify` | Validates journals, notes, refresh state, Sleep, search, manifests, archives, and image records. |
| `memory sleep` | Reconciles follow-ups, lifecycle status, and subjects; `--dry-run` previews. |
| `memory sweep` | Performs lifecycle-aware archival and verification; `--dry-run` previews. |
| `memory compact` | Publishes an accepted milestone manifest and archives the previous working state. |
| `memory web` | Refreshes, then starts the loopback-only workspace; `--port` changes the default port 4312. |

`memory search` works when called explicitly, but search results are not yet added automatically to managed-run prompts.

### Memory layout

```text
project/
  AGENTS.md                 versioned agent contract
  ROADMAP.md                default internal milestone checklist
  orchbun.yaml              versioned OrchBun configuration
  memory/                   local and ignored
    agents/
      direct/               immutable compact notes
      manual/               annotations, qualifications, and custom pages
      milestones/           accepted manifests
      runs/                 prompts, results, native output, and worker logs
      leases/               worktree and runtime receipts
      worktrees/            retained isolated checkouts
      working/              generated projections
      archive/              compaction and sweep snapshots
      sleep/                deterministic reconciliation snapshots
      refresh/              current projection and recovery receipt
      search/               disposable local lexical index
      cache/roadmap/        validated external-roadmap snapshots
```

Generated `working/` pages are projections, not hand-edited authority. Built-in annotations and custom pages live under `manual/`; immutable direct notes and accepted manifests remain authoritative inputs.

### In-process memory API

Node.js consumers can use the typed ESM subpath:

```ts
import { MemoryService } from "orchbun/memory";

const memory = await MemoryService.open(projectRoot);
const result = memory.retrieve({ text: "authentication boundary", taskId: "APP-A1" });
const proposal = memory.proposeDream({ subject: "security/auth" });

// After human review:
await memory.acceptDream(proposal, reviewedMarkdown, "human-review");
```

`MemoryService.open()` is read-only. Only `refreshIndex()` publishes the disposable index, and only `acceptDream()` records an explicitly reviewed successor note. Neither archives nor compacts authoritative memory.

## CLI reference

| Command | Purpose | Key options |
|---|---|---|
| `orchbun init` | Initialize missing project contracts and ignored local memory | `--root`, `--json` |
| `orchbun configure` | Interactively change memory pages and roadmap setup | `--root` |
| `orchbun context` | Print bounded context without invoking a provider | `--prompt`/`--prompt-file`, `--agent`, `--task`, `--mode`, `--context`, `--model`, `--root`, `--json` |
| `orchbun run` | Run an agent; review is the default | context options plus mutually exclusive `--dry-run` or `--detach` |
| `orchbun delegate` | Run a bounded child from a managed work-mode parent | context options plus `--dry-run`; no `--detach` |
| `orchbun runs list` | List the 20 most recent runs | `--json`, `--root` |
| `orchbun runs status` | Inspect one run and its result | `--run`, `--json`, `--root` |
| `orchbun runs wait` | Wait for a background run; exit 1 on timeout | `--run`, `--timeout`, `--json`, `--root` |
| `orchbun runs send` | Continue a finished provider session | `--run`, `--prompt`/`--prompt-file`, `--json`, `--root` |
| `orchbun runs cancel` | Stop a background worker and retain any isolated workspace | `--run`, `--json`, `--root` |
| `orchbun workspaces list` | List retained isolation leases | `--json`, `--root` |
| `orchbun workspaces inspect` | Inspect one lease | `--run`, `--json`, `--root` |
| `orchbun workspaces cleanup` | Remove one clean, merged workspace and its isolated runtime data | `--run`, `--json`, `--root` |
| `orchbun runtime status\|rebuild\|logs` | Use the current managed Compose runtime | managed isolated runs only |
| `orchbun memory …` | Search, record, maintain, verify, compact, or view memory | See [Memory lifecycle](#memory-lifecycle); every subcommand also accepts `--root` |

Run `orchbun --help` for the exact synopsis. Options that do not apply to the selected command are rejected. Prompt, context, note, and project-editor paths are documented as project-relative inputs; trusted configuration and explicit manifest paths have their own validation rules.

## Troubleshooting

| Problem | What to check |
|---|---|
| `Could not find orchbun.yaml` | Run `orchbun init` at the project root, change into the initialized project, or pass `--root PATH`. |
| Codex or Claude authentication fails | Start that CLI in a normal terminal and complete its login before launching a headless run. |
| OpenRouter reports a missing key | Export `OPENROUTER_API_KEY` in the environment that starts OrchBun. OpenRouter supports review mode only. |
| `orchbun configure` refuses to run | The wizard requires interactive stdin and stdout. Edit YAML manually for automation. |
| Port 4312 is busy | Run `orchbun memory web --port 4313`. |
| Detached work is refused | Enable `isolation.enabled` and ensure the tracked control checkout is clean. |
| The isolated agent cannot see local edits | Worktrees start from tracked `HEAD`. Commit edits the child needs; stashed, staged, unstaged, and untracked files are not copied. |
| Workspace cleanup is refused | Commit or remove worktree changes, merge the retained branch into the control checkout, then retry. |
| `runtime` commands are unavailable | They work only inside a managed isolated run with a configured Compose runtime. |
| Generated memory looks stale | Run `orchbun memory refresh`; use `memory rebuild` only when you also want roadmap projection and the configured hook. |
| Sleep is stale after changing roadmaps | Publish a new snapshot with `orchbun memory sleep`. |
| Verification fails after an interrupted write | Correct the reported source or configuration problem, rerun refresh or rebuild as appropriate, then run `memory verify` again. |

## Development

From a source checkout:

```sh
npm install
npm run dev -- --help
npm run check
npm run build
npm link
```

The public package is intentionally focused. Cross-platform CI and installed-package smoke coverage, pluggable adapter conformance, and safe memory-metadata export/import remain open roadmap work; see [ROADMAP.md](ROADMAP.md).

## Contributing

Focused pull requests from humans and agents are welcome. Disclose substantial agent assistance, include verification, and remain accountable for the submitted change. Changes to memory publication, milestone approval, filesystem access, or work-mode execution need explicit safety notes. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Bunlock.

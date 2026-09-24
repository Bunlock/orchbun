<p align="center"><img src="ORCHBUN-logo.png" alt="OrchBun — open source AI agent memory" width="760"></p>

# OrchBun

OrchBun is a local-first agent manager for solo developers. It runs Codex, Claude Code, and OpenRouter agents with bounded context, records auditable results, maintains compact project memory, and provides a small local web workspace for everyday memory and roadmap work.

The memory server binds to `127.0.0.1`. Project memory remains in the project, is ignored by Git by default, and is never uploaded by OrchBun itself.

## What 1.0 includes

- Review-first agent runs with explicit work mode and bounded delegation.
- Optional managed work-run isolation with retained Git worktrees and narrowly mediated Compose runtimes.
- Immutable run journals plus compact direct-agent notes.
- Configurable persistent memory pages: select the built-in project state, tasks, decisions, operational constraints, and risks/blockers pages, then add local Markdown processes such as invoices.
- Markdown preview, syntax-colored raw view, and textarea editing in the local web workspace.
- A roadmap-backed Tasks page with Active, Blocked, and Done views.
- Severity and business-urgency selectors for tasks and risks, deriving P1–P5 action levels.
- Project-relative editors for the versioned roadmap and master `AGENTS.md`.
- Checklist-gated milestone approval and manifest-gated memory compaction.
- Internal Markdown or executable-backed external roadmaps, with revision-checked task updates.
- Deterministic Sleep and sweep maintenance—no model call required.
- Deterministic local retrieval and review-gated, source-cited memory dreams.
- A provider-neutral image-generation MCP surface with an optional Leonardo adapter.

## Requirements

- Node.js 22.5 or newer
- One or more provider CLIs/credentials for the agents you choose to run

## Install

From npm [https://www.npmjs.com/package/orchbun]:
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

## Initialize and configure a project

Run this once at the project root:

```sh
orchbun init
```

When `orchbun.yaml` does not exist and stdin/stdout are interactive terminals, `orchbun init` opens a setup wizard. It asks which roadmap to use, which built-in memory pages to enable, and whether to add custom Markdown processes. Custom pages are excluded from agent context unless you explicitly include them.

Initialization is non-destructive. Existing files are preserved; missing `orchbun.yaml`, `AGENTS.md`, and the configured memory ignore rule are created. An internal roadmap is created when selected; an external roadmap must pass a read-only provider check before any configuration is written. Existing projects do not reopen the wizard or rewrite their configuration.

Redirected or piped init, and `orchbun init --json`, remain noninteractive. A new project then uses the compatibility defaults: internal `ROADMAP.md`, all five built-in pages, and no custom pages. Local memory defaults to `memory/agents/`.

The relevant internal-roadmap configuration is:

```yaml
version: 1
memoryDir: memory/agents
memoryPages:
  enabled:
    - project-state
    - active-tasks
    - decisions
    - contracts
    - risks
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
      starter: |
        # Invoices

        - [ ] Send this month's invoices.
roadmap:
  provider: internal
  path: ROADMAP.md
```

Custom process IDs are stable lowercase slugs. Their full Markdown is stored under `memory/agents/manual/pages/<id>.md`; built-in pages continue to store only their human annotations under `memory/agents/manual/`.

Both `memoryPages` and `roadmap` are optional version 1 compatibility sections. Omitting them enables all five built-in pages in the order above and selects the existing local web-roadmap path when one was previously saved, otherwise `ROADMAP.md`.

The setup schema uses these limits:

- `memoryPages.enabled` is an ordered list of unique built-in IDs: `project-state`, `active-tasks`, `decisions`, `contracts`, and `risks`.
- `memoryPages.custom` accepts at most 50 entries. Each ID is a unique, non-reserved lowercase slug of at most 64 characters; each non-empty title is at most 120 characters; `includeInContext` is a boolean that defaults to `false`; and optional starter Markdown is at most 64,000 characters.
- An internal `roadmap.path` is a project-relative `.md` path that stays inside the project after symlinks are resolved.
- An external roadmap name is at most 120 characters. Its `command` is a JSON/YAML string array with 1 to 64 arguments, each at most 4,096 characters; the first argument is a non-empty executable. Credentials belong in the provider process environment, never in this array.

### Change setup choices later

Run the interactive configuration wizard from an initialized project:

```sh
orchbun configure
```

`orchbun configure [--root PATH]` preselects the current choices and shows the effects before applying them. It manages only `memoryPages` and `roadmap`; unrelated settings, unknown keys, and YAML comments remain in place. The command requires an interactive terminal. If the selected internal roadmap does not exist, OrchBun creates it only after the wizard asks for that file explicitly. The configured page order is also the order used by `memory show` and the Memory workspace tabs.

Before applying, OrchBun validates the candidate YAML, parses or prepares the internal roadmap, performs a read-only external-provider request when applicable, and builds a complete dry-run memory projection. It then takes the projection lock, checks that `orchbun.yaml` has not changed since review, stages new starter files, replaces the configuration atomically, and publishes the refreshed projection. A validation or preview failure changes nothing. If publication fails, OrchBun restores the prior configuration and removes only unchanged files created by that attempt. A concurrent human edit is preserved rather than overwritten during apply or rollback. If the process stops during publication, the next OrchBun command detects the transaction receipt and finishes cleanup or restores the previous configuration and projection before loading project state.

Configuration changes have these effects:

- Disabling a built-in page removes its generated working page, web tab, search document, and normal agent-context entry. Its recorded source data and manual annotation remain local and return when the page is enabled again.
- Removing a custom page removes its working, web, search, and context entries. Its `manual/pages/<id>.md` source remains dormant; adding the same ID restores its contents. Renaming changes the displayed title without changing the ID or file.
- Turning `includeInContext` off excludes a custom page from both baseline context and retrieval. Custom pages default to off.
- Changing roadmap providers does not delete or edit the previous `ROADMAP.md`, external cache, provider data, run history, direct notes, approved manifests, or compact archives. Task qualifications follow matching stable task IDs; unmatched qualifications remain dormant.
- A roadmap-source change makes an existing Sleep snapshot stale. Publish a fresh one explicitly with `orchbun memory sleep`.

Manual `orchbun.yaml` edits remain supported. Every command validates the loaded configuration. Preview their projected effect without publishing files:

```sh
orchbun memory refresh --dry-run
```

Invalid manual configuration stops the command while leaving the last published memory snapshot intact.

### External roadmap providers

An external roadmap is a trusted local executable configured as an argument array:

```yaml
memoryPages:
  enabled: [project-state, active-tasks, decisions, contracts, risks]
  custom: []
roadmap:
  provider: external
  name: Jira
  command: [node, tools/orchbun-roadmap-provider.mjs]
```

OrchBun starts the command from the project root with `shell: false`, sends one JSON object followed by a newline on stdin, and reads one JSON response from stdout. The default timeout is 30 seconds and stdout/stderr are each limited to 1 MiB. The executable maps Jira, Notion, or another system into this provider-neutral protocol.

List request:

```json
{"schema_version":"1.0","operation":"list"}
```

Completion request:

```json
{"schema_version":"1.0","operation":"set_completion","task_id":"APP-1","completed":true,"expected_revision":"jira-42"}
```

Every successful response returns the complete ordered task snapshot. A completion response also returns `updated` or `unchanged`:

```json
{
  "schema_version": "1.0",
  "revision": "jira-43",
  "result": "updated",
  "tasks": [
    {
      "id": "APP-1",
      "title": "Connect the roadmap provider.",
      "completed": true,
      "milestone_id": "A",
      "milestone_title": "Foundation"
    }
  ]
}
```

For a list response, omit `result`. Task IDs must be unique, one milestone ID must always use the same title, order must be deterministic, and a revision must identify exactly one snapshot. Providers report structured `conflict`, `not_found`, `unauthorized`, `unavailable`, or `invalid_request` errors:

```json
{
  "schema_version": "1.0",
  "error": {
    "code": "conflict",
    "message": "The roadmap changed.",
    "actual_revision": "jira-44"
  }
}
```

A minimal persistent executable provider can use the same JSON shape locally:

```js
#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const stateFile = new URL("../roadmap-provider-state.json", import.meta.url);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const state = JSON.parse(await readFile(stateFile, "utf8"));
const send = (value, exitCode = 0) => {
  process.stdout.write(JSON.stringify(value));
  process.exitCode = exitCode;
};

if (request.operation === "list") {
  send({ schema_version: "1.0", ...state });
} else if (request.operation === "set_completion") {
  if (request.expected_revision !== state.revision) {
    send({
      schema_version: "1.0",
      error: { code: "conflict", message: "Revision changed", actual_revision: state.revision },
    }, 2);
  } else {
    const task = state.tasks.find((item) => item.id === request.task_id);
    if (!task) {
      send({ schema_version: "1.0", error: { code: "not_found", message: "Task not found" } }, 2);
    } else {
      const result = task.completed === request.completed ? "unchanged" : "updated";
      task.completed = request.completed;
      if (result === "updated") state.revision = randomUUID();
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      send({ schema_version: "1.0", result, ...state });
    }
  }
} else {
  send({ schema_version: "1.0", error: { code: "invalid_request", message: "Unknown operation" } }, 2);
}
```

Seed `roadmap-provider-state.json` with a `revision` and `tasks` array matching the response example. Real integrations should read API tokens and other credentials from environment variables. Never place provider credentials in `orchbun.yaml`, provider output, or project memory.

Validated external snapshots are cached under ignored local memory. When a provider is unavailable, an explicitly stale-tolerant read may display the last snapshot with a stale warning. Stale data cannot update tasks, publish Sleep, approve milestones, or pass a configuration preview. Authorization, schema, and integrity errors never fall back to the cache. OrchBun never creates external tasks, and external task completion happens only through an explicit user checkbox.

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

The Project files page opens and edits project-relative Markdown paths. `AGENTS.md` is always available, and the configured roadmap editor is available for internal Markdown roadmaps. External roadmaps show their provider identity and freshness instead of exposing a local roadmap editor. Absolute paths, non-Markdown files, and paths outside the project are rejected.

Roadmap checkboxes are validation gates. A milestone can be approved only when all of its steps are checked and `memory verify` passes. Approval creates a schema-valid local manifest under `memory/agents/milestones/<milestone>/approved.yaml`; compaction remains a separate, explicit publish action.

### Keeping project state current

`orchbun memory refresh` reads the roadmap, compact baseline, normalized run records, direct notes, and human annotations/qualifications. It publishes one revision shared by the web workspace and generated Markdown. Unchanged inputs keep the same revision and refresh time and do not rewrite pages. No model call, raw transcript scan, roadmap completion, archival, or rebuild hook is involved.

Managed agents calculate current context before a run and refresh after recording its outcome. `orchbun context`, run dry-runs, and `memory refresh --dry-run` calculate state without initializing memory or writing files. The web workspace checks on opening, refocusing, every 15 seconds while visible, and when Refresh is clicked. Saves refresh before returning. Unsaved drafts survive background refresh; a conflicting save reports that the draft has not been applied. Review updates displays the newer content alongside the preserved draft, so you can reconcile it before saving.

Published refreshes also maintain a disposable lexical index under `memory/agents/search/`. Managed runs receive the enabled built-in pages plus custom pages explicitly included in context while OrchBun builds a retrieval candidate in shadow mode and stores only comparison metadata in the run's context receipt; retrieved content is not promoted into production prompts yet. The candidate reserves its budget for enabled authority pages before source-cited query evidence. A missing or invalid index is rebuilt in memory, and an index-publication failure cannot block authoritative refresh; the authoritative Markdown and JSON records remain unchanged.

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

Use the actual recording time. The record command fills missing Agent and Recorded at fields, validates the complete note before writing it, and gives it an immutable ID. Supplying Recorded at makes retrying identical content idempotent. `Supersedes` explicitly replaces older notes; `Subjects` groups them without deciding which is current. Reviewed syntheses may also carry `Sources` and `Based on revision`. Work status is optional (`completed`, `partial`, `blocked`, or `cancelled`) and does not check a roadmap task. A note saved before a refresh failure remains recorded; correct the source issue and run `memory refresh`.

Risk bullets can carry a stable identity, for example `- [risk:browser-proof] Browser verification pending.` Keep the identity when editing the wording to retain its qualification and resolution. Existing unlabelled risks retain their content-based IDs.

### Internal roadmap format

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
| `orchbun configure` | Interactively review and change memory-page and roadmap setup | `--root` |
| `orchbun context` | Print the exact bounded context without invoking an agent | run options, `--json` |
| `orchbun run` | Run an agent; review mode is the default | `--agent`, `--prompt`/`--prompt-file`, `--task`, `--mode`, `--context`, `--model`, `--dry-run`, `--detach`, `--json`, `--root` |
| `orchbun runs list` | List the 20 most recent runs with their status | `--json`, `--root` |
| `orchbun runs status` | Show one run, including its result once finished | `--run`, `--json`, `--root` |
| `orchbun runs wait` | Block until a background run finishes; exit code 1 on timeout | `--run`, `--timeout`, `--json`, `--root` |
| `orchbun runs send` | Continue a finished run's agent session in the background | `--run`, `--prompt`/`--prompt-file`, `--json`, `--root` |
| `orchbun runs cancel` | Stop a background run and its agent process | `--run`, `--json`, `--root` |
| `orchbun delegate` | Run a bounded child from a managed work-mode parent | run options |
| `orchbun workspaces list` | List retained managed worktree leases | `--json`, `--root` |
| `orchbun workspaces inspect` | Inspect one worktree/runtime lease | `--run`, `--json`, `--root` |
| `orchbun workspaces cleanup` | Remove one clean, merged worktree and its isolated runtime data | `--run`, `--json`, `--root` |
| `orchbun runtime status` | Show the current run's allowlisted Compose status | managed isolated runs only |
| `orchbun runtime rebuild` | Rebuild/recreate the current run's configured services | managed isolated runs only |
| `orchbun runtime logs` | Read the last 200 lines from the current run's configured services | managed isolated runs only |
| `orchbun memory show` | Refresh and print the enabled working pages | `--root` |
| `orchbun memory runs` | List managed runs and direct notes | `--root` |
| `orchbun memory search` | Search current memory, with explicit opt-in historical recall | `--query`, `--task`, `--subject`, `--history`, `--json`, `--root` |
| `orchbun memory dream` | Preview or explicitly accept a cited synthesis proposal | `--task`/`--subject`/`--all`, `--out`, `--accept`, `--agent`, `--json`, `--root` |
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
orchbun memory search --query "authentication boundary" --task APP-A1
orchbun memory dream --subject memory/auth --out review-auth-memory.md
orchbun memory dream --accept review-auth-memory.md --agent human-review
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

## Orchestrating agents from a master session

Any interactive Claude Code or Codex session can act as a master that starts, follows, and steers other Codex and Claude runs. You keep talking to the master as usual; the other agents run headless in the background and report back to it.

- `orchbun run --detach` (or the `agent_start` MCP tool) validates the request, prepares its context and worktree, records the run, and returns its id immediately. A detached worker process then runs the agent.
- `orchbun runs wait --run <id>` blocks until that run finishes and prints its summary. A Claude Code master runs it as a background command and is woken when it exits. A Codex master calls `agent_wait`, which returns early after `timeout_seconds` (default 50) so it stays under MCP tool timeouts.
- `orchbun runs send --run <id>` (or `agent_send`) continues a finished run's Codex thread or Claude session, in the same worktree and mode, with a short follow-up prompt.
- `orchbun runs cancel --run <id>` (or `agent_cancel`) stops the worker and its agent process group. The run is recorded as `interrupted` and its worktree is kept. A worker that dies without recording a result is also reported as `interrupted`.

Roles are split deliberately:

- **Master:** records durable memory, runs end-to-end verification, reviews and merges each worktree, and commits.
- **Managed runs:** report outcomes, decisions, risks, and verification only in their JSON result. When no Orchbun-managed runtime is configured, they verify with unit tests only and do not start dev servers, browsers, end-to-end suites, or Docker. Inside a managed run, `memory record`, `compact`, `rebuild`, `dream --accept`, publishing `sleep`/`sweep`, `run`, and `runs send|cancel` are refused; read-only commands and `delegate` still work.

Background work runs require `isolation.enabled: true`, so parallel agents never share a checkout. Worktrees start from the clean tracked `HEAD`, so commit or stash master changes that the agents need to see. `delegation.maxConcurrent` (default 4) caps active background runs:

```yaml
delegation:
  maxConcurrent: 4
isolation:
  enabled: true
```

Register the MCP server once per master client. For Claude Code, add it to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "orchbun": { "command": "orchbun-mcp", "env": { "ORCHBUN_ROOT": "/absolute/path/to/project" } }
  }
}
```

For Codex, add it to `~/.codex/config.toml`:

```toml
[mcp_servers.orchbun]
command = "orchbun-mcp"
env = { ORCHBUN_ROOT = "/absolute/path/to/project" }
tool_timeout_sec = 120
```

Headless children use each CLI's own login: run `claude` or `codex login` in a terminal once if a child reports an authentication error.

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
  ROADMAP.md                default internal milestone checklist
  orchbun.yaml              versioned OrchBun configuration
  memory/                   local and ignored
    agents/
      direct/               immutable compact notes
      manual/               built-in annotations, custom process pages, and qualifications
        pages/              authoritative custom-page Markdown by stable ID
      milestones/           accepted manifests
      runs/                 immutable managed-run journals
      leases/               worktree/runtime lease receipts
      worktrees/            retained isolated work checkouts
      working/              generated projections
      archive/              compaction and sweep snapshots
      sleep/                deterministic reconciliation snapshots
      refresh/              current project-state snapshot and recovery receipt
      search/               disposable versioned lexical index
      cache/roadmap/         validated external-roadmap snapshots
```

Raw prompts and native provider responses are retained for audit but never loaded automatically into future prompts. `memory/design/` is also opt-in context only.

Direct notes use `memory/agents/direct/YYYY/MM/<UTC timestamp>-<task-slug>.md` and record Agent, Recorded at, Task, Outcome, Decisions, Risks or blockers, Next actions, Changed files, Verification, and Status. `Supersedes` can retire obsolete state without deleting history. Optional `Subjects` entries use stable lowercase keys such as `memory/sleep` for deterministic grouping.

`memory search` returns current heads and the accepted compact baseline by default. `--history` additionally exposes superseded, retired, and archived records with explicit lifecycle labels. Ranking is deterministic: exact task, exact subject, lexical relevance, then timestamp and stable ID.

`memory dream` is extractive and read-only until acceptance. It writes an editable Markdown draft with hidden revision-bound proposal metadata, inline source citations, conflicts, retirement candidates, and proposed supersession targets. Parallel heads are visible and omitted from supersession by default; resolving them requires an explicit, machine-validated review entry. Acceptance validates the revision, citations, and older current supersession targets under the projection lock before recording a new direct note. It never invokes sweep or compaction.

## In-process memory API

The same capability is available to Node.js consumers through the typed ESM subpath:

```ts
import { MemoryService } from "orchbun/memory";

const memory = await MemoryService.open(projectRoot);
const result = memory.retrieve({ text: "authentication boundary", taskId: "APP-A1" });
const proposal = memory.proposeDream({ subject: "memory/auth" });
// After human review:
await memory.acceptDream(proposal, reviewedMarkdown, "human-review");
```

`MemoryService.open()` is read-only. Only `refreshIndex()` publishes the disposable index, and only `acceptDream()` records an explicitly reviewed successor note. Neither method archives or compacts authoritative memory.

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

The `orchbun-mcp` executable also exposes `generate_image` and `get_image_generation` when `LEONARDO_API_KEY` is set. Leonardo is the currently implemented adapter. `LEONARDO_API_KEY` is read only from the environment and is never written to memory.

```json
{
  "mcpServers": {
    "orchbun": {
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

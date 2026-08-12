# Orchbun

Orchbun is a local TypeScript CLI that orchestrates Codex, Claude Code, and OpenRouter while keeping a compact, auditable project memory.

Its code lives in `/Users/bunlock/orchbun`.

## Install and verify

```sh
cd /Users/bunlock/orchbun
npm install
npm run check
npm run build
npm link
```

This exposes the `orchbun` command. The project repository also provides `pnpm orchbun`, which builds and runs the sibling tool without requiring a global link.

## Use with project

```sh
cd /orchbun/project
pnpm orchbun memory init
pnpm orchbun context --prompt "Review the XX" --task ABC-1
pnpm orchbun run --agent codex --prompt "Review XX" --task ABC-1
pnpm orchbun run --agent codex --mode work --prompt "Implement ABC-1" --task ABC-1
```

Inside a managed work-mode agent run:

```sh
pnpm orchbun delegate --agent claude --prompt "Review the current changes"
```

Delegates default to `review`; editing requires `--mode work`. A review-mode parent cannot delegate because its process is read-only.

When a work-mode run with a task id finishes with `outcome: completed`, Orchbun atomically marks
the matching `- [ ] **TASK-ID**` entry in `ROADMAP.md` as complete. Review runs never change the
roadmap, and task ids not present in the roadmap are ignored.

## Recorded architecture

Every managed run writes into the target workspace, not the Orchbun source directory:

```text
project/memory/agents/runs/YYYY/MM/<run-id>/
  metadata.yaml
  prompt.md
  prompt.expanded.md
  context.json
  events.jsonl or response.native.json
  result.json
  summary.md
```

Generated compact context is stored in `project/memory/agents/working/`. Raw history and `project/memory/` are never loaded automatically.

Agents prompted outside Orchbun can contribute compact notes under
`project/memory/agents/direct/YYYY/MM/<UTC timestamp>-<task-slug>.md`. Each note must contain
the labeled fields `Task`, `Outcome`, `Decisions`, `Risks or blockers`, `Next actions`,
`Changed files`, and `Verification`. New notes also carry `Agent`, `Recorded at` (matching the
filename), and `Status` (`active`, `retired`, or `superseded`; retired notes include a `Reason`).
Orchbun validates and merges active notes into working
memory before showing memory or building managed-agent context. An optional `Supersedes`
field can name earlier direct-note IDs whose current decisions, risks, and next actions should
be retired while their history remains indexed.

## Accepted milestone compaction

Compaction is a post-review gate. Review writes
`memory/agents/milestones/<name>/approved.yaml`; `/compact` refuses any manifest whose review
decision is not `accepted`, and it never summarizes raw provider conversation. The manifest
records the accepted summary, validated outcomes, durable decisions, APIs/contracts, risks,
pending work, artifact references, and any exact prior memory items superseded by the milestone.

```yaml
schema_version: "1.0"
milestone: hex-a3
scope: shared
review:
  decision: accepted
  accepted_at: 2026-08-10T14:00:00Z
  accepted_by: gameplay-review
summary: Deterministic replay is accepted.
validated_outcomes: [Golden replay vector passes.]
decisions: [Use mulberry32 for replay seeds.]
contracts: [Replay consumes the append-only action log.]
risks: [Old saves need a version adapter.]
pending_work: [Plan persistence integration.]
artifacts:
  - path: packages/sim-battle/src/seeded-random.ts
    description: Canonical PRNG implementation.
supersedes: []
```

Publish it with:

```sh
pnpm orchbun memory compact --milestone hex-a3
```

Use `--scope shared` explicitly if desired; shared is the default. Pass
`--manifest path/to/approved.yaml` to consume a reviewed manifest outside the default milestone
directory. The slash-style `pnpm orchbun /compact milestone=hex-a3 scope=shared` remains an alias.

To compact every accepted manifest that has not already been archived:

```sh
pnpm orchbun memory compact --all
```

`--all` validates the complete set before publishing, processes it in review-acceptance order,
and skips manifests whose content hash is already in the immutable archive. It remains
manifest-gated; it does not compact raw conversations or unreviewed work. The slash alias also
accepts `pnpm orchbun /compact --all`.

The command stages a complete replacement, archives the prior `working/` tree with the approved
manifest and publication receipt, then swaps in the milestone baseline under the memory lock.
Subsequent rebuilds retain that baseline and ingest only records created after compaction.

## Deterministic memory sleep

`memory sleep` reconciles generated active tasks with `ROADMAP.md` without using an AI model.
It treats the first milestone containing an unchecked stable task ID as active, keeps later
milestones scheduled, and removes completed-task, scheduled-task, and unlinked follow-ups from
prompt-loaded `working/active-tasks.md`. Direct notes and managed run history remain immutable.

Preview the reconciliation first:

```sh
pnpm orchbun memory sleep --dry-run
```

Publish it with:

```sh
pnpm orchbun memory sleep
```

Publication records a content-addressed audit snapshot under `memory/agents/sleep/snapshots/`
and enables roadmap reconciliation for future memory rebuilds. Repeating Sleep with unchanged
inputs reuses the same snapshot. This first deterministic phase does not rank or semantically
merge decisions and risks.

## Leonardo image generation over MCP

Orchbun exposes a local stdio MCP server with a provider-neutral `generate_image` tool and a
`get_image_generation` status tool.
Leonardo is the only implemented image provider; no unofficial Midjourney automation is included.

The provider uses Leonardo's official REST API so Orchbun can persist the full lifecycle. It submits
Lucid Origin jobs through `POST /v2/generations`, then polls the documented v1 generation endpoint.
The API key is read only from `LEONARDO_API_KEY` and is never written to memory.

Build the project, then configure an MCP client to launch the local server:

```json
{
  "mcpServers": {
    "orchbun-images": {
      "command": "node",
      "args": ["/Users/bunlock/orchbun/dist/mcp.js"],
      "env": {
        "ORCHBUN_ROOT": "/Users/bunlock/orchbun/hexarch",
        "LEONARDO_API_KEY": "${LEONARDO_API_KEY}"
      }
    }
  }
}
```

Example `generate_image` arguments:

```json
{
  "provider": "leonardo",
  "project": "hexarch",
  "assetType": "system-view-icon",
  "prompt": "A legible orbital command base signifier on dark space",
  "parameters": {
    "model": "lucid-origin",
    "width": 1024,
    "height": 1024,
    "count": 4,
    "mode": "FAST",
    "public": false
  },
  "references": [
    {
      "id": "LEONARDO_UPLOADED_IMAGE_ID",
      "type": "uploaded",
      "purpose": "style",
      "strength": "high",
      "sourceUrl": "https://example.invalid/audit-reference.png"
    }
  ],
  "parentGenerationId": null,
  "waitForCompletion": true
}
```

Records are stored under `memory/agents/generations/YYYY/MM/<generation-id>/record.json`.
Each record contains the provider, project, asset type, exact prompt, parameters, references,
request/update/completion timestamps, Leonardo generation ID and status, result URLs, errors,
and the optional local `parentGenerationId`. `memory verify` validates these records, but they
are intentionally excluded from compact agent prompt context.

If polling times out or hits a transient status error, the record remains `processing` with its
external generation ID and a retryable error. Call `get_image_generation` with the local
`generationId` to refresh it. The same journal update boundary can later accept an authenticated
Leonardo webhook without opening a public listener in this local stdio server.

## Maintenance

```sh
pnpm orchbun memory show
pnpm orchbun memory runs
pnpm orchbun memory verify
pnpm orchbun memory rebuild
pnpm orchbun memory sleep --dry-run        # preview deterministic task pruning
pnpm orchbun memory sleep                  # publish and enable roadmap reconciliation
pnpm orchbun memory sweep --dry-run        # preview lifecycle/archive changes
pnpm orchbun memory sweep                  # snapshot, archive explicit stale records, rebuild, verify
pnpm orchbun memory compact --milestone <name> # one accepted milestone
pnpm orchbun memory compact --all              # every unpublished accepted milestone
pnpm orchbun memory web                         # local viewer at http://127.0.0.1:4312
```

`memory init` creates both managed and direct-memory structures. `memory show` rebuilds and
prints unified projections, `memory runs` lists managed runs and direct notes, `memory rebuild`
regenerates projections from both sources, and `memory verify` also validates image records.
`memory web` rebuilds and opens a local-only web view of the five generated working
memory pages. Its maintenance controls run the same rebuild, verify, Sleep, sweep, and
accepted-milestone compaction operations as the CLI; publishing controls require a browser
confirmation. It never serves raw prompts, run events, or direct-note source files. Use
`--port 4313` to choose another local port.

The target workspace’s `orchbun.yaml` controls input limits, per-file limits, output limits,
delegation depth, and image polling defaults.

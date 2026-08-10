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
`Changed files`, and `Verification`. Orchbun validates and merges these notes into working
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
pnpm orchbun /compact milestone=hex-a3 scope=shared
```

The command stages a complete replacement, archives the prior `working/` tree with the approved
manifest and publication receipt, then swaps in the milestone baseline under the memory lock.
Subsequent rebuilds retain that baseline and ingest only records created after compaction.

## Maintenance

```sh
pnpm orchbun memory show
pnpm orchbun memory runs
pnpm orchbun memory verify
pnpm orchbun memory rebuild
```

`memory init` creates both managed and direct-memory structures. `memory show` rebuilds and
prints unified projections, `memory runs` lists managed runs and direct notes, `memory rebuild`
regenerates projections from both sources, and `memory verify` validates both sources.

The target workspace’s `orchbun.yaml` controls input limits, per-file limits, output limits, and delegation depth.

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

## Maintenance

```sh
pnpm orchbun memory show
pnpm orchbun memory runs
pnpm orchbun memory verify
pnpm orchbun memory rebuild
```

The target workspace’s `orchbun.yaml` controls input limits, per-file limits, output limits, and delegation depth.

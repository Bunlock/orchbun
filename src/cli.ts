#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { findWorkspaceRoot, loadConfig, memoryRoot } from "./config.js";
import { assertValidDirectMemory, loadDirectMemory } from "./direct-memory.js";
import { loadRuns, rebuildMemory, verifyMemory } from "./memory.js";
import { createMemoryServer } from "./memory-web.js";
import { compactAllApprovedMilestones, compactMemory } from "./milestone-memory.js";
import { sweepMemory } from "./memory-sweep.js";
import { Orchestrator, type RunOptions } from "./orchestrator.js";
import { renderActiveTasks, sleepMemory } from "./sleep-memory.js";
import type { AgentKind, RunMode } from "./types.js";
import { initializeWorkspace } from "./init.js";

const HELP = `orchbun — local, token-efficient agent orchestration

Usage:
  orchbun init [--root PATH] [--json]
  orchbun run --agent AGENT --prompt TEXT [--task ID] [--mode review|work]
  orchbun delegate --agent AGENT --prompt TEXT [--mode review|work]
  orchbun context --prompt TEXT [--task ID] [--mode review|work]
  orchbun memory compact (--milestone NAME | --all) [--scope shared] [--manifest PATH]
  orchbun memory sleep [--dry-run] [--json]
  orchbun memory sweep [--dry-run] [--json]
  orchbun memory show|runs|rebuild|verify|compact|sleep|sweep|web [--port PORT]

Options:
  --prompt-file PATH       Read the exact source prompt from a file
  --context a.md,b.md      Explicit context files; memory/design is never automatic
  --model MODEL            Provider model override
  --root PATH              Workspace root containing orchbun.yaml
  --json                   Print a machine-readable receipt
  --dry-run                Preview without publishing or invoking an agent

Review mode is the default. Work mode must be explicit.
`;

interface ParsedArgs {
  positional: string[];
  options: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (!name) throw new Error(`Invalid option ${value}`);
    if (options.has(name)) throw new Error(`Option --${name} was provided more than once`);
    if (inline !== undefined) options.set(name, inline);
    else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        options.set(name, next);
        index += 1;
      } else options.set(name, true);
    }
  }
  return { positional, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

async function sourcePrompt(args: ParsedArgs, root: string): Promise<string> {
  const direct = option(args, "prompt");
  const file = option(args, "prompt-file");
  if (direct && file) throw new Error("Use either --prompt or --prompt-file, not both");
  if (direct) return direct;
  if (file) {
    const resolved = path.resolve(root, file);
    const relative = path.relative(path.resolve(root), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("--prompt-file must stay inside the project");
    return readFile(resolved, "utf8");
  }
  throw new Error("--prompt or --prompt-file is required");
}

function agent(args: ParsedArgs, fallback: AgentKind): AgentKind {
  const value = (option(args, "agent") ?? fallback) as AgentKind;
  if (!["codex", "claude", "openrouter"].includes(value)) throw new Error(`Unknown agent ${value}`);
  return value;
}

function mode(args: ParsedArgs, fallback: RunMode): RunMode {
  const value = (option(args, "mode") ?? fallback) as RunMode;
  if (!["review", "work"].includes(value)) throw new Error(`Unknown mode ${value}`);
  return value;
}

function contextFiles(args: ParsedArgs): string[] {
  return option(args, "context")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function port(args: ParsedArgs): number {
  const value = option(args, "port") ?? "4312";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("--port must be a number between 1 and 65535");
  return parsed;
}

async function runCompactCommand(
  args: ParsedArgs,
  root: string,
  orchestrator: Orchestrator,
  usage: string,
): Promise<void> {
  await orchestrator.journal.initialize();
  const milestone = option(args, "milestone");
  const scope = option(args, "scope") ?? "shared";
  const all = args.options.has("all");
  if (all && (milestone || option(args, "manifest"))) {
    throw new Error("Use either --all or a single --milestone/--manifest, not both");
  }
  if (all) {
    const receipt = await compactAllApprovedMilestones(orchestrator.journal, scope);
    console.log(args.options.has("json")
      ? JSON.stringify(receipt)
      : `Compacted ${receipt.compacted.length} milestone(s); skipped ${receipt.skipped} already published.`);
    return;
  }
  if (!milestone) throw new Error(usage);
  const manifest = option(args, "manifest")
    ? path.resolve(root, option(args, "manifest")!)
    : path.join(orchestrator.journal.memoryRoot, "milestones", milestone, "approved.yaml");
  const receipt = await compactMemory(orchestrator.journal, manifest, milestone, scope);
  console.log(args.options.has("json") ? JSON.stringify(receipt) : `${receipt.milestone} compacted → ${receipt.archivePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.positional;
  if (!command || command === "help" || args.options.has("help")) {
    console.log(HELP);
    return;
  }
  validateInvocation(args);
  if (command === "init") {
    const root = path.resolve(option(args, "root") ?? process.cwd());
    const receipt = await initializeWorkspace(root);
    console.log(args.options.has("json") ? JSON.stringify(receipt, null, 2) : `Initialized ${receipt.root}\nLocal memory: ${receipt.memoryRoot}${receipt.created.length ? `\nCreated: ${receipt.created.join(", ")}` : "\nExisting project files preserved."}`);
    return;
  }
  const root = option(args, "root")
    ? await findWorkspaceRoot(path.resolve(option(args, "root")!))
    : await findWorkspaceRoot(process.env.ORCHBUN_ROOT ?? process.cwd());
  const config = await loadConfig(root);
  const orchestrator = new Orchestrator(root, config);

  if (command === "memory") {
    if (subcommand === "sleep") {
      const publish = !args.options.has("dry-run");
      if (publish) await orchestrator.journal.initialize();
      const receipt = await sleepMemory(root, orchestrator.journal, { publish });
      if (args.options.has("json")) {
        console.log(JSON.stringify(receipt, null, 2));
      } else {
        console.log(renderActiveTasks(receipt.snapshot.activeTasks).trimEnd());
        console.log(`\n${receipt.published ? `Sleep snapshot published at ${receipt.snapshotPath}` : "Dry run; no memory files changed."}`);
        console.log(`${receipt.snapshot.activeTasks.length} active · ${receipt.snapshot.scheduledTasks.length} scheduled · ${receipt.snapshot.excludedFollowups.length} excluded follow-up(s)`);
      }
      return;
    }
    if (subcommand === "sweep") {
      const receipt = await sweepMemory(orchestrator.journal, {
        dryRun: args.options.has("dry-run"),
        projectRoot: root,
      });
      console.log(args.options.has("json") ? JSON.stringify(receipt, null, 2) : receipt.report.trimEnd());
      if (!receipt.verification.passed) process.exitCode = 1;
      return;
    }
    await orchestrator.journal.initialize();
    if (subcommand === "compact") {
      await runCompactCommand(args, root, orchestrator, "Usage: orchbun memory compact (--milestone <name> | --all) [--scope shared] [--manifest PATH]");
      return;
    }
    if (subcommand === "rebuild") {
      await rebuildMemory(orchestrator.journal, root);
      console.log("Working memory rebuilt");
      return;
    }
    if (subcommand === "verify") {
      const report = await verifyMemory(orchestrator.journal);
      console.log(JSON.stringify(report, null, 2));
      if (report.issues.length) process.exitCode = 1;
      return;
    }
    if (subcommand === "web") {
      await rebuildMemory(orchestrator.journal, root);
      const viewer = createMemoryServer(orchestrator.journal.memoryRoot, { projectRoot: root });
      const selectedPort = port(args);
      await new Promise<void>((resolve, reject) => {
        viewer.once("error", reject);
        viewer.listen(selectedPort, "127.0.0.1", () => {
          viewer.off("error", reject);
          resolve();
        });
      });
      console.log(`Memory viewer available at http://127.0.0.1:${selectedPort}`);
      return;
    }
    if (subcommand === "runs") {
      const direct = await loadDirectMemory(orchestrator.journal.memoryRoot);
      assertValidDirectMemory(direct);
      const entries = [
        ...(await loadRuns(orchestrator.journal)).map((run) => ({
          startedAt: run.metadata.startedAt,
          line: `${run.metadata.runId}\t${run.metadata.status}\t${run.metadata.agent}\t${run.metadata.taskId ?? "-"}\t${run.metadata.parentRunId ?? "-"}`,
        })),
        ...direct.notes.map((note) => ({
          startedAt: note.timestamp,
          line: `${note.id}\trecorded\tdirect\t${note.slug}\t-`,
        })),
      ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      for (const entry of entries) {
        console.log(entry.line);
      }
      return;
    }
    if (subcommand === "show") {
      await rebuildMemory(orchestrator.journal, root);
      const working = path.join(memoryRoot(root, config), "working");
      for (const file of ["project-state.md", "active-tasks.md", "decisions.md", "contracts.md", "risks.md"]) {
        console.log(await readFile(path.join(working, file), "utf8"));
      }
      return;
    }
    throw new Error("Usage: orchbun memory show|runs|rebuild|verify|compact|sleep|sweep|web");
  }

  const isDelegate = command === "delegate";
  if (!["run", "delegate", "context"].includes(command)) throw new Error(`Unknown command.\n\n${HELP}`);
  const parentRunId = isDelegate ? process.env.ORCHBUN_RUN_ID ?? null : null;
  if (isDelegate && !parentRunId) throw new Error("delegate must be called from a managed Orchbun run");
  if (isDelegate && process.env.ORCHBUN_MODE === "review") {
    throw new Error("A review-mode parent cannot delegate; start the parent with --mode work");
  }
  const depth = isDelegate ? Number(process.env.ORCHBUN_DEPTH ?? "0") + 1 : 0;
  const taskId = option(args, "task") ?? (isDelegate ? process.env.ORCHBUN_TASK_ID || null : null);
  const selectedMode = mode(args, isDelegate ? config.delegation.defaultMode : "review");
  const options: RunOptions = {
    agent: agent(args, config.agents.default),
    mode: selectedMode,
    sourcePrompt: await sourcePrompt(args, root),
    taskId,
    parentRunId,
    depth,
    contextFiles: contextFiles(args),
    ...(option(args, "model") ? { model: option(args, "model")! } : {}),
  };

  if (command === "context" || args.options.has("dry-run")) {
    const packet = await orchestrator.context(options);
    if (args.options.has("json")) console.log(JSON.stringify(packet, null, 2));
    else {
      console.log(packet.expandedPrompt);
      console.error(`\n${packet.inputCharacters} chars · ~${packet.estimatedInputTokens} tokens · ${packet.includedFiles.length} context files`);
    }
    return;
  }

  const completed = await orchestrator.run(options);
  const receipt = {
    run_id: completed.metadata.runId,
    parent_run_id: completed.metadata.parentRunId,
    task_id: completed.metadata.taskId,
    status: completed.metadata.status,
    summary: completed.result.summary,
    deliverables: completed.result.deliverables,
    blockers: completed.result.blockers,
    next_actions: completed.result.next_actions,
  };
  if (isDelegate || args.options.has("json")) console.log(JSON.stringify(receipt));
  else {
    console.log(`${completed.metadata.runId} → ${completed.metadata.status}`);
    console.log(completed.result.summary);
    console.log(completed.runDirectory);
  }
}

const BOOLEAN_OPTIONS = new Set(["help", "json", "dry-run", "all"]);

function validateInvocation(args: ParsedArgs): void {
  const [command, subcommand, ...extra] = args.positional;
  if (extra.length) throw new Error(`Unexpected argument(s): ${extra.join(" ")}`);
  let allowed: string[];
  if (command === "init" && !subcommand) allowed = ["root", "json"];
  else if (["run", "delegate", "context"].includes(command ?? "") && !subcommand) {
    allowed = ["agent", "prompt", "prompt-file", "task", "mode", "context", "model", "root", "json", ...(command === "context" ? [] : ["dry-run"] )];
  } else if (command === "memory" && subcommand) {
    const memoryOptions: Record<string, string[]> = {
      show: ["root"], runs: ["root"], rebuild: ["root"], verify: ["root"],
      compact: ["root", "milestone", "all", "scope", "manifest", "json"],
      sleep: ["root", "dry-run", "json"], sweep: ["root", "dry-run", "json"], web: ["root", "port"],
    };
    allowed = memoryOptions[subcommand] ?? [];
  } else throw new Error(`Unknown command.\n\n${HELP}`);
  for (const [name, value] of args.options) {
    if (!allowed.includes(name)) throw new Error(`--${name} is not supported for ${[command, subcommand].filter(Boolean).join(" ")}`);
    if (BOOLEAN_OPTIONS.has(name) && value !== true) throw new Error(`--${name} does not take a value`);
    if (!BOOLEAN_OPTIONS.has(name) && value === true) throw new Error(`--${name} requires a value`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { findWorkspaceRoot, loadConfig, memoryRoot } from "./config.js";
import { buildContextPacket } from "./context.js";
import { loadRuns, rebuildMemory, verifyMemory } from "./memory.js";
import { Orchestrator, type RunOptions } from "./orchestrator.js";
import type { AgentKind, RunMode } from "./types.js";

const HELP = `orchbun — local, token-efficient agent orchestration

Usage:
  orchbun run --agent AGENT --prompt TEXT [--task ID] [--mode review|work]
  orchbun delegate --agent AGENT --prompt TEXT [--mode review|work]
  orchbun context --prompt TEXT [--task ID] [--mode review|work]
  orchbun memory init|show|runs|rebuild|verify

Options:
  --prompt-file PATH       Read the exact source prompt from a file
  --context a.md,b.md      Explicit context files; memory/design is never automatic
  --model MODEL            Provider model override
  --root PATH              Workspace root containing orchbun.yaml
  --json                   Print a machine-readable receipt
  --dry-run                Show the expanded prompt without invoking an agent

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
  if (file) return readFile(path.resolve(root, file), "utf8");
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.positional;
  if (!command || command === "help" || args.options.has("help")) {
    console.log(HELP);
    return;
  }
  const root = option(args, "root")
    ? await findWorkspaceRoot(path.resolve(option(args, "root")!))
    : await findWorkspaceRoot(process.env.ORCHBUN_ROOT ?? process.cwd());
  const config = await loadConfig(root);
  const orchestrator = new Orchestrator(root, config);

  if (command === "memory") {
    await orchestrator.journal.initialize();
    if (subcommand === "init") {
      await rebuildMemory(orchestrator.journal);
      console.log(orchestrator.journal.memoryRoot);
      return;
    }
    if (subcommand === "rebuild") {
      await rebuildMemory(orchestrator.journal);
      console.log("Working memory rebuilt");
      return;
    }
    if (subcommand === "verify") {
      const report = await verifyMemory(orchestrator.journal);
      console.log(JSON.stringify(report, null, 2));
      if (report.issues.length) process.exitCode = 1;
      return;
    }
    if (subcommand === "runs") {
      for (const run of (await loadRuns(orchestrator.journal)).reverse()) {
        console.log(`${run.metadata.runId}\t${run.metadata.status}\t${run.metadata.agent}\t${run.metadata.taskId ?? "-"}\t${run.metadata.parentRunId ?? "-"}`);
      }
      return;
    }
    if (subcommand === "show") {
      const working = path.join(memoryRoot(root, config), "working");
      for (const file of ["project-state.md", "active-tasks.md", "decisions.md", "risks.md"]) {
        console.log(await readFile(path.join(working, file), "utf8"));
      }
      return;
    }
    throw new Error("Usage: orchbun memory init|show|runs|rebuild|verify");
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
    const packet = await buildContextPacket(root, config, {
      sourcePrompt: options.sourcePrompt,
      taskId: options.taskId,
      mode: options.mode,
      contextFiles: options.contextFiles,
      allowDelegation: options.mode === "work" && options.depth < config.delegation.maxDepth,
    });
    console.log(packet.expandedPrompt);
    console.error(`\n${packet.inputCharacters} chars · ~${packet.estimatedInputTokens} tokens · ${packet.includedFiles.length} context files`);
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AdapterOptions, AdapterResponse } from "./base.js";
import { AdapterExecutionError } from "./base.js";
import type { AgentUsage, ContextPacket } from "../types.js";
import { runProcess } from "./process.js";
import { bundledSchemaPath, validateAgentResult } from "../schema.js";
import { newRunId } from "../utils.js";

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    await mkdir(options.temporaryDir, { recursive: true });
    const outputPath = path.join(options.temporaryDir, `${newRunId("codex-result")}.json`);
    const args = [
      "exec",
      packet.expandedPrompt,
      "--skip-git-repo-check",
      "--json",
      "--sandbox",
      options.mode === "review" ? "read-only" : "workspace-write",
      "--output-schema",
      bundledSchemaPath(),
      "-o",
      outputPath,
    ];
    if (options.model) args.push("--model", options.model);
    const processResult = await runProcess("codex", args, options.root, options.environment);
    if (processResult.exitCode !== 0) {
      throw new AdapterExecutionError(
        `Codex exited with ${processResult.exitCode}: ${processResult.stderr.trim()}`,
        processResult.stdout,
        "events.jsonl",
      );
    }
    try {
      const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
      return {
        result: await validateAgentResult(parsed),
        nativeOutput: processResult.stdout,
        nativeFileName: "events.jsonl",
        ...(processResult.stderr.trim() ? { diagnostics: processResult.stderr } : {}),
        ...(extractCodexUsage(processResult.stdout) ? { usage: extractCodexUsage(processResult.stdout)! } : {}),
        ...(options.model ? { model: options.model } : {}),
      };
    } finally {
      await rm(outputPath, { force: true });
    }
  }
}

function extractCodexUsage(jsonl: string): AgentUsage | undefined {
  let usage: Record<string, number> | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; usage?: Record<string, number> };
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // Preserve unknown native lines without failing the run.
    }
  }
  if (!usage) return undefined;
  return {
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
  };
}

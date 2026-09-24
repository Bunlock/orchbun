import type { AgentAdapter, AdapterOptions, AdapterResponse } from "./base.js";
import { AdapterExecutionError } from "./base.js";
import type { AgentUsage, ContextPacket } from "../types.js";
import { runProcess } from "./process.js";
import { loadResultSchema, validateAgentResult } from "../schema.js";

interface ClaudeEnvelope {
  is_error?: boolean;
  session_id?: string;
  structured_output?: unknown;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    const args = [
      "-p",
      packet.expandedPrompt,
      "--output-format",
      "json",
      "--permission-mode",
      options.mode === "review" ? "plan" : "acceptEdits",
      "--json-schema",
      JSON.stringify(await loadResultSchema()),
    ];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
    const processResult = await runProcess("claude", args, options.root, options.environment);
    if (processResult.exitCode !== 0) {
      throw new AdapterExecutionError(
        `Claude exited with ${processResult.exitCode}: ${processResult.stderr.trim()}`,
        processResult.stdout,
        "response.native.json",
      );
    }
    const envelope = JSON.parse(processResult.stdout) as ClaudeEnvelope;
    if (envelope.is_error) {
      throw new AdapterExecutionError(`Claude reported an error: ${envelope.result ?? "no detail"}`, processResult.stdout, "response.native.json");
    }
    const candidate = envelope.structured_output ?? (envelope.result ? JSON.parse(envelope.result) : undefined);
    const usage: AgentUsage = {
      ...(envelope.usage?.input_tokens !== undefined ? { inputTokens: envelope.usage.input_tokens } : {}),
      ...(envelope.usage?.output_tokens !== undefined ? { outputTokens: envelope.usage.output_tokens } : {}),
      ...(envelope.usage?.cache_read_input_tokens !== undefined ? { cachedInputTokens: envelope.usage.cache_read_input_tokens } : {}),
      ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
    };
    return {
      result: await validateAgentResult(candidate),
      nativeOutput: processResult.stdout,
      nativeFileName: "response.native.json",
      ...(processResult.stderr.trim() ? { diagnostics: processResult.stderr } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(envelope.session_id ? { sessionId: envelope.session_id } : {}),
    };
  }
}

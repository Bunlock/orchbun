import type { AgentAdapter, AdapterOptions, AdapterResponse } from "./base.js";
import type { ContextPacket } from "../types.js";
import { loadResultSchema, validateAgentResult } from "../schema.js";

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

export class OpenRouterAdapter implements AgentAdapter {
  readonly kind = "openrouter" as const;

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    if (options.mode === "work") throw new Error("OpenRouter has no local file tools; use review mode");
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the OpenRouter adapter");
    if (!options.model) throw new Error("An OpenRouter model is required");
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: packet.expandedPrompt }],
        max_tokens: options.maxOutputTokens,
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: "orchbun_agent_result", strict: true, schema: await loadResultSchema() },
        },
      }),
    });
    const nativeOutput = await response.text();
    const envelope = JSON.parse(nativeOutput) as OpenRouterResponse;
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}: ${envelope.error?.message ?? nativeOutput}`);
    const content = envelope.choices?.[0]?.message?.content;
    if (content === undefined) throw new Error("OpenRouter response did not contain message content");
    const candidate = typeof content === "string" ? JSON.parse(content) : content;
    return {
      result: await validateAgentResult(candidate),
      nativeOutput,
      nativeFileName: "response.native.json",
      model: options.model,
      ...(envelope.usage ? { usage: {
        ...(envelope.usage.prompt_tokens !== undefined ? { inputTokens: envelope.usage.prompt_tokens } : {}),
        ...(envelope.usage.completion_tokens !== undefined ? { outputTokens: envelope.usage.completion_tokens } : {}),
        ...(envelope.usage.cost !== undefined ? { costUsd: envelope.usage.cost } : {}),
      } } : {}),
    };
  }
}

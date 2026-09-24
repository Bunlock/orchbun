#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { findWorkspaceRoot, loadConfig, memoryRoot } from "./config.js";
import { ImageGenerationJournal } from "./image-generation/journal.js";
import { LeonardoProvider } from "./image-generation/leonardo.js";
import { ImageGenerationService } from "./image-generation/service.js";
import { Orchestrator } from "./orchestrator.js";
import { RunControl } from "./run-control.js";

const referenceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["uploaded", "generated"]),
  purpose: z.enum(["content", "style"]),
  strength: z.enum(["low", "mid", "high", "ultra", "max"]).optional(),
  sourceUrl: z.url().optional(),
}).strict();

const parametersSchema = z.object({
  model: z.string().min(1).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  count: z.number().int().optional(),
  mode: z.enum(["FAST", "ULTRA"]).optional(),
  promptEnhance: z.enum(["AUTO", "ON", "OFF"]).optional(),
  seed: z.number().int().optional(),
  styleIds: z.array(z.uuid()).max(1).optional(),
  public: z.boolean().optional(),
}).strict();

export const generateImageInputSchema = z.object({
  provider: z.literal("leonardo"),
  project: z.string().trim().min(1).max(120),
  assetType: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(2_000),
  parameters: parametersSchema.optional().default({}),
  references: z.array(referenceSchema).max(2).optional().default([]),
  parentGenerationId: z.uuid().nullable().optional().default(null),
  waitForCompletion: z.boolean().optional().default(true),
  polling: z.object({
    intervalMs: z.number().int().min(250).max(30_000).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  }).strict().optional(),
}).strict();

type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

export function createImageToolHandler(
  service: ImageGenerationService,
  defaults: { pollIntervalMs: number; timeoutMs: number },
): (input: GenerateImageInput) => Promise<Record<string, unknown>> {
  return async (input) => {
    const record = await service.generate({
      provider: input.provider,
      project: input.project,
      assetType: input.assetType,
      prompt: input.prompt,
      parameters: input.parameters,
      references: input.references,
      parentGenerationId: input.parentGenerationId,
      waitForCompletion: input.waitForCompletion,
      polling: {
        intervalMs: input.polling?.intervalMs ?? defaults.pollIntervalMs,
        timeoutMs: input.polling?.timeoutMs ?? defaults.timeoutMs,
      },
    });
    return record as unknown as Record<string, unknown>;
  };
}

export interface McpServices {
  images?: { service: ImageGenerationService; defaults: { pollIntervalMs: number; timeoutMs: number } };
  runs?: RunControl;
}

export function createMcpServer(services: McpServices): McpServer {
  const server = new McpServer(
    { name: "orchbun", version: "0.3.0" },
    { instructions: [
      ...(services.runs ? [RUN_INSTRUCTIONS] : []),
      ...(services.images ? ["Use generate_image for traceable image generation. Only the official Leonardo integration is supported."] : []),
    ].join("\n\n") },
  );
  if (services.images) registerImageTools(server, services.images.service, services.images.defaults);
  if (services.runs) registerRunTools(server, services.runs);
  return server;
}

function registerImageTools(
  server: McpServer,
  service: ImageGenerationService,
  defaults: { pollIntervalMs: number; timeoutMs: number },
): void {
  const generateImage = createImageToolHandler(service, defaults);
  server.registerTool("generate_image", {
    title: "Generate image",
    description: "Generate images through a supported provider and record prompt, parameters, references, status, results, and lineage in local Orchbun memory.",
    inputSchema: generateImageInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input) => {
    try {
      const record = await generateImage(input);
      return {
        content: [{ type: "text", text: JSON.stringify(record) }],
        structuredContent: record,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  server.registerTool("get_image_generation", {
    title: "Get image generation",
    description: "Refresh a recorded in-progress image generation from its provider, or return its terminal result.",
    inputSchema: z.object({ generationId: z.uuid() }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ generationId }) => {
    try {
      const record = await service.refresh(generationId);
      const output = record as unknown as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
}

const RUN_INSTRUCTIONS = "Orchestrate Codex and Claude Code agents as background runs. agent_start returns a run id at once; "
  + "use agent_wait to block until a run finishes (it returns early when timeout_seconds elapses — call it again), "
  + "agent_status to inspect runs, agent_send to continue a finished run's session in the same workspace, and agent_cancel to stop one. "
  + "Work runs edit an isolated git worktree reported as `workspace`; review and merge it yourself. "
  + "Agents report outcomes in their result and never write Orchbun memory: you record durable outcomes and run end-to-end verification.";

const runIdSchema = z.string().regex(/^\d{8}T\d{6}Z-[a-z]+-[0-9a-f]{6}$/, "Expected an Orchbun run id");

function registerRunTools(server: McpServer, runs: RunControl): void {
  const respond = async (action: () => Promise<unknown>) => {
    try {
      const value = await action();
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { value } };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  server.registerTool("agent_start", {
    title: "Start agent run",
    description: "Start a Codex, Claude, or OpenRouter agent in the background with Orchbun context. Review mode is read-only; work mode edits an isolated worktree. Returns the run immediately.",
    inputSchema: z.object({
      agent: z.enum(["codex", "claude", "openrouter"]),
      prompt: z.string().trim().min(1),
      mode: z.enum(["review", "work"]).optional().default("review"),
      task_id: z.string().trim().min(1).max(80).optional(),
      model: z.string().trim().min(1).optional(),
      context_files: z.array(z.string().min(1)).max(20).optional().default([]),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => respond(() => runs.start({
    agent: input.agent,
    mode: input.mode,
    sourcePrompt: input.prompt,
    taskId: input.task_id ?? null,
    parentRunId: null,
    depth: 0,
    contextFiles: input.context_files,
    ...(input.model ? { model: input.model } : {}),
  })));
  server.registerTool("agent_send", {
    title: "Send follow-up",
    description: "Continue a finished run's agent session with a follow-up prompt, in the same workspace and mode. Returns the new run immediately.",
    inputSchema: z.object({ run_id: runIdSchema, prompt: z.string().trim().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ run_id, prompt }) => respond(() => runs.send(run_id, prompt)));
  server.registerTool("agent_status", {
    title: "Agent run status",
    description: "Return one run with its full result, or the 20 most recent runs when run_id is omitted.",
    inputSchema: z.object({ run_id: runIdSchema.optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ run_id }) => respond(() => run_id ? runs.status(run_id) : runs.list()));
  server.registerTool("agent_wait", {
    title: "Wait for agent runs",
    description: "Block until any run (or all runs, with all: true) finishes, or until timeout_seconds elapses. Finished runs include their full result.",
    inputSchema: z.object({
      run_ids: z.array(runIdSchema).min(1).max(20),
      all: z.boolean().optional().default(false),
      timeout_seconds: z.number().int().min(1).max(3_600).optional().default(50),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ run_ids, all, timeout_seconds }) =>
    respond(() => runs.wait(run_ids, { all, timeoutMs: timeout_seconds * 1_000 })));
  server.registerTool("agent_cancel", {
    title: "Cancel agent run",
    description: "Stop a background run and its agent process. Its workspace is kept for inspection.",
    inputSchema: z.object({ run_id: runIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ run_id }) => respond(() => runs.cancel(run_id)));
}

async function main(): Promise<void> {
  const root = await findWorkspaceRoot(path.resolve(process.env.ORCHBUN_ROOT ?? process.cwd()));
  const config = await loadConfig(root);
  const runs = new RunControl(root, config, new Orchestrator(root, config));
  // Image tools are offered only when their provider credential is configured.
  const apiKey = process.env.LEONARDO_API_KEY;
  let images: McpServices["images"];
  if (apiKey) {
    const journal = new ImageGenerationJournal(memoryRoot(root, config));
    await journal.initialize();
    images = { service: new ImageGenerationService([new LeonardoProvider({ apiKey })], journal), defaults: config.images };
  }
  serveStdio(() => createMcpServer({ runs, ...(images ? { images } : {}) }), {
    onerror: (error) => console.error(error.message),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

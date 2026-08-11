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

export function createImageMcpServer(
  service: ImageGenerationService,
  defaults: { pollIntervalMs: number; timeoutMs: number },
): McpServer {
  const server = new McpServer(
    { name: "orchbun-images", version: "0.2.0" },
    { instructions: "Use generate_image for traceable image generation. Only the official Leonardo integration is supported." },
  );
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
  return server;
}

async function main(): Promise<void> {
  const root = await findWorkspaceRoot(path.resolve(process.env.ORCHBUN_ROOT ?? process.cwd()));
  const config = await loadConfig(root);
  const apiKey = process.env.LEONARDO_API_KEY;
  if (!apiKey) throw new Error("LEONARDO_API_KEY is required to start the Leonardo image provider");
  const journal = new ImageGenerationJournal(memoryRoot(root, config));
  await journal.initialize();
  const service = new ImageGenerationService([new LeonardoProvider({ apiKey })], journal);
  serveStdio(() => createImageMcpServer(service, config.images), {
    onerror: (error) => console.error(error.message),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

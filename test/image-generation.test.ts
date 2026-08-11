import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageGenerationJournal } from "../src/image-generation/journal.js";
import { LeonardoProvider } from "../src/image-generation/leonardo.js";
import { ImageGenerationService } from "../src/image-generation/service.js";
import type { GenerationRequest, GenerationResult, ImageProvider } from "../src/image-generation/types.js";
import { verifyMemory } from "../src/memory.js";
import { RunJournal } from "../src/journal.js";
import { createImageToolHandler, generateImageInputSchema } from "../src/mcp.js";

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    generationId: "11111111-1111-4111-8111-111111111111",
    provider: "leonardo",
    project: "hexarch",
    assetType: "stellar-base",
    prompt: "A readable orbital command base icon",
    parameters: { width: 1024, height: 1024, count: 1, seed: 42 },
    references: [{ id: "ref-1", type: "uploaded", purpose: "style", strength: "high" }],
    parentGenerationId: null,
    requestedAt: "2026-08-10T12:00:00.000Z",
    waitForCompletion: true,
    polling: { intervalMs: 250, timeoutMs: 2_000 },
    ...overrides,
  };
}

test("LeonardoProvider submits v2 Lucid Origin and polls the v1 generation status", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response(JSON.stringify({ generationId: "external-123" }), { status: 200 }),
    new Response(JSON.stringify({ generations_by_pk: { status: "PENDING", generated_images: [] } }), { status: 200 }),
    new Response(JSON.stringify({ generations_by_pk: {
      status: "COMPLETE",
      generated_images: [{ id: "image-1", url: "https://cdn.leonardo.ai/image.png", nsfw: false }],
    } }), { status: 200 }),
  ];
  let time = 0;
  const provider = new LeonardoProvider({
    apiKey: "secret-test-key",
    fetch: async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return responses.shift()!;
    },
    now: () => new Date(`2026-08-10T12:00:0${time}.000Z`),
    sleep: async () => { time += 1; },
  });

  const result = await provider.generate(request());

  assert.equal(result.status, "completed");
  assert.equal(result.externalGenerationId, "external-123");
  assert.equal(result.images[0]?.url, "https://cdn.leonardo.ai/image.png");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://cloud.leonardo.ai/api/rest/v2/generations",
    "https://cloud.leonardo.ai/api/rest/v1/generations/external-123",
    "https://cloud.leonardo.ai/api/rest/v1/generations/external-123",
  ]);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret-test-key");
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "lucid-origin");
  assert.deepEqual(body, {
    model: "lucid-origin",
    public: false,
    parameters: {
      prompt: "A readable orbital command base icon",
      width: 1024,
      height: 1024,
      quantity: 1,
      mode: "FAST",
      prompt_enhance: "AUTO",
      seed: 42,
      guidances: { style: [{ image: { id: "ref-1", type: "UPLOADED" }, strength: "HIGH" }] },
    },
  });
});

test("LeonardoProvider preserves an external ID when polling times out", async () => {
  const responses = [
    new Response(JSON.stringify({ generate: { generationId: "external-queued" } }), { status: 200 }),
    new Response(JSON.stringify({ generations_by_pk: { status: "PENDING", generated_images: [] } }), { status: 200 }),
  ];
  let time = 0;
  const provider = new LeonardoProvider({
    apiKey: "secret-test-key",
    fetch: async () => responses.shift()!,
    now: () => new Date(time),
    sleep: async () => { time = 2_000; },
  });

  const result = await provider.generate(request({ requestedAt: new Date(0).toISOString(), polling: { intervalMs: 250, timeoutMs: 1_000 } }));

  assert.equal(result.status, "processing");
  assert.equal(result.externalGenerationId, "external-queued");
  assert.equal(result.externalStatus, "POLL_TIMEOUT");
  assert.equal(result.error?.retryable, true);
});

test("LeonardoProvider rejects invalid dimensions before making a request", async () => {
  let called = false;
  const provider = new LeonardoProvider({
    apiKey: "secret-test-key",
    fetch: async () => { called = true; return new Response("{}"); },
  });

  await assert.rejects(() => provider.generate(request({ parameters: { width: 1023 } })), /multiples of 8/);
  assert.equal(called, false);
});

test("ImageGenerationService records requests, results, references, and lineage", async () => {
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "orchbun-images-"));
  const journal = new ImageGenerationJournal(memoryRoot);
  await journal.initialize();
  const parentId = "22222222-2222-4222-8222-222222222222";
  await journal.begin(request({ generationId: parentId }));
  const provider: ImageProvider = {
    name: "leonardo",
    async generate(value): Promise<GenerationResult> {
      return {
        generationId: value.generationId,
        provider: value.provider,
        status: "completed",
        externalGenerationId: "external-456",
        externalStatus: "COMPLETE",
        images: [{ id: "image-2", url: "https://cdn.leonardo.ai/result.png" }],
        startedAt: value.requestedAt,
        updatedAt: "2026-08-10T12:00:01.000Z",
        completedAt: "2026-08-10T12:00:01.000Z",
        error: null,
      };
    },
    async getStatus(): Promise<GenerationResult> { throw new Error("not used"); },
  };
  const service = new ImageGenerationService(
    [provider],
    journal,
    () => new Date("2026-08-10T12:00:00.000Z"),
    () => "33333333-3333-4333-8333-333333333333",
  );

  const record = await service.generate({
    provider: "leonardo",
    project: "hexarch",
    assetType: "fleet-icon",
    prompt: "A geometric drone fleet icon",
    parameters: { count: 1 },
    references: [{ id: "reference-image", type: "uploaded", purpose: "style", sourceUrl: "https://example.com/ref.png" }],
    parentGenerationId: parentId,
    waitForCompletion: false,
    polling: { intervalMs: 2_000, timeoutMs: 120_000 },
  });

  assert.equal(record.request.parentGenerationId, parentId);
  assert.equal(record.request.references[0]?.sourceUrl, "https://example.com/ref.png");
  assert.equal(record.result.externalGenerationId, "external-456");
  const stored = JSON.parse(await readFile(path.join(
    memoryRoot, "generations", "2026", "08", record.request.generationId, "record.json",
  ), "utf8")) as typeof record;
  assert.deepEqual(stored, record);
});

test("memory verification validates image lineage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-image-memory-"));
  const runJournal = new RunJournal(root);
  await runJournal.initialize();
  const imageJournal = new ImageGenerationJournal(root);
  await imageJournal.initialize();
  const child = request({ parentGenerationId: "44444444-4444-4444-8444-444444444444" });
  await imageJournal.begin(child);

  const report = await verifyMemory(runJournal);

  assert.equal(report.imageGenerations, 1);
  assert.ok(report.issues.some((issue) => issue.includes("missing parent")));
});

test("ImageGenerationService refreshes a queued external generation", async () => {
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "orchbun-image-refresh-"));
  const journal = new ImageGenerationJournal(memoryRoot);
  await journal.initialize();
  let statusCalls = 0;
  const provider: ImageProvider = {
    name: "leonardo",
    async generate(value): Promise<GenerationResult> {
      return {
        generationId: value.generationId,
        provider: value.provider,
        status: "processing",
        externalGenerationId: "external-refresh",
        externalStatus: "PENDING",
        images: [],
        startedAt: value.requestedAt,
        updatedAt: value.requestedAt,
        completedAt: null,
        error: null,
      };
    },
    async getStatus(value, externalGenerationId): Promise<GenerationResult> {
      statusCalls += 1;
      assert.equal(externalGenerationId, "external-refresh");
      return {
        generationId: value.generationId,
        provider: value.provider,
        status: "completed",
        externalGenerationId,
        externalStatus: "COMPLETE",
        images: [{ id: "refreshed-image", url: "https://cdn.leonardo.ai/refreshed.png" }],
        startedAt: value.requestedAt,
        updatedAt: "2026-08-10T12:01:00.000Z",
        completedAt: "2026-08-10T12:01:00.000Z",
        error: null,
      };
    },
  };
  const generationId = "55555555-5555-4555-8555-555555555555";
  const service = new ImageGenerationService(
    [provider], journal, () => new Date("2026-08-10T12:00:00.000Z"), () => generationId,
  );
  const created = await service.generate({
    provider: "leonardo",
    project: "hexarch",
    assetType: "system-icon",
    prompt: "A luminous starbase",
    parameters: {},
    references: [],
    parentGenerationId: null,
    waitForCompletion: false,
    polling: { intervalMs: 2_000, timeoutMs: 120_000 },
  });

  const refreshed = await service.refresh(created.request.generationId);

  assert.equal(statusCalls, 1);
  assert.equal(refreshed.result.status, "completed");
  assert.equal(refreshed.result.images[0]?.id, "refreshed-image");
  assert.equal((await journal.find(generationId))?.record.result.completedAt, "2026-08-10T12:01:00.000Z");
});

test("generate_image schema and handler expose a provider-neutral contract", async () => {
  const parsed = generateImageInputSchema.parse({
    provider: "leonardo",
    project: "hexarch",
    assetType: "system-icon",
    prompt: "A luminous starbase",
  });
  assert.deepEqual(parsed.parameters, {});
  assert.deepEqual(parsed.references, []);
  assert.equal(parsed.waitForCompletion, true);
  const calls: unknown[] = [];
  const service = {
    async generate(input: unknown) {
      calls.push(input);
      return { schemaVersion: 1, request: input, result: { status: "pending" } };
    },
  } as unknown as ImageGenerationService;
  const handler = createImageToolHandler(service, { pollIntervalMs: 2_000, timeoutMs: 120_000 });

  const output = await handler(parsed);

  assert.equal((output.result as { status: string }).status, "pending");
  assert.deepEqual(calls, [{
    provider: "leonardo",
    project: "hexarch",
    assetType: "system-icon",
    prompt: "A luminous starbase",
    parameters: {},
    references: [],
    parentGenerationId: null,
    waitForCompletion: true,
    polling: { intervalMs: 2_000, timeoutMs: 120_000 },
  }]);
  assert.throws(() => generateImageInputSchema.parse({ provider: "midjourney", project: "hexarch", assetType: "icon", prompt: "x" }));
});

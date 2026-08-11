import { randomUUID } from "node:crypto";
import { ImageGenerationJournal } from "./journal.js";
import type {
  GenerationRecord,
  GenerationRequest,
  GenerationResult,
  ImageProvider,
  NewGenerationRequest,
} from "./types.js";

export class ImageGenerationService {
  private readonly providers: Map<string, ImageProvider>;

  constructor(
    providers: ImageProvider[],
    readonly journal: ImageGenerationJournal,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
    if (this.providers.size !== providers.length) throw new Error("Image provider names must be unique");
  }

  async generate(input: NewGenerationRequest): Promise<GenerationRecord> {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new Error(`Unsupported image provider ${input.provider}`);
    if (input.parentGenerationId && !(await this.journal.find(input.parentGenerationId))) {
      throw new Error(`Parent image generation ${input.parentGenerationId} does not exist`);
    }
    const requestedAt = this.now().toISOString();
    const request: GenerationRequest = {
      ...input,
      generationId: this.createId(),
      requestedAt,
    };
    await this.journal.begin(request);
    try {
      const result = await provider.generate(request);
      return await this.journal.complete(request, result);
    } catch (error) {
      const failed = failureResult(request, error, this.now().toISOString());
      await this.journal.complete(request, failed);
      throw new ImageGenerationError(request.generationId, failed.error!.message, error);
    }
  }

  async refresh(generationId: string): Promise<GenerationRecord> {
    const current = await this.journal.find(generationId);
    if (!current) throw new Error(`Image generation ${generationId} does not exist`);
    if (["completed", "failed"].includes(current.record.result.status)) return current.record;
    const provider = this.providers.get(current.record.request.provider);
    if (!provider) throw new Error(`Unsupported image provider ${current.record.request.provider}`);
    const externalId = current.record.result.externalGenerationId;
    if (!externalId) throw new Error(`Image generation ${generationId} has no external generation ID`);
    try {
      const result = await provider.getStatus(current.record.request, externalId);
      return await this.journal.complete(current.record.request, result);
    } catch (error) {
      const updatedAt = this.now().toISOString();
      const result: GenerationResult = {
        ...current.record.result,
        updatedAt,
        error: {
          code: "PROVIDER_STATUS_ERROR",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
      await this.journal.complete(current.record.request, result);
      throw new ImageGenerationError(generationId, result.error!.message, error);
    }
  }
}

export class ImageGenerationError extends Error {
  constructor(readonly generationId: string, message: string, options?: unknown) {
    super(`Generation ${generationId} failed: ${message}`, { cause: options });
    this.name = "ImageGenerationError";
  }
}

function failureResult(request: GenerationRequest, error: unknown, updatedAt: string): GenerationResult {
  const details = error as { code?: unknown; retryable?: unknown };
  return {
    generationId: request.generationId,
    provider: request.provider,
    status: "failed",
    externalGenerationId: null,
    externalStatus: null,
    images: [],
    startedAt: request.requestedAt,
    updatedAt,
    completedAt: updatedAt,
    error: {
      code: typeof details.code === "string" ? details.code : "PROVIDER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: details.retryable === true,
    },
  };
}

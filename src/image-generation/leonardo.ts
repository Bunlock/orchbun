import type {
  GeneratedImage,
  GenerationReference,
  GenerationRequest,
  GenerationResult,
  GenerationStatus,
  ImageProvider,
} from "./types.js";

type Fetch = typeof fetch;

export interface LeonardoProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class LeonardoApiError extends Error {
  readonly code = "LEONARDO_API_ERROR";

  constructor(message: string, readonly statusCode?: number, readonly retryable = false) {
    super(message);
    this.name = "LeonardoApiError";
  }
}

export class LeonardoProvider implements ImageProvider {
  readonly name = "leonardo";
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: LeonardoProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("LEONARDO_API_KEY is required");
    this.baseUrl = (options.baseUrl ?? "https://cloud.leonardo.ai/api/rest").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    validateRequest(request);
    const response = await this.request("/v2/generations", {
      method: "POST",
      body: JSON.stringify(toLeonardoRequest(request)),
    });
    const externalGenerationId = requiredGenerationId(response);
    if (!request.waitForCompletion) {
      return this.result(request, "pending", externalGenerationId, "PENDING", [], null);
    }
    const deadline = this.now().getTime() + request.polling.timeoutMs;
    while (this.now().getTime() < deadline) {
      await this.sleep(request.polling.intervalMs);
      try {
        const result = await this.getStatus(request, externalGenerationId);
        if (result.status === "completed" || result.status === "failed") return result;
      } catch (error) {
        return this.result(request, "processing", externalGenerationId, "POLLING_ERROR", [], {
          code: "LEONARDO_POLLING_ERROR",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    }
    return this.result(request, "processing", externalGenerationId, "POLL_TIMEOUT", [], {
      code: "LEONARDO_POLL_TIMEOUT",
      message: `Generation did not finish within ${request.polling.timeoutMs}ms`,
      retryable: true,
    });
  }

  async getStatus(request: GenerationRequest, externalGenerationId: string): Promise<GenerationResult> {
    const payload = await this.request(`/v1/generations/${encodeURIComponent(externalGenerationId)}`);
    const generation = recordAt(payload, "generations_by_pk") ?? recordAt(payload, "generation") ?? payload;
    const externalStatus = optionalString(generation.status) ?? "PENDING";
    const images = parseImages(generation);
    const status = normalizeStatus(externalStatus, images);
    const error = status === "failed" ? {
      code: "LEONARDO_GENERATION_FAILED",
      message: optionalString(generation.failedReason) ?? optionalString(generation.failureReason) ?? "Leonardo generation failed",
      retryable: false,
    } : null;
    return this.result(request, status, externalGenerationId, externalStatus, images, error);
  }

  private result(
    request: GenerationRequest,
    status: GenerationStatus,
    externalGenerationId: string,
    externalStatus: string,
    images: GeneratedImage[],
    error: GenerationResult["error"],
  ): GenerationResult {
    const updatedAt = this.now().toISOString();
    return {
      generationId: request.generationId,
      provider: this.name,
      status,
      externalGenerationId,
      externalStatus,
      images,
      startedAt: request.requestedAt,
      updatedAt,
      completedAt: status === "completed" || status === "failed" ? updatedAt : null,
      error,
    };
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new LeonardoApiError(`Leonardo request failed: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
    }
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LeonardoApiError(`Leonardo returned non-JSON data (HTTP ${response.status})`, response.status, response.status >= 500);
      }
    }
    if (!response.ok) {
      const message = errorMessage(payload) ?? `HTTP ${response.status}`;
      throw new LeonardoApiError(`Leonardo request failed: ${message}`, response.status, response.status === 429 || response.status >= 500);
    }
    if (!isRecord(payload)) throw new LeonardoApiError("Leonardo returned an invalid response");
    return payload;
  }
}

function toLeonardoRequest(request: GenerationRequest): Record<string, unknown> {
  const parameters = request.parameters;
  const content = guidance(request.references, "content");
  const style = guidance(request.references, "style");
  return {
    model: parameters.model ?? "lucid-origin",
    public: parameters.public ?? false,
    parameters: {
      prompt: request.prompt,
      width: parameters.width ?? 1200,
      height: parameters.height ?? 1200,
      quantity: parameters.count ?? 4,
      mode: parameters.mode ?? "FAST",
      prompt_enhance: parameters.promptEnhance ?? "AUTO",
      ...(parameters.seed !== undefined ? { seed: parameters.seed } : {}),
      ...(parameters.styleIds ? { style_ids: parameters.styleIds } : {}),
      ...(content.length || style.length ? { guidances: { ...(content.length ? { content } : {}), ...(style.length ? { style } : {}) } } : {}),
    },
  };
}

function guidance(references: GenerationReference[], purpose: GenerationReference["purpose"]): Record<string, unknown>[] {
  return references.filter((reference) => reference.purpose === purpose).map((reference) => ({
    image: { id: reference.id, type: reference.type.toUpperCase() },
    strength: (reference.strength ?? "mid").toUpperCase(),
  }));
}

function validateRequest(request: GenerationRequest): void {
  if (request.provider !== "leonardo") throw new Error(`LeonardoProvider cannot handle ${request.provider}`);
  if (!request.prompt.trim() || request.prompt.length > 2_000) throw new Error("Leonardo prompt must contain 1 to 2000 characters");
  const { width = 1200, height = 1200, count = 4, seed, styleIds } = request.parameters;
  integerRange(width, "width", 16, 3840);
  integerRange(height, "height", 16, 3616);
  if (width % 8 || height % 8) throw new Error("Leonardo dimensions must be multiples of 8");
  integerRange(count, "count", 1, 8);
  if (seed !== undefined) integerRange(seed, "seed", 0, 2_147_483_647);
  if (styleIds && styleIds.length > 1) throw new Error("Lucid Origin accepts at most one style ID");
  for (const purpose of ["content", "style"] as const) {
    if (request.references.filter((reference) => reference.purpose === purpose).length > 1) {
      throw new Error(`Lucid Origin accepts at most one ${purpose} reference`);
    }
  }
  for (const reference of request.references) {
    if (reference.purpose === "content" && ["ultra", "max"].includes(reference.strength ?? "")) {
      throw new Error("Content reference strength must be low, mid, or high");
    }
  }
  integerRange(request.polling.intervalMs, "polling interval", 250, 30_000);
  integerRange(request.polling.timeoutMs, "polling timeout", 1_000, 300_000);
}

function integerRange(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Leonardo ${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function requiredGenerationId(payload: Record<string, unknown>): string {
  const candidates = [
    payload.generationId,
    recordAt(payload, "generate")?.generationId,
    recordAt(payload, "generation")?.generationId,
    recordAt(payload, "data")?.generationId,
  ];
  const found = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  if (typeof found !== "string") throw new LeonardoApiError("Leonardo response did not include a generationId");
  return found;
}

function parseImages(generation: Record<string, unknown>): GeneratedImage[] {
  const value = generation.generated_images ?? generation.images;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== "string") return [];
    return [{
      id: optionalString(item.id) ?? item.url,
      url: item.url,
      ...(typeof item.nsfw === "boolean" ? { nsfw: item.nsfw } : {}),
      ...(typeof item.width === "number" ? { width: item.width } : {}),
      ...(typeof item.height === "number" ? { height: item.height } : {}),
    }];
  });
}

function normalizeStatus(externalStatus: string, images: GeneratedImage[]): GenerationStatus {
  const normalized = externalStatus.toUpperCase();
  if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(normalized)) return "failed";
  if (["COMPLETE", "COMPLETED", "SUCCEEDED"].includes(normalized) || images.length) return "completed";
  if (["PENDING", "QUEUED"].includes(normalized)) return "pending";
  return "processing";
}

function errorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (isRecord(error)) return optionalString(error.message);
  return optionalString(payload.message);
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.length) return value;
  if (typeof value === "number") return String(value);
  return null;
}

export type GenerationStatus = "pending" | "processing" | "completed" | "failed";

export interface GenerationReference {
  id: string;
  type: "uploaded" | "generated";
  purpose: "content" | "style";
  strength?: "low" | "mid" | "high" | "ultra" | "max" | undefined;
  sourceUrl?: string | undefined;
}

export interface GenerationParameters {
  [key: string]: unknown;
  model?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  count?: number | undefined;
  mode?: "FAST" | "ULTRA" | undefined;
  promptEnhance?: "AUTO" | "ON" | "OFF" | undefined;
  seed?: number | undefined;
  styleIds?: string[] | undefined;
  public?: boolean | undefined;
}

export interface GenerationRequest {
  generationId: string;
  provider: string;
  project: string;
  assetType: string;
  prompt: string;
  parameters: GenerationParameters;
  references: GenerationReference[];
  parentGenerationId: string | null;
  requestedAt: string;
  waitForCompletion: boolean;
  polling: {
    intervalMs: number;
    timeoutMs: number;
  };
}

export interface GeneratedImage {
  id: string;
  url: string;
  nsfw?: boolean;
  width?: number;
  height?: number;
}

export interface GenerationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface GenerationResult {
  generationId: string;
  provider: string;
  status: GenerationStatus;
  externalGenerationId: string | null;
  externalStatus: string | null;
  images: GeneratedImage[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: GenerationError | null;
}

export interface GenerationRecord {
  schemaVersion: 1;
  request: GenerationRequest;
  result: GenerationResult;
}

export type NewGenerationRequest = Omit<GenerationRequest, "generationId" | "requestedAt">;

export interface ImageProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
  getStatus(request: GenerationRequest, externalGenerationId: string): Promise<GenerationResult>;
}

export function pendingResult(request: GenerationRequest): GenerationResult {
  return {
    generationId: request.generationId,
    provider: request.provider,
    status: "pending",
    externalGenerationId: null,
    externalStatus: null,
    images: [],
    startedAt: request.requestedAt,
    updatedAt: request.requestedAt,
    completedAt: null,
    error: null,
  };
}

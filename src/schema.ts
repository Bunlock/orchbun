import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import AjvModule from "ajv/dist/2020.js";
import type { Options, ValidateFunction } from "ajv";
import type { AgentResult } from "./types.js";

let cachedSchema: Record<string, unknown> | undefined;
let cachedValidator: ValidateFunction<AgentResult> | undefined;

const Ajv = AjvModule as unknown as new (options?: Options) => {
  compile<T>(schema: object): ValidateFunction<T>;
};

export function bundledSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../schemas/agent-result.schema.json");
}

export async function loadResultSchema(): Promise<Record<string, unknown>> {
  cachedSchema ??= JSON.parse(await readFile(bundledSchemaPath(), "utf8")) as Record<string, unknown>;
  return cachedSchema;
}

export async function validateAgentResult(value: unknown): Promise<AgentResult> {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile<AgentResult>(await loadResultSchema());
  }
  const validator = cachedValidator!;
  if (!validator(value)) {
    const message = validator.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`Agent result failed schema validation: ${message}`);
  }
  return value;
}

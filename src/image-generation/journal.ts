import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationRecord, GenerationRequest, GenerationResult } from "./types.js";
import { pendingResult } from "./types.js";

const README = `# Image generation journal

This local directory contains provider-neutral image-generation records.
Each record preserves the request, provider status, resulting image URLs, and lineage.
It is audit history and is not loaded into agent working-memory projections.
`;

export class ImageGenerationJournal {
  readonly generationsRoot: string;

  constructor(readonly memoryRoot: string) {
    this.generationsRoot = path.join(memoryRoot, "generations");
  }

  async initialize(): Promise<void> {
    await mkdir(this.generationsRoot, { recursive: true });
    try {
      await writeFile(path.join(this.generationsRoot, "README.md"), README, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  directory(request: GenerationRequest): string {
    const date = new Date(request.requestedAt);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid generation timestamp ${request.requestedAt}`);
    return path.join(
      this.generationsRoot,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      request.generationId,
    );
  }

  async begin(request: GenerationRequest): Promise<GenerationRecord> {
    const directory = this.directory(request);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    const record = { schemaVersion: 1 as const, request, result: pendingResult(request) };
    await this.write(directory, record);
    return record;
  }

  async complete(request: GenerationRequest, result: GenerationResult): Promise<GenerationRecord> {
    assertResultMatchesRequest(request, result);
    const record = { schemaVersion: 1 as const, request, result };
    await this.write(this.directory(request), record);
    return record;
  }

  async read(directory: string): Promise<GenerationRecord> {
    return JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as GenerationRecord;
  }

  async allRecords(): Promise<Array<{ directory: string; record: GenerationRecord }>> {
    const directories: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.isFile() && entry.name === "record.json")) {
        directories.push(directory);
        return;
      }
      for (const entry of entries) if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    };
    await visit(this.generationsRoot);
    const output = [];
    for (const directory of directories.sort()) output.push({ directory, record: await this.read(directory) });
    return output;
  }

  async find(generationId: string): Promise<{ directory: string; record: GenerationRecord } | null> {
    return (await this.allRecords()).find(({ record }) => record.request.generationId === generationId) ?? null;
  }

  private async write(directory: string, record: GenerationRecord): Promise<void> {
    const target = path.join(directory, "record.json");
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, target);
  }
}

function assertResultMatchesRequest(request: GenerationRequest, result: GenerationResult): void {
  if (result.generationId !== request.generationId) throw new Error("Provider returned the wrong generation ID");
  if (result.provider !== request.provider) throw new Error("Provider returned the wrong provider name");
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_PAGE_DEFINITIONS = [
  ["project-state", "Project state", "project-state.md"],
  ["active-tasks", "Tasks", "active-tasks.md"],
  ["decisions", "Decisions", "decisions.md"],
  ["contracts", "APIs and contracts", "contracts.md"],
  ["risks", "Risks and blockers", "risks.md"],
] as const;

export type MemoryPageId = typeof MEMORY_PAGE_DEFINITIONS[number][0];

const MAX_MEMORY_PAGE_BYTES = 250_000;

export function memoryPageDefinition(id: string): typeof MEMORY_PAGE_DEFINITIONS[number] {
  const page = MEMORY_PAGE_DEFINITIONS.find(([candidate]) => candidate === id);
  if (!page) throw new Error(`Unknown memory page ${id}`);
  return page;
}

export async function saveMemoryOverride(memoryRoot: string, id: string, markdown: string): Promise<void> {
  const [, , filename] = memoryPageDefinition(id);
  if (Buffer.byteLength(markdown, "utf8") > MAX_MEMORY_PAGE_BYTES) {
    throw new Error("Memory page is larger than 250 KB");
  }
  const manual = path.join(memoryRoot, "manual", filename);
  const working = path.join(memoryRoot, "working", filename);
  await Promise.all([mkdir(path.dirname(manual), { recursive: true }), mkdir(path.dirname(working), { recursive: true })]);
  await atomicWrite(manual, normalize(markdown));
  await atomicWrite(working, normalize(markdown));
}

export async function applyMemoryOverrides(memoryRoot: string): Promise<void> {
  await Promise.all(MEMORY_PAGE_DEFINITIONS.map(async ([, , filename]) => {
    try {
      const markdown = await readFile(path.join(memoryRoot, "manual", filename), "utf8");
      await atomicWrite(path.join(memoryRoot, "working", filename), markdown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}

export async function readMemoryPage(memoryRoot: string, id: string): Promise<string> {
  const [, , filename] = memoryPageDefinition(id);
  try {
    return await readFile(path.join(memoryRoot, "working", filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No memory has been generated yet.\n";
    throw error;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function normalize(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MEMORY_PAGE_CATALOGUE,
  MAX_MEMORY_PAGE_BYTES,
  MEMORY_PAGE_DEFINITIONS,
  initialMemoryPageMarkdown,
  type MemoryPageDefinition,
  type MemoryPageId,
} from "./memory-pages.js";

export {
  DEFAULT_MEMORY_PAGE_CATALOGUE,
  MEMORY_PAGE_DEFINITIONS,
  isBuiltInMemoryPageId,
  memoryPageCatalogue,
  type BuiltInMemoryPageId,
  type CustomMemoryPageConfig,
  type MemoryPageDefinition,
  type MemoryPageId,
  type MemoryPagesConfigInput,
} from "./memory-pages.js";

/** Legacy tuple lookup retained for existing callers. */
export function memoryPageDefinition(
  id: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): readonly [string, string, string] {
  const page = resolvedMemoryPageDefinition(id, catalogue);
  return [page.id, page.title, page.filename] as const;
}

export function resolvedMemoryPageDefinition(
  id: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): MemoryPageDefinition {
  const page = catalogue.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown memory page ${id}`);
  assertSafeDefinition(page);
  return page;
}

export async function saveMemoryOverride(
  memoryRoot: string,
  id: string,
  markdown: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): Promise<void> {
  const page = resolvedMemoryPageDefinition(id, catalogue);
  assertPageSize(markdown);
  const manual = manualMemoryPagePath(memoryRoot, page);
  await mkdir(path.dirname(manual), { recursive: true });
  await atomicWrite(manual, normalize(markdown));
}

const ANNOTATION_START = "<!-- orchbun:annotation:start -->";

/** Legacy full-page overrides remain intact on disk and become visible annotations. */
export function withMemoryAnnotation(generated: string, annotation: string): string {
  const content = generated.split(ANNOTATION_START)[0]!.trimEnd();
  return annotation.trim()
    ? `${content}\n\n${ANNOTATION_START}\n## Human annotations\n\nThese notes are preserved as written. Current task and risk status comes from the generated sections above.\n\n${annotation.trimEnd()}\n`
    : `${content}\n`;
}

export function readMemoryAnnotations(memoryRoot: string): Promise<Record<MemoryPageId, string>>;
export function readMemoryAnnotations(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[],
): Promise<Record<string, string>>;
export async function readMemoryAnnotations(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): Promise<Record<string, string>> {
  const entries = await Promise.all(catalogue.map(async (page) => {
    assertSafeDefinition(page);
    if (page.kind === "custom") return [page.id, ""] as const;
    return [page.id, await readIfPresent(manualMemoryPagePath(memoryRoot, page))] as const;
  }));
  return Object.fromEntries(entries);
}

/** Read the authoritative full Markdown for configured custom pages. */
export async function readCustomMemoryPages(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(catalogue.filter((page) => page.kind === "custom").map(async (page) => {
    assertSafeDefinition(page);
    const persisted = await readIfPresent(manualMemoryPagePath(memoryRoot, page));
    return [page.id, persisted || initialMemoryPageMarkdown(page)] as const;
  }));
  return Object.fromEntries(entries);
}

/**
 * Mirror manual content into working memory and remove disabled working pages.
 * Manual sources are deliberately never removed, so re-adding the same custom
 * ID or re-enabling a built-in restores its prior content.
 */
export async function applyMemoryOverrides(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): Promise<void> {
  await mkdir(path.join(memoryRoot, "working"), { recursive: true });
  await mkdir(path.join(memoryRoot, "manual", "pages"), { recursive: true });
  await pruneWorkingMemoryPages(memoryRoot, catalogue);
  await Promise.all(catalogue.map(async (page) => {
    assertSafeDefinition(page);
    if (page.kind === "custom") {
      const manual = manualMemoryPagePath(memoryRoot, page);
      await writeIfMissing(manual, initialMemoryPageMarkdown(page));
      await atomicWrite(path.join(memoryRoot, "working", page.filename), await readFile(manual, "utf8"));
      return;
    }
    const markdown = await readIfPresent(manualMemoryPagePath(memoryRoot, page));
    if (!markdown) return;
    const generated = await readExistingMemoryPage(memoryRoot, page);
    if (generated === null) return;
    await atomicWrite(path.join(memoryRoot, "working", page.filename), withMemoryAnnotation(generated, markdown));
  }));
}

export async function initializeMemoryPageStorage(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): Promise<void> {
  await mkdir(path.join(memoryRoot, "working"), { recursive: true });
  await mkdir(path.join(memoryRoot, "manual", "pages"), { recursive: true });
  await Promise.all(catalogue.map(async (page) => {
    assertSafeDefinition(page);
    if (page.kind === "custom") {
      const manual = manualMemoryPagePath(memoryRoot, page);
      await writeIfMissing(manual, initialMemoryPageMarkdown(page));
      await writeIfMissing(path.join(memoryRoot, "working", page.filename), await readFile(manual, "utf8"));
      return;
    }
    await writeIfMissing(path.join(memoryRoot, "working", page.filename), initialMemoryPageMarkdown(page));
  }));
}

/** Publish-time initialization for custom pages added through a manual config edit. */
export async function initializeCustomMemoryPageStorage(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[],
): Promise<void> {
  await mkdir(path.join(memoryRoot, "manual", "pages"), { recursive: true });
  await Promise.all(catalogue.flatMap((page) => page.kind === "custom"
    ? [writeIfMissing(manualMemoryPagePath(memoryRoot, page), initialMemoryPageMarkdown(page))]
    : []));
}

export async function pruneWorkingMemoryPages(
  memoryRoot: string,
  catalogue: readonly MemoryPageDefinition[],
): Promise<void> {
  const working = path.join(memoryRoot, "working");
  const retained = new Set(catalogue.map((page) => {
    assertSafeDefinition(page);
    return page.filename;
  }));
  let entries: string[];
  try { entries = await readdir(working); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((filename) => filename.endsWith(".md") && !retained.has(filename))
    .map((filename) => rm(path.join(working, filename), { force: true })));
}

export async function readMemoryPage(
  memoryRoot: string,
  id: string,
  catalogue: readonly MemoryPageDefinition[] = DEFAULT_MEMORY_PAGE_CATALOGUE,
): Promise<string> {
  const page = resolvedMemoryPageDefinition(id, catalogue);
  return (await readExistingMemoryPage(memoryRoot, page)) ?? "No memory has been generated yet.\n";
}

export function manualMemoryPagePath(memoryRoot: string, page: MemoryPageDefinition): string {
  assertSafeDefinition(page);
  return page.kind === "custom"
    ? path.join(memoryRoot, "manual", "pages", `${page.id}.md`)
    : path.join(memoryRoot, "manual", page.filename);
}

async function readExistingMemoryPage(memoryRoot: string, page: MemoryPageDefinition): Promise<string | null> {
  try { return await readFile(path.join(memoryRoot, "working", page.filename), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readIfPresent(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, content, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertSafeDefinition(page: MemoryPageDefinition): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.id)
    || page.filename !== `${page.id}.md`
    || path.basename(page.filename) !== page.filename) {
    throw new Error(`Unsafe memory page definition ${page.id}`);
  }
}

function assertPageSize(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > MAX_MEMORY_PAGE_BYTES) {
    throw new Error("Memory page is larger than 250 KB");
  }
}

function normalize(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CONFIG_FILE, pathExists } from "./config.js";
import { buildMemoryProjection, type BuildMemoryProjectionOptions, type MemoryProjection } from "./memory.js";
import {
  DEFAULT_MEMORY_PAGE_CATALOGUE,
  initializeCustomMemoryPageStorage,
  type MemoryPageDefinition,
} from "./memory-overrides.js";
import type { RunJournal } from "./journal.js";
import { contentHash } from "./utils.js";

export interface RefreshedMemory {
  schemaVersion: 1 | 2;
  revision: string;
  refreshedAt: string | null;
  changedPages: string[];
  projection: MemoryProjection;
  diagnostics?: string[];
}

export class MemoryConflict extends Error {
  constructor() { super("Project state changed. Refresh and review the newer state before saving; your edit has not been applied."); }
}

export async function readRefreshedMemory(memoryRoot: string): Promise<RefreshedMemory | null> {
  let raw: string;
  try { raw = await readFile(path.join(memoryRoot, "refresh", "state.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as RefreshedMemory;
  if (![1, 2].includes(parsed.schemaVersion) || !parsed.projection
    || parsed.revision !== contentHash(JSON.stringify(parsed.projection))
    || !parsed.refreshedAt || !Number.isFinite(Date.parse(parsed.refreshedAt))
    || !Array.isArray(parsed.changedPages)) {
    throw new Error("Invalid published project-state snapshot");
  }
  const state = parsed.schemaVersion === 1 ? migrateLegacyState(parsed) : parsed;
  if (!validProjectionPages(state.projection)) throw new Error("Invalid published project-state snapshot");
  return state;
}

/** Two matching captures prevent publishing a view assembled across changing source files. */
async function capture(
  journal: RunJournal,
  projectRoot?: string,
  options: BuildMemoryProjectionOptions = {},
): Promise<MemoryProjection> {
  let previous = await buildMemoryProjection(journal, projectRoot, options);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await buildMemoryProjection(journal, projectRoot, options);
    if (contentHash(JSON.stringify(previous)) === contentHash(JSON.stringify(next))) return next;
    previous = next;
  }
  throw new Error("Project sources are changing during refresh. Retry once the update finishes.");
}

export async function refreshMemory(journal: RunJournal, projectRoot?: string, publish = true): Promise<RefreshedMemory> {
  if (publish) return journal.withProjectionLock(() => refreshMemoryUnlocked(journal, projectRoot));
  if (await pendingPublication(journal.memoryRoot)) throw new Error("An interrupted refresh needs recovery. Run memory refresh before preparing read-only context.");
  const projection = await capture(journal, projectRoot, { cacheWrites: false });
  return describe(projection, await readRefreshedMemory(journal.memoryRoot));
}

function describe(projection: MemoryProjection, previous: RefreshedMemory | null): RefreshedMemory {
  const revision = contentHash(JSON.stringify(projection));
  // Reading a v1 snapshot supplies an in-memory catalogue for compatibility,
  // but the next publishing refresh must still replace it with the dynamic v2
  // receipt even when no source content changed.
  if (previous?.schemaVersion === 2 && previous.revision === revision) return previous;
  const ids = new Set([
    ...(previous?.projection.pageDefinitions ?? []).map((page) => page.id),
    ...projection.pageDefinitions.map((page) => page.id),
  ]);
  return {
    schemaVersion: 2, revision, refreshedAt: null, projection,
    changedPages: [...ids].filter((id) => previous?.projection.pages[id] !== projection.pages[id]),
  };
}

/** Caller holds the projection lock. Publishes a recoverable working tree and one authoritative receipt. */
export async function refreshMemoryUnlocked(journal: RunJournal, projectRoot?: string): Promise<RefreshedMemory> {
  await recoverPublication(journal.memoryRoot);
  const projection = await capture(journal, projectRoot, { cacheWrites: true });
  await initializeCustomMemoryPageStorage(journal.memoryRoot, projection.pageDefinitions);
  const previous = await readRefreshedMemory(journal.memoryRoot);
  const next = describe(projection, previous);
  const working = path.join(journal.memoryRoot, "working");
  if (next === previous && await mirrorsMatch(working, next)) {
    await publishIndex(journal.memoryRoot, next.projection.index);
    return publishSearchIndexBestEffort(next, projectRoot);
  }
  const state = { ...next, refreshedAt: next.refreshedAt ?? new Date().toISOString() };
  const token = randomUUID();
  const staged = path.join(journal.memoryRoot, `.refresh-${token}`);
  const backup = path.join(journal.memoryRoot, `.refresh-backup-${token}`);
  const receipt = path.join(journal.memoryRoot, "refresh", "state.json");
  const temporary = `${receipt}.${token}.tmp`;
  const pending = path.join(journal.memoryRoot, "refresh", "pending.json");
  let backedUp = false;
  let installed = false;
  try {
    await mkdir(staged, { recursive: true });
    try { await cp(working, staged, { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await pruneStagedPages(staged, state.projection.pageDefinitions);
    for (const page of state.projection.pageDefinitions) {
      await writeFile(path.join(staged, page.filename), state.projection.pages[page.id] ?? "");
    }
    await mkdir(path.dirname(receipt), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    await writeFile(pending, JSON.stringify({ token, revision: state.revision }), { flag: "wx" });
    try { await rename(working, backup); backedUp = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(staged, working);
    installed = true;
    await rename(temporary, receipt);
  } catch (error) {
    if (installed) await rm(working, { recursive: true, force: true });
    if (backedUp) await rename(backup, working);
    await rm(pending, { force: true });
    throw error;
  } finally {
    await rm(staged, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
  await rm(backup, { recursive: true, force: true });
  await rm(pending, { force: true });
  await publishIndex(journal.memoryRoot, state.projection.index);
  return publishSearchIndexBestEffort(state, projectRoot);
}

async function publishSearchIndexBestEffort(state: RefreshedMemory, projectRoot?: string): Promise<RefreshedMemory> {
  if (!projectRoot || !await pathExists(path.join(projectRoot, CONFIG_FILE))) return state;
  try {
    await publishSearchIndex(projectRoot, state.projection.sourceRevision);
    return state;
  } catch (error) {
    return {
      ...state,
      diagnostics: [`Search index was not published; retrieval will rebuild it in memory: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function publishSearchIndex(projectRoot: string, expectedSourceRevision: string): Promise<void> {
  const { MemoryService } = await import("./memory-service.js");
  const service = await MemoryService.open(projectRoot);
  if (service.sourceRevision !== expectedSourceRevision) {
    throw new Error("Project sources changed while building the search index. Retry the refresh once the update finishes.");
  }
  await service.refreshIndexUnlocked(expectedSourceRevision);
}

async function publishIndex(root: string, markdown: string): Promise<void> {
  const file = path.join(root, "index.md");
  try { if (await readFile(file, "utf8") === markdown) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, markdown, { flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function pendingPublication(root: string): Promise<{ token: string; revision: string } | null> {
  let raw: string;
  try { raw = await readFile(path.join(root, "refresh", "pending.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const pending = JSON.parse(raw) as { token: string; revision: string };
  if (!/^[0-9a-f-]{36}$/.test(pending.token) || !/^[0-9a-f]{64}$/.test(pending.revision)) throw new Error("Invalid refresh recovery receipt");
  return pending;
}

async function recoverPublication(root: string): Promise<void> {
  const pending = await pendingPublication(root);
  if (!pending) return;
  const state = await readRefreshedMemory(root);
  const working = path.join(root, "working");
  const backup = path.join(root, `.refresh-backup-${pending.token}`);
  if (state?.revision !== pending.revision || !await mirrorsMatch(working, state)) {
    try {
      // A backup includes compact-state.json and whichever pages were enabled.
      await readdir(backup);
      await rm(working, { recursive: true, force: true });
      await rename(backup, working);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await rm(backup, { recursive: true, force: true });
  await rm(path.join(root, `.refresh-${pending.token}`), { recursive: true, force: true });
  await rm(path.join(root, "refresh", `state.json.${pending.token}.tmp`), { force: true });
  await rm(path.join(root, "refresh", "pending.json"));
}

async function mirrorsMatch(working: string, state: RefreshedMemory): Promise<boolean> {
  const expected = new Set(state.projection.pageDefinitions.map((page) => page.filename));
  for (const page of state.projection.pageDefinitions) {
    try { if (await readFile(path.join(working, page.filename), "utf8") !== state.projection.pages[page.id]) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
  }
  let filenames: string[];
  try { filenames = await readdir(working); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return expected.size === 0;
    throw error;
  }
  return filenames.filter((filename) => filename.endsWith(".md")).every((filename) => expected.has(filename));
}

/** Serialize web/CLI edits with refresh and reject stale clients before touching sources. */
export async function updateMemory<T>(
  journal: RunJournal, projectRoot: string, expectedRevision: string,
  update: (projection: MemoryProjection) => Promise<T>,
): Promise<{ value: T; memory: RefreshedMemory }> {
  return journal.withProjectionLock(async () => {
    await recoverPublication(journal.memoryRoot);
    const current = await capture(journal, projectRoot, { cacheWrites: false });
    if (contentHash(JSON.stringify(current)) !== expectedRevision) throw new MemoryConflict();
    const value = await update(current);
    const memory = await refreshMemoryUnlocked(journal, projectRoot);
    return { value, memory };
  });
}

function validProjectionPages(projection: MemoryProjection): boolean {
  return Array.isArray(projection.pageDefinitions)
    && projection.pageDefinitions.every((page) => typeof page?.id === "string" && typeof page.filename === "string"
      && typeof projection.pages?.[page.id] === "string" && typeof projection.annotations?.[page.id] === "string");
}

function migrateLegacyState(state: RefreshedMemory): RefreshedMemory {
  const projection = state.projection as MemoryProjection & { pageDefinitions?: MemoryPageDefinition[]; sections?: MemoryProjection["sections"] };
  const pageDefinitions = DEFAULT_MEMORY_PAGE_CATALOGUE.filter((page) => typeof projection.pages?.[page.id] === "string")
    .map((page) => ({ ...page }));
  const bulletItems = (markdown: string | undefined): string[] => (markdown ?? "").split(/\r?\n/)
    .flatMap((line) => /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim() ?? []);
  return {
    ...state,
    projection: {
      ...projection,
      pageDefinitions,
      sections: projection.sections ?? {
        projectState: projection.pages?.["project-state"] ?? "",
        activeTasks: projection.pages?.["active-tasks"] ?? "",
        decisions: bulletItems(projection.pages?.decisions),
        contracts: bulletItems(projection.pages?.contracts),
        risks: bulletItems(projection.pages?.risks),
      },
    },
  };
}

async function pruneStagedPages(
  staged: string,
  next: readonly MemoryPageDefinition[],
): Promise<void> {
  const keep = new Set(next.map((page) => page.filename));
  let entries: string[];
  try { entries = await readdir(staged); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((filename) => filename.endsWith(".md") && !keep.has(filename))
    .map((filename) => rm(path.join(staged, filename), { force: true })));
}

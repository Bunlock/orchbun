import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildMemoryProjection, type MemoryProjection } from "./memory.js";
import { MEMORY_PAGE_DEFINITIONS, type MemoryPageId } from "./memory-overrides.js";
import type { RunJournal } from "./journal.js";
import { contentHash } from "./utils.js";

export interface RefreshedMemory {
  schemaVersion: 1;
  revision: string;
  refreshedAt: string | null;
  changedPages: MemoryPageId[];
  projection: MemoryProjection;
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
  const state = JSON.parse(raw) as RefreshedMemory;
  if (state.schemaVersion !== 1 || !state.projection || state.revision !== contentHash(JSON.stringify(state.projection))
    || !state.refreshedAt || !Number.isFinite(Date.parse(state.refreshedAt))
    || !Array.isArray(state.changedPages)
    || MEMORY_PAGE_DEFINITIONS.some(([id]) => typeof state.projection.pages?.[id] !== "string" || typeof state.projection.annotations?.[id] !== "string")) {
    throw new Error("Invalid published project-state snapshot");
  }
  return state;
}

/** Two matching captures prevent publishing a view assembled across changing source files. */
async function capture(journal: RunJournal, projectRoot?: string): Promise<MemoryProjection> {
  let previous = await buildMemoryProjection(journal, projectRoot);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await buildMemoryProjection(journal, projectRoot);
    if (contentHash(JSON.stringify(previous)) === contentHash(JSON.stringify(next))) return next;
    previous = next;
  }
  throw new Error("Project sources are changing during refresh. Retry once the update finishes.");
}

export async function refreshMemory(journal: RunJournal, projectRoot?: string, publish = true): Promise<RefreshedMemory> {
  if (publish) return journal.withProjectionLock(() => refreshMemoryUnlocked(journal, projectRoot));
  if (await pendingPublication(journal.memoryRoot)) throw new Error("An interrupted refresh needs recovery. Run memory refresh before preparing read-only context.");
  const projection = await capture(journal, projectRoot);
  return describe(projection, await readRefreshedMemory(journal.memoryRoot));
}

function describe(projection: MemoryProjection, previous: RefreshedMemory | null): RefreshedMemory {
  const revision = contentHash(JSON.stringify(projection));
  if (previous?.revision === revision) return previous;
  return {
    schemaVersion: 1, revision, refreshedAt: null, projection,
    changedPages: MEMORY_PAGE_DEFINITIONS.flatMap(([id]) => previous?.projection.pages[id] === projection.pages[id] ? [] : [id]),
  };
}

/** Caller holds the projection lock. Publishes a recoverable working tree and one authoritative receipt. */
export async function refreshMemoryUnlocked(journal: RunJournal, projectRoot?: string): Promise<RefreshedMemory> {
  await recoverPublication(journal.memoryRoot);
  const projection = await capture(journal, projectRoot);
  const previous = await readRefreshedMemory(journal.memoryRoot);
  const next = describe(projection, previous);
  const working = path.join(journal.memoryRoot, "working");
  if (next === previous && await mirrorsMatch(working, next)) {
    await publishIndex(journal.memoryRoot, next.projection.index);
    return next;
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
    for (const [id, , filename] of MEMORY_PAGE_DEFINITIONS) await writeFile(path.join(staged, filename), state.projection.pages[id]);
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
  return state;
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
      // A backup includes compact-state.json as well as the five pages.
      await readFile(path.join(backup, "project-state.md"));
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
  for (const [id, , filename] of MEMORY_PAGE_DEFINITIONS) {
    try { if (await readFile(path.join(working, filename), "utf8") !== state.projection.pages[id]) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
  }
  return true;
}

/** Serialize web/CLI edits with refresh and reject stale clients before touching sources. */
export async function updateMemory<T>(
  journal: RunJournal, projectRoot: string, expectedRevision: string,
  update: (projection: MemoryProjection) => Promise<T>,
): Promise<{ value: T; memory: RefreshedMemory }> {
  return journal.withProjectionLock(async () => {
    await recoverPublication(journal.memoryRoot);
    const current = await capture(journal, projectRoot);
    if (contentHash(JSON.stringify(current)) !== expectedRevision) throw new MemoryConflict();
    const value = await update(current);
    const memory = await refreshMemoryUnlocked(journal, projectRoot);
    return { value, memory };
  });
}

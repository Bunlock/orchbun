import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const PERMISSION_BITS = 0o7777n;

/** Durably replace one file while preserving its existing mode. */
export async function atomicReplaceFile(target: string, content: string): Promise<void> {
  let mode: bigint | undefined;
  try { mode = (await stat(target, { bigint: true })).mode; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = await stageReplacement(target, content, mode);
  try {
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Replace a file only while its bytes and file identity remain stable during
 * this operation. Returns false without changing the target on conflict.
 *
 * Portable Node does not expose a conditional rename. Keeping the target name
 * continuously available therefore leaves a final comparison-to-rename window
 * for writers which do not share a higher-level lock. Pinning the read to one
 * inode and comparing nanosecond metadata immediately before rename is the
 * strongest portable check which preserves atomic publication and durability.
 */
export async function atomicReplaceFileIfUnchanged(
  target: string,
  expected: string,
  content: string,
): Promise<boolean> {
  const reviewed = await readStableFileVersion(target);
  if (!reviewed || reviewed.content !== expected) return false;

  const temporary = await stageReplacement(target, content, reviewed.stats.mode);
  try {
    let current: BigIntStats;
    try { current = await stat(target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!sameFileVersion(reviewed.stats, current)) return false;
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readStableFileVersion(target: string): Promise<{ content: string; stats: BigIntStats } | null> {
  const handle = await open(target, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    return sameFileVersion(before, after) ? { content, stats: after } : null;
  } finally {
    await handle.close();
  }
}

async function stageReplacement(target: string, content: string, mode?: bigint): Promise<string> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    if (mode !== undefined) await chmod(temporary, Number(mode & PERMISSION_BITS));
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return temporary;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  catch (error) {
    if (!["EINVAL", "EBADF", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle.close(); }
}

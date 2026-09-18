import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicReplaceFileIfUnchanged } from "./atomic-file.js";
import { contentHash } from "./utils.js";

export type RoadmapUpdate = "updated" | "already-complete" | "not-found" | "missing" | "conflict";

export interface RoadmapTask {
  id: string;
  title: string;
  completed: boolean;
  milestone: string;
  milestoneTitle: string;
  order: number;
}

export interface RoadmapState {
  path: string;
  hash: string;
  tasks: RoadmapTask[];
  activeMilestone: string | null;
}

const TASK_LINE = /^\s*-\s+\[([ xX])\]\s+\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\*\*\s*(.*)$/;
const MILESTONE_LINE = /^#{2,4}\s+(?:Phase\s+)?([A-Z0-9]+)\s+[—-]\s+(.+)$/;

export async function loadRoadmap(root: string, relativePath = "ROADMAP.md"): Promise<RoadmapState> {
  const roadmapPath = await resolveProjectMarkdownPath(root, relativePath);
  const raw = await readFile(roadmapPath, "utf8");
  return parseRoadmapMarkdown(raw, relativePath);
}

/** Parse an internal roadmap candidate without publishing it to the project. */
export function parseRoadmapMarkdown(raw: string, relativePath = "ROADMAP.md"): RoadmapState {
  const tasks: RoadmapTask[] = [];
  let milestone = "unscoped";
  let milestoneTitle = "Unscoped";
  let current: RoadmapTask | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const heading = MILESTONE_LINE.exec(line);
    if (heading) {
      milestone = heading[1]!;
      milestoneTitle = heading[2]!.trim();
      current = undefined;
      continue;
    }
    const task = TASK_LINE.exec(line);
    if (task) {
      current = {
        id: task[2]!,
        title: task[3]!.trim(),
        completed: task[1]!.toLowerCase() === "x",
        milestone,
        milestoneTitle,
        order: tasks.length,
      };
      tasks.push(current);
      continue;
    }
    const continuation = /^\s{2,}(\S.*)$/.exec(line);
    if (current && continuation && !continuation[1]!.startsWith("**Exit:")) {
      current.title = `${current.title} ${continuation[1]!.trim()}`.trim();
    } else if (!line.trim()) {
      current = undefined;
    }
  }

  const activeMilestone = tasks.find((task) => !task.completed)?.milestone ?? null;
  return {
    path: relativePath,
    hash: contentHash(raw),
    tasks,
    activeMilestone,
  };
}

export async function completeRoadmapTask(
  root: string,
  taskId: string,
  relativePath = "ROADMAP.md",
): Promise<RoadmapUpdate> {
  return setRoadmapTaskCompletion(root, taskId, true, relativePath);
}

export async function setRoadmapTaskCompletion(
  root: string,
  taskId: string,
  completed: boolean,
  relativePath = "ROADMAP.md",
  expectedHash?: string,
): Promise<RoadmapUpdate> {
  let roadmap: string;
  try {
    roadmap = await resolveProjectMarkdownPath(root, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  let current: string;
  try {
    current = await readFile(roadmap, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (expectedHash !== undefined && contentHash(current) !== expectedHash) return "conflict";

  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const task = new RegExp(`^(\\s*-\\s+\\[)([ xX])(\\]\\s+\\*\\*${escaped}\\*\\*)`, "m");
  const match = task.exec(current);
  if (!match) return "not-found";
  const isComplete = match[2]!.toLowerCase() === "x";
  if (isComplete === completed) return "already-complete";
  const updated = current.replace(task, `$1${completed ? "x" : " "}$3`);
  return await atomicReplaceFileIfUnchanged(roadmap, current, updated) ? "updated" : "conflict";
}

export function projectMarkdownPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.extname(relativePath).toLowerCase() !== ".md") {
    throw new Error("Roadmap path must be a project-relative .md file");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (relative === "") return resolved;
    throw new Error("Roadmap path must stay inside the project");
  }
  return resolved;
}

/**
 * Resolve a roadmap path through its existing filesystem ancestors and reject
 * symlinks that leave the project. Missing targets are allowed only for an
 * explicit create flow and are returned beneath the nearest canonical parent.
 */
export async function resolveProjectMarkdownPath(
  root: string,
  relativePath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = projectMarkdownPath(lexicalRoot, relativePath);
  const canonicalRoot = await realpath(lexicalRoot);
  try {
    const canonicalTarget = await realpath(lexicalTarget);
    assertInsideProject(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.allowMissing) throw error;
  }

  try {
    await lstat(lexicalTarget);
    throw new Error("Roadmap path must not be a dangling symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let ancestor = path.dirname(lexicalTarget);
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      assertInsideProject(canonicalRoot, canonicalAncestor);
      const canonicalTarget = path.resolve(canonicalAncestor, path.relative(ancestor, lexicalTarget));
      assertInsideProject(canonicalRoot, canonicalTarget);
      return canonicalTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const unresolved = await lstat(ancestor);
        if (unresolved.isSymbolicLink()) throw new Error("Roadmap path must not contain a dangling symlink");
        throw error;
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function assertInsideProject(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Roadmap path must stay inside the project after resolving symlinks");
  }
}

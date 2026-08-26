import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./utils.js";

export type RoadmapUpdate = "updated" | "already-complete" | "not-found" | "missing";

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
  const roadmapPath = projectMarkdownPath(root, relativePath);
  const raw = await readFile(roadmapPath, "utf8");
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

export async function completeRoadmapTask(root: string, taskId: string): Promise<RoadmapUpdate> {
  return setRoadmapTaskCompletion(root, taskId, true);
}

export async function setRoadmapTaskCompletion(
  root: string,
  taskId: string,
  completed: boolean,
  relativePath = "ROADMAP.md",
): Promise<RoadmapUpdate> {
  const roadmap = projectMarkdownPath(root, relativePath);
  let current: string;
  try {
    current = await readFile(roadmap, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }

  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const task = new RegExp(`^(\\s*-\\s+\\[)([ xX])(\\]\\s+\\*\\*${escaped}\\*\\*)`, "m");
  const match = task.exec(current);
  if (!match) return "not-found";
  const isComplete = match[2]!.toLowerCase() === "x";
  if (isComplete === completed) return "already-complete";
  const updated = current.replace(task, `$1${completed ? "x" : " "}$3`);
  const temporary = `${roadmap}.${process.pid}.tmp`;
  await writeFile(temporary, updated);
  await rename(temporary, roadmap);
  return "updated";
}

export function projectMarkdownPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.extname(relativePath).toLowerCase() !== ".md") {
    throw new Error("Roadmap path must be a project-relative .md file");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (relative === "") return resolved;
    throw new Error("Roadmap path must stay inside the project");
  }
  return resolved;
}

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
const MILESTONE_LINE = /^##\s+([A-Z0-9]+)\s+[—-]\s+(.+)$/;

export async function loadRoadmap(root: string): Promise<RoadmapState> {
  const roadmapPath = path.join(root, "ROADMAP.md");
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
    path: "ROADMAP.md",
    hash: contentHash(raw),
    tasks,
    activeMilestone,
  };
}

export async function completeRoadmapTask(root: string, taskId: string): Promise<RoadmapUpdate> {
  const roadmap = path.join(root, "ROADMAP.md");
  let current: string;
  try {
    current = await readFile(roadmap, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }

  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`^(\\s*-\\s+\\[) \\](\\s+\\*\\*${escaped}\\*\\*)`, "m");
  const complete = new RegExp(`^\\s*-\\s+\\[x\\]\\s+\\*\\*${escaped}\\*\\*`, "mi");
  if (complete.test(current)) return "already-complete";
  if (!open.test(current)) return "not-found";

  const updated = current.replace(open, "$1x]$2");
  const temporary = `${roadmap}.${process.pid}.tmp`;
  await writeFile(temporary, updated);
  await rename(temporary, roadmap);
  return "updated";
}

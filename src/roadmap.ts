import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type RoadmapUpdate = "updated" | "already-complete" | "not-found" | "missing";

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

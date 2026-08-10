import { createHash } from "node:crypto";
import { runProcess } from "./adapters/process.js";

export interface GitSnapshot {
  head: string;
  fingerprint: string;
}

export async function gitSnapshot(root: string): Promise<GitSnapshot> {
  const head = await runProcess("git", ["rev-parse", "HEAD"], root);
  const status = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  const diff = await runProcess("git", ["diff", "--binary", "HEAD"], root);
  if (head.exitCode !== 0 || status.exitCode !== 0 || diff.exitCode !== 0) {
    return { head: "not-a-git-repository", fingerprint: "unavailable" };
  }
  return {
    head: head.stdout.trim(),
    fingerprint: createHash("sha256").update(status.stdout).update(diff.stdout).digest("hex"),
  };
}

export function snapshotLabel(snapshot: GitSnapshot): string {
  return `${snapshot.head}:${snapshot.fingerprint}`;
}

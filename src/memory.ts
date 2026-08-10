import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { metadataFromYaml, RunJournal } from "./journal.js";
import type { AgentResult, RunMetadata } from "./types.js";

interface RecordedRun {
  directory: string;
  metadata: RunMetadata;
  result?: AgentResult;
}

export interface VerifyReport {
  runs: number;
  issues: string[];
}

export async function loadRuns(journal: RunJournal): Promise<RecordedRun[]> {
  const runs: RecordedRun[] = [];
  for (const directory of await journal.allRunDirectories()) {
    try {
      const raw = YAML.parse(await readFile(path.join(directory, "metadata.yaml"), "utf8")) as Record<string, unknown>;
      const metadata = metadataFromYaml(raw);
      let result: AgentResult | undefined;
      try {
        result = await journal.readResult(directory);
      } catch {
        // Pending and failed runs legitimately have no normalized result.
      }
      runs.push({ directory, metadata, ...(result ? { result } : {}) });
    } catch {
      runs.push({
        directory,
        metadata: {
          runId: path.basename(directory), parentRunId: null, taskId: null, depth: 0,
          agent: "codex", mode: "review", status: "failed", startedAt: "invalid",
          finishedAt: null, promptHash: "invalid", inputCharacters: 0,
          estimatedInputTokens: 0, includedFiles: [], omittedFiles: [],
        },
      });
    }
  }
  return runs.sort((a, b) => a.metadata.startedAt.localeCompare(b.metadata.startedAt));
}

export async function rebuildMemory(journal: RunJournal): Promise<void> {
  await journal.withProjectionLock(() => rebuildMemoryUnlocked(journal));
}

async function rebuildMemoryUnlocked(journal: RunJournal): Promise<void> {
  const runs = await loadRuns(journal);
  const completed = runs.filter((run) => run.result);
  const recent = completed.slice(-20);
  const stateLines = recent.map((run) => {
    const task = run.metadata.taskId ? ` ${run.metadata.taskId}` : "";
    return `- **${run.metadata.startedAt.slice(0, 10)} · ${run.metadata.agent}${task}:** ${run.result!.summary}`;
  });

  const latestTasks = new Map<string, RecordedRun>();
  for (const run of completed) if (run.metadata.taskId) latestTasks.set(run.metadata.taskId, run);
  const taskLines = [...latestTasks.entries()].map(([taskId, run]) => {
    const next = run.result!.next_actions[0] ?? "Review the latest result.";
    return `- **${taskId} · ${run.result!.outcome}:** ${next}`;
  });

  const unique = (values: string[]): string[] => [...new Map(values.map((value) => [value.trim().toLowerCase(), value.trim()])).values()];
  const decisions = unique(completed.flatMap((run) => run.result!.decisions));
  const risks = unique(completed.flatMap((run) => [...run.result!.risks, ...run.result!.blockers]));
  const links = runs.slice(-30).reverse().map((run) => {
    const relative = path.relative(journal.memoryRoot, run.directory).split(path.sep).join("/");
    return `- [[${relative}/summary|${run.metadata.runId}]] · ${run.metadata.agent} · ${run.metadata.status}${run.metadata.taskId ? ` · ${run.metadata.taskId}` : ""}`;
  });

  await Promise.all([
    writeFile(path.join(journal.memoryRoot, "working", "project-state.md"), `# Project state\n\n${stateLines.join("\n") || "No completed managed runs."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "active-tasks.md"), `# Active tasks\n\n${taskLines.join("\n") || "No task-linked runs."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "decisions.md"), `# Decisions\n\n${decisions.map((item) => `- ${item}`).join("\n") || "No decisions recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "risks.md"), `# Risks and blockers\n\n${risks.map((item) => `- ${item}`).join("\n") || "No risks recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "index.md"), `# Agent runs\n\n${links.join("\n") || "No runs recorded."}\n`),
  ]);
}

export async function verifyMemory(journal: RunJournal): Promise<VerifyReport> {
  const runs = await loadRuns(journal);
  const issues: string[] = [];
  const ids = new Set(runs.map((run) => run.metadata.runId));
  for (const run of runs) {
    try {
      await readFile(path.join(run.directory, "prompt.md"), "utf8");
    } catch {
      issues.push(`${run.metadata.runId}: missing prompt.md`);
    }
    if (["completed", "partial", "blocked"].includes(run.metadata.status) && !run.result) {
      issues.push(`${run.metadata.runId}: ${run.metadata.status} run is missing result.json`);
    }
    if (run.metadata.parentRunId && !ids.has(run.metadata.parentRunId)) {
      issues.push(`${run.metadata.runId}: missing parent ${run.metadata.parentRunId}`);
    }
  }
  return { runs: runs.length, issues };
}

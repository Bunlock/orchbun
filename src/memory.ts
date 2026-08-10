import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { assertValidDirectMemory, loadDirectMemory } from "./direct-memory.js";
import { metadataFromYaml, RunJournal } from "./journal.js";
import { loadApprovedMilestoneManifest, loadCompactArchives, readCompactState, renderCompactProjectState } from "./milestone-memory.js";
import type { AgentResult, RunMetadata } from "./types.js";
import { contentHash } from "./utils.js";

interface RecordedRun {
  directory: string;
  metadata: RunMetadata;
  result?: AgentResult;
}

export interface VerifyReport {
  runs: number;
  directNotes: number;
  compactArchives: number;
  issues: string[];
}

interface ProjectionRecord {
  startedAt: string;
  stateLabel: string;
  summary: string;
  taskId: string | null;
  outcome: string;
  decisions: string[];
  risks: string[];
  nextActions: string[];
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
  const direct = await loadDirectMemory(journal.memoryRoot);
  assertValidDirectMemory(direct);
  const compact = await readCompactState(journal.memoryRoot);
  const includedRunIds = new Set(compact?.includedManagedRunIds ?? []);
  const includedDirectIds = new Set(compact?.includedDirectNoteIds ?? []);
  const completed = runs.filter((run) => run.result && !includedRunIds.has(run.metadata.runId));
  const managedProjections: ProjectionRecord[] = completed.map((run) => ({
      startedAt: run.metadata.startedAt,
      stateLabel: `${run.metadata.agent}${run.metadata.taskId ? ` ${run.metadata.taskId}` : ""}`,
      summary: run.result!.summary,
      taskId: run.metadata.taskId,
      outcome: run.result!.outcome,
      decisions: run.result!.decisions,
      risks: [...run.result!.risks, ...run.result!.blockers],
      nextActions: run.result!.next_actions,
    }));
  const directProjections = new Map(direct.notes.filter((note) => !includedDirectIds.has(note.id)).map((note) => [note.id, {
      startedAt: note.timestamp,
      stateLabel: `direct ${note.slug}`,
      summary: note.outcome,
      taskId: note.task,
      outcome: "recorded",
      decisions: note.decisions,
      risks: note.risks,
      nextActions: note.nextActions,
    } satisfies ProjectionRecord]));
  const projections = [...managedProjections, ...directProjections.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const supersededDirectIds = new Set(direct.notes.flatMap((note) => note.supersedes));
  const currentProjections = [
    ...managedProjections,
    ...[...directProjections.entries()].filter(([id]) => !supersededDirectIds.has(id)).map(([, record]) => record),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const stateLines = projections.slice(-20).map((record) =>
    `- **${record.startedAt.slice(0, 10)} · ${record.stateLabel}:** ${record.summary}`,
  );

  const latestTasks = new Map<string, ProjectionRecord>();
  for (const record of currentProjections) if (record.taskId && record.nextActions.length) latestTasks.set(record.taskId, record);
  const taskLines = [...latestTasks.entries()].map(([taskId, record]) => {
    const next = record.nextActions[0] ?? "Review the latest result.";
    return `- **${taskId} · ${record.outcome}:** ${next}`;
  });

  const unique = (values: string[]): string[] => [...new Map(values.map((value) => [value.trim().toLowerCase(), value.trim()])).values()];
  const decisions = unique([...(compact?.baseline.decisions ?? []), ...currentProjections.flatMap((record) => record.decisions)]);
  const risks = unique([...(compact?.baseline.risks ?? []), ...currentProjections.flatMap((record) => record.risks)]);
  const projectState = compact
    ? `${renderCompactProjectState(compact).trim()}${stateLines.length ? `\n\n## Since compaction\n\n${stateLines.join("\n")}` : ""}\n`
    : `# Project state\n\n${stateLines.join("\n") || "No completed managed runs or direct notes."}\n`;
  const baselineTasks = compact?.baseline.pendingWork.map((item) => `- ${item}`) ?? [];
  const links = [
    ...runs.map((run) => {
      const relative = path.relative(journal.memoryRoot, run.directory).split(path.sep).join("/");
      const target = run.result ? "summary" : "metadata";
      return {
        startedAt: run.metadata.startedAt,
        line: `- [[${relative}/${target}|${run.metadata.runId}]] · ${run.metadata.agent} · ${run.metadata.status}${run.metadata.taskId ? ` · ${run.metadata.taskId}` : ""}`,
      };
    }),
    ...direct.notes.map((note) => ({
      startedAt: note.timestamp,
      line: `- [[${note.relativePath}|${note.id}]] · direct · recorded · ${note.task}`,
    })),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-30).reverse().map((entry) => entry.line);

  await Promise.all([
    writeFile(path.join(journal.memoryRoot, "working", "project-state.md"), projectState),
    writeFile(path.join(journal.memoryRoot, "working", "active-tasks.md"), `# Active tasks\n\n${[...baselineTasks, ...taskLines].join("\n") || "No task-linked memory records."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "decisions.md"), `# Decisions\n\n${decisions.map((item) => `- ${item}`).join("\n") || "No decisions recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "contracts.md"), `# APIs and contracts\n\n${compact?.baseline.contracts.map((item) => `- ${item}`).join("\n") || "No APIs or contracts recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "risks.md"), `# Risks and blockers\n\n${risks.map((item) => `- ${item}`).join("\n") || "No risks recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "index.md"), `# Agent runs\n\n${links.join("\n") || "No runs recorded."}\n`),
  ]);
}

export async function verifyMemory(journal: RunJournal): Promise<VerifyReport> {
  const runs = await loadRuns(journal);
  const direct = await loadDirectMemory(journal.memoryRoot);
  const compact = await readCompactState(journal.memoryRoot);
  let archives: Awaited<ReturnType<typeof loadCompactArchives>> = [];
  const issues: string[] = direct.issues.map((issue) => `direct: ${issue}`);
  try {
    archives = await loadCompactArchives(journal.memoryRoot);
  } catch (error) {
    issues.push(`compact archive index: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  for (const archive of archives) {
    for (const relative of ["approved-manifest.yaml", "working/project-state.md"]) {
      try {
        await readFile(path.join(archive.directory, ...relative.split("/")), "utf8");
      } catch {
        issues.push(`compact ${archive.state.milestone}: archive is missing ${relative}`);
      }
    }
    try {
      const archivedManifest = await loadApprovedMilestoneManifest(path.join(archive.directory, "approved-manifest.yaml"));
      if (contentHash(archivedManifest.raw) !== archive.state.manifestHash) {
        issues.push(`compact ${archive.state.milestone}: approved manifest hash does not match publication`);
      }
      if (archive.state.archivePath !== archive.relativePath) {
        issues.push(`compact ${archive.state.milestone}: publication archive path does not match its location`);
      }
    } catch (error) {
      issues.push(`compact ${archive.state.milestone}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (compact && !archives.some((archive) => archive.relativePath === compact.archivePath)) {
    issues.push(`compact ${compact.milestone}: active baseline points to a missing archive`);
  }
  return { runs: runs.length, directNotes: direct.notes.length, compactArchives: archives.length, issues };
}

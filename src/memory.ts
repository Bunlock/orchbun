import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE, loadConfig, pathExists } from "./config.js";
import { assertValidDirectMemory, loadDirectMemory, resolveDirectMemory } from "./direct-memory.js";
import { ImageGenerationJournal } from "./image-generation/journal.js";
import { metadataFromYaml, RunJournal } from "./journal.js";
import { loadApprovedMilestoneManifest, loadCompactArchives, readCompactState, renderCompactProjectState } from "./milestone-memory.js";
import type { AgentResult, RunMetadata } from "./types.js";
import { contentHash } from "./utils.js";
import { applyMemoryOverrides } from "./memory-overrides.js";

interface RecordedRun {
  directory: string;
  metadata: RunMetadata;
  result?: AgentResult;
}

export interface VerifyReport {
  runs: number;
  directNotes: number;
  compactArchives: number;
  imageGenerations: number;
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

export async function rebuildMemory(journal: RunJournal, projectRoot?: string): Promise<void> {
  await journal.withProjectionLock(() => rebuildMemoryUnlocked(journal, projectRoot));
  if (projectRoot) await runAfterMemoryRebuildHook(projectRoot);
}

async function runAfterMemoryRebuildHook(projectRoot: string): Promise<void> {
  if (!(await pathExists(path.join(projectRoot, CONFIG_FILE)))) return;
  const command = (await loadConfig(projectRoot)).hooks.after_memory_rebuild?.trim();
  if (!command) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: projectRoot,
      shell: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`after_memory_rebuild hook failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}: ${command}`));
    });
  });
}

/** Caller must hold the projection lock. */
export async function rebuildMemoryUnlocked(journal: RunJournal, projectRoot?: string): Promise<void> {
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
  const resolvedDirect = resolveDirectMemory(direct.notes);
  const projectionDirectNotes = direct.notes.filter((note) => note.status === "active" && !includedDirectIds.has(note.id));
  const currentDirectIds = new Set(resolvedDirect.currentNotes.filter((note) => !includedDirectIds.has(note.id)).map((note) => note.id));
  const directProjections = new Map(projectionDirectNotes.map((note) => [note.id, {
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
  const currentProjections = [
    ...managedProjections,
    ...[...directProjections.entries()].filter(([id]) => currentDirectIds.has(id)).map(([, record]) => record),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const stateLines = projections.slice(-10).map((record) =>
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
  const reconciledTasks = projectRoot
    ? await import("./sleep-memory.js").then(({ reconciledActiveTasks }) => reconciledActiveTasks(projectRoot, journal))
    : undefined;
  const links = [
    ...runs.map((run) => {
      const relative = path.relative(journal.memoryRoot, run.directory).split(path.sep).join("/");
      const target = run.result ? "summary" : "metadata";
      return {
        startedAt: run.metadata.startedAt,
        line: `- [[${relative}/${target}|${run.metadata.runId}]] · ${run.metadata.agent} · ${run.metadata.status}${run.metadata.taskId ? ` · ${run.metadata.taskId}` : ""}`,
      };
    }),
    ...projectionDirectNotes.map((note) => ({
      startedAt: note.timestamp,
      line: `- [[${note.relativePath}|${note.id}]] · direct · recorded · ${note.task}`,
    })),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-30).reverse().map((entry) => entry.line);

  const sweep = await latestSweepTimestamp(journal.memoryRoot);
  const provenance = `<!--\nGenerated at: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\nGenerated by: orchbun memory rebuild\nSource: ${projectionDirectNotes.length} active direct notes, ${await approvedManifestCount(journal.memoryRoot)} milestone manifests\nSweep: ${sweep ?? "none"}\n-->\n\n`;
  await Promise.all([
    writeFile(path.join(journal.memoryRoot, "working", "project-state.md"), `${provenance}${projectState}`),
    writeFile(
      path.join(journal.memoryRoot, "working", "active-tasks.md"),
      `${provenance}${reconciledTasks ?? `# Active tasks\n\n${[...baselineTasks, ...taskLines].join("\n") || "No task-linked memory records."}\n`}`,
    ),
    writeFile(path.join(journal.memoryRoot, "working", "decisions.md"), `${provenance}# Decisions\n\n${decisions.map((item) => `- ${item}`).join("\n") || "No decisions recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "contracts.md"), `${provenance}# Operational constraints\n\n${compact?.baseline.contracts.map((item) => `- ${item}`).join("\n") || "No operational constraints recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "working", "risks.md"), `${provenance}# Risks and blockers\n\n${risks.map((item) => `- ${item}`).join("\n") || "No risks recorded."}\n`),
    writeFile(path.join(journal.memoryRoot, "index.md"), `# Agent runs\n\n${links.join("\n") || "No runs recorded."}\n`),
  ]);
  if (projectRoot) {
    // Dynamic, like reconciledActiveTasks above: the projection reaches sleep-memory, which imports
    // this module for run loading.
    await import("./roadmap-projection.js").then(({ syncRoadmapProjection }) => syncRoadmapProjection(projectRoot, direct.notes));
  }
  await applyMemoryOverrides(journal.memoryRoot);
}

async function latestSweepTimestamp(root: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(path.join(root, "archive", "sweeps", "latest.json"), "utf8")) as { completedAt?: unknown };
    return typeof state.completedAt === "string" ? state.completedAt : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function approvedManifestCount(root: string): Promise<number> {
  const visit = async (directory: string): Promise<number> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    return entries.reduce(async (count, entry) => {
      const total = await count;
      if (entry.isFile() && entry.name === "approved.yaml") return total + 1;
      return entry.isDirectory() ? total + await visit(path.join(directory, entry.name)) : total;
    }, Promise.resolve(0));
  };
  return visit(path.join(root, "milestones"));
}

export async function verifyMemory(journal: RunJournal): Promise<VerifyReport> {
  const runs = await loadRuns(journal);
  const direct = await loadDirectMemory(journal.memoryRoot);
  const compact = await readCompactState(journal.memoryRoot);
  const imageJournal = new ImageGenerationJournal(journal.memoryRoot);
  const imageGenerations = await imageJournal.allRecords();
  let archives: Awaited<ReturnType<typeof loadCompactArchives>> = [];
  const issues: string[] = direct.issues.map((issue) => `direct: ${issue}`);
  const sleepIssues = await import("./sleep-memory.js").then(({ verifySleep }) => verifySleep(journal.memoryRoot));
  issues.push(...sleepIssues.map((issue) => `sleep: ${issue}`));
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
  const generationIds = new Set(imageGenerations.map(({ record }) => record.request.generationId));
  for (const { directory, record } of imageGenerations) {
    const label = `image ${path.basename(directory)}`;
    if (record.schemaVersion !== 1) issues.push(`${label}: unsupported schema version`);
    if (record.request.generationId !== record.result.generationId) issues.push(`${label}: request/result ID mismatch`);
    if (record.request.provider !== record.result.provider) issues.push(`${label}: request/result provider mismatch`);
    if (record.request.parentGenerationId && !generationIds.has(record.request.parentGenerationId)) {
      issues.push(`${label}: missing parent ${record.request.parentGenerationId}`);
    }
    if (record.result.status === "completed" && !record.result.completedAt) {
      issues.push(`${label}: completed generation has no completedAt timestamp`);
    }
    if (record.result.status === "completed" && !record.result.images.length) {
      issues.push(`${label}: completed generation has no images`);
    }
    if (record.result.externalGenerationId === null && ["processing", "completed"].includes(record.result.status)) {
      issues.push(`${label}: ${record.result.status} generation has no external ID`);
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
  return {
    runs: runs.length,
    directNotes: direct.notes.length,
    compactArchives: archives.length,
    imageGenerations: imageGenerations.length,
    issues,
  };
}

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, pathExists, type OrchbunConfig } from "./config.js";
import { assertValidDirectMemory, loadDirectMemory, resolveDirectMemory } from "./direct-memory.js";
import { ImageGenerationJournal } from "./image-generation/journal.js";
import { metadataFromYaml, RunJournal } from "./journal.js";
import { loadApprovedMilestoneManifest, loadCompactArchives, readCompactState, renderCompactProjectState } from "./milestone-memory.js";
import type { AgentResult, RunMetadata } from "./types.js";
import { contentHash } from "./utils.js";
import {
  DEFAULT_MEMORY_PAGE_CATALOGUE,
  memoryPageCatalogue,
  readCustomMemoryPages,
  readMemoryAnnotations,
  withMemoryAnnotation,
  type MemoryPageDefinition,
} from "./memory-overrides.js";
import { loadQualifications, loadWebSettings, parseRiskItems, readProjectMarkdown, type Qualification, type RiskItem, type WebSettings } from "./memory-workspace.js";
import { createRoadmapStore, RoadmapStoreError, type RoadmapSnapshot } from "./roadmap-store.js";

export interface RecordedRun {
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

export interface MemoryProjection {
  pages: Record<string, string>;
  annotations: Record<string, string>;
  pageDefinitions: MemoryPageDefinition[];
  index: string;
  roadmap: RoadmapSnapshot | null;
  settings: WebSettings;
  qualifications: Record<string, Qualification>;
  risks: RiskItem[];
  sections: MemorySemanticSections;
  sourceRevision: string;
  lastVerification: { recordedAt: string; source: string; checks: string[] } | null;
}

export interface MemorySemanticSections {
  projectState: string;
  activeTasks: string;
  decisions: string[];
  contracts: string[];
  risks: string[];
}

export interface BuildMemoryProjectionOptions {
  config?: OrchbunConfig;
  cacheWrites?: boolean;
  requireFreshRoadmap?: boolean;
  /** Validated candidate used by configure when a new internal file is not published yet. */
  roadmapSnapshot?: RoadmapSnapshot | null;
}

/** Read source records only; no initialization, hooks, roadmap writes, or publication. */
export async function buildMemoryProjection(
  journal: RunJournal,
  projectRoot?: string,
  options: BuildMemoryProjectionOptions = {},
): Promise<MemoryProjection> {
  let config = options.config ?? DEFAULT_CONFIG;
  const configuredProject = options.config !== undefined
    || Boolean(projectRoot && await pathExists(path.join(projectRoot, CONFIG_FILE)));
  if (!options.config && configuredProject && projectRoot) {
    try {
      config = await loadConfig(projectRoot);
    } catch (error) {
      // A few pre-configuration library callers construct an Orchestrator with
      // an explicit config and no published state. Once a snapshot exists,
      // invalid manual YAML must surface so the caller can retain that snapshot.
      if (await pathExists(path.join(journal.memoryRoot, "refresh", "state.json"))) throw error;
      config = DEFAULT_CONFIG;
    }
  }
  const pageDefinitions = memoryPageCatalogue(config);
  const [runs, direct, compact, builtInAnnotations, customPages, settings, qualifications] = await Promise.all([
    loadRuns(journal), loadDirectMemory(journal.memoryRoot), readCompactState(journal.memoryRoot),
    readMemoryAnnotations(journal.memoryRoot, DEFAULT_MEMORY_PAGE_CATALOGUE),
    readCustomMemoryPages(journal.memoryRoot, pageDefinitions),
    loadWebSettings(journal.memoryRoot), loadQualifications(journal.memoryRoot),
  ]);
  assertValidDirectMemory(direct);
  for (const run of runs) {
    if (run.metadata.startedAt === "invalid" || (["completed", "partial", "blocked"].includes(run.metadata.status) && !run.result)) {
      throw new Error(`Run ${run.metadata.runId} has invalid or incomplete source records`);
    }
  }
  let roadmap: RoadmapSnapshot | null = options.roadmapSnapshot ?? null;
  if (projectRoot && options.roadmapSnapshot === undefined) {
    try {
      roadmap = await createRoadmapStore({
        root: projectRoot,
        memoryRoot: journal.memoryRoot,
        config: config.roadmap,
        cacheWrites: options.cacheWrites ?? true,
      }).list({ allowStale: !(options.requireFreshRoadmap ?? false) });
      if (options.requireFreshRoadmap && roadmap.freshness !== "fresh") {
        throw new RoadmapStoreError("unavailable", "A fresh roadmap snapshot is required");
      }
    } catch (error) {
      if (!(options.requireFreshRoadmap ?? false)
        && !configuredProject
        && config.roadmap.provider === "internal"
        && error instanceof RoadmapStoreError
        && error.code === "unavailable") {
        roadmap = null;
      } else throw error;
    }
  }
  if (options.requireFreshRoadmap && roadmap?.freshness !== "fresh") {
    throw new RoadmapStoreError("unavailable", "A fresh roadmap snapshot is required");
  }
  let agents = "";
  if (projectRoot) {
    try { agents = await readProjectMarkdown(projectRoot, settings.agentsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const includedRunIds = new Set(compact?.includedManagedRunIds ?? []);
  const includedDirectIds = new Set(compact?.includedDirectNoteIds ?? []);
  const currentNotes = resolveDirectMemory(direct.notes).currentNotes.filter(note => !includedDirectIds.has(note.id));
  const currentRuns = runs.filter(run => !includedRunIds.has(run.metadata.runId));
  const records: ProjectionRecord[] = [
    ...currentRuns.map(run => ({
      startedAt: run.metadata.finishedAt ?? run.metadata.startedAt,
      stateLabel: `run ${run.metadata.runId}`,
      summary: run.result?.summary ?? `Run ${run.metadata.status}.`,
      taskId: run.metadata.taskId, outcome: run.result?.outcome ?? run.metadata.status,
      decisions: run.result?.decisions ?? [], risks: [...(run.result?.risks ?? []), ...(run.result?.blockers ?? [])],
      nextActions: run.result?.next_actions ?? [],
    })),
    ...currentNotes.map(note => ({
      startedAt: note.timestamp, stateLabel: `direct ${note.id}`, summary: note.outcome,
      taskId: note.task, outcome: note.workStatus ?? "recorded", decisions: note.decisions, risks: note.risks, nextActions: note.nextActions,
    })),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stateLabel.localeCompare(b.stateLabel));
  const unique = (values: string[]) => [...new Map(values.map(value => [value.trim().toLowerCase(), value.trim()])).values()];
  const annotationBullets = (markdown: string): string[] => markdown.split(/\r?\n/)
    .flatMap((line) => /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim() ?? []);
  const decisions = unique([...(compact?.baseline.decisions ?? []), ...records.flatMap(record => record.decisions)]);
  const riskText = unique([...(compact?.baseline.risks ?? []), ...records.flatMap(record => record.risks)]);
  const risks = [...new Map(parseRiskItems([...riskText.map(text => `- ${text}`), builtInAnnotations.risks].join("\n")).map(risk => [risk.id, risk])).values()];
  const riskList = (resolved: boolean) => risks.filter(risk => (qualifications[`risk:${risk.id}`]?.status === "resolved") === resolved)
    .map(risk => `- ${risk.text}${qualifications[`risk:${risk.id}`]?.priority && qualifications[`risk:${risk.id}`]!.priority !== "Unrated" ? ` (${qualifications[`risk:${risk.id}`]!.priority})` : ""}`).join("\n");
  let tasks: string;
  if (roadmap && projectRoot) {
    const { buildSleepSnapshotFromRoadmap, roadmapState } = await import("./sleep-memory.js");
    const sleep = await buildSleepSnapshotFromRoadmap(journal, roadmapState(roadmap));
    const lines = (items: typeof sleep.activeTasks, blocked: boolean) => items
      .filter(task => (qualifications[`task:${task.taskId}`]?.status === "blocked") === blocked)
      .map(task => {
        const q = qualifications[`task:${task.taskId}`];
        return `- **${task.taskId} · ${task.milestoneTitle}${q && q.priority !== "Unrated" ? ` · ${q.priority}` : ""}:** ${task.nextAction}${task.sourceId ? ` (source: ${task.sourceId})` : ""}`;
      }).join("\n");
    const blocked = lines([...sleep.activeTasks, ...sleep.scheduledTasks], true);
    const scheduled = lines(sleep.scheduledTasks, false);
    const staleNotice = roadmap.freshness === "stale"
      ? `> ${roadmap.source.label} is unavailable. This is a stale cached roadmap snapshot and is read only.\n\n`
      : "";
    tasks = `# Active tasks\n\n${staleNotice}${lines(sleep.activeTasks, false) || "No active roadmap tasks recorded."}\n${blocked ? `\n## Blocked\n\n${blocked}\n` : ""}${scheduled ? `\n## Scheduled\n\n${scheduled}\n` : ""}`;
  } else {
    const latest = new Map<string, ProjectionRecord>();
    for (const record of records) if (record.taskId) latest.set(record.taskId, record);
    tasks = `# Active tasks\n\n${[...(compact?.baseline.pendingWork ?? []), ...[...latest.values()].flatMap(record => record.nextActions.map(action => `${record.taskId}: ${action}`))].map(text => `- ${text}`).join("\n") || "No task-linked memory records."}\n`;
  }
  const verification = [
    ...runs.flatMap(run => run.result?.verification.length ? [{ recordedAt: run.metadata.finishedAt ?? run.metadata.startedAt, source: run.metadata.runId, checks: run.result.verification.map(v => `${v.check}: ${v.result}. ${v.evidence}`) }] : []),
    ...currentNotes.flatMap(note => note.verification.length ? [{ recordedAt: note.timestamp, source: note.id, checks: note.verification }] : []),
  ].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.source.localeCompare(b.source));
  const lastVerification = verification.at(-1) ?? null;
  const activity = records.slice(-10).reverse().map(record => `- **${record.startedAt.slice(0, 10)} · ${record.stateLabel} · ${record.outcome}:** ${record.summary}`).join("\n");
  const overview = roadmap ? `## Roadmap\n\n- Source: ${roadmap.source.label} (${roadmap.freshness}${roadmap.freshness === "stale" ? "; cached and read only" : ""}).\n- Current milestone: ${roadmap.activeMilestone ?? "All roadmap steps complete"}.\n- ${roadmap.tasks.filter(task => task.completed).length}/${roadmap.tasks.length} steps checked.\n- ${roadmap.tasks.filter(task => !task.completed && qualifications[`task:${task.id}`]?.status === "blocked").length} blocked tasks; ${risks.filter(risk => qualifications[`risk:${risk.id}`]?.status !== "resolved").length} open risks.\n\n` : "";
  const projectState = `${compact ? renderCompactProjectState(compact).trimEnd() : "# Project state"}\n\n${overview}## Recent recorded outcomes\n\n${activity || "No completed managed runs or direct notes."}\n${lastVerification ? `\n## Last recorded verification\n\n${lastVerification.recordedAt} · ${lastVerification.source}\n\n${lastVerification.checks.map(check => `- ${check}`).join("\n")}\n\nRefreshing memory does not rerun these checks.\n` : ""}`;
  const generated: Record<string, string> = {
    "project-state": projectState, "active-tasks": tasks,
    decisions: `# Decisions\n\n${decisions.map(item => `- ${item}`).join("\n") || "No decisions recorded."}\n`,
    contracts: `# Operational constraints\n\n${compact?.baseline.contracts.map(item => `- ${item}`).join("\n") || "No operational constraints recorded."}\n`,
    risks: `# Risks and blockers\n\n${riskList(false) || "No open risks recorded."}\n${riskList(true) ? `\n## Resolved\n\n${riskList(true)}\n` : ""}`,
  };
  const pages: Record<string, string> = {};
  const annotations: Record<string, string> = {};
  for (const page of pageDefinitions) {
    if (page.kind === "custom") {
      pages[page.id] = customPages[page.id] ?? `# ${page.title}\n`;
      annotations[page.id] = "";
      continue;
    }
    // Risk bullets are already rendered with their current resolution above. Original text stays editable.
    const stored = builtInAnnotations[page.id as keyof typeof builtInAnnotations] ?? "";
    const annotation = page.id === "risks" ? stored.split(/\r?\n/).filter(line => !/^\s*-\s+/.test(line)).join("\n") : stored;
    annotations[page.id] = stored;
    pages[page.id] = `<!-- Generated by: orchbun memory refresh; derived from recorded sources. -->\n\n${withMemoryAnnotation(generated[page.id] ?? `# ${page.title}\n`, annotation)}`;
  }
  const links = [
    ...runs.map(run => ({ at: run.metadata.startedAt, text: `- [[${path.relative(journal.memoryRoot, run.directory).split(path.sep).join("/")}/${run.result ? "summary" : "metadata"}|${run.metadata.runId}]] · ${run.metadata.status}` })),
    ...currentNotes.map(note => ({ at: note.timestamp, text: `- [[${note.relativePath}|${note.id}]] · direct · ${note.task}` })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.text.localeCompare(b.text)).slice(-30).reverse().map(link => link.text);
  return {
    pages, annotations, pageDefinitions, roadmap, settings, qualifications, risks, lastVerification,
    sections: {
      projectState,
      activeTasks: tasks,
      decisions: unique([...decisions, ...annotationBullets(builtInAnnotations.decisions ?? "")]),
      contracts: unique([...(compact?.baseline.contracts ?? []), ...annotationBullets(builtInAnnotations.contracts ?? "")]),
      risks: unique(risks.map((risk) => risk.text)),
    },
    index: `# Agent runs\n\n${links.join("\n") || "No runs recorded."}\n`,
    sourceRevision: contentHash(JSON.stringify({
      runs: runs.map(({ metadata, result }) => ({ metadata, result })), notes: direct.notes, compact,
      annotations: builtInAnnotations, customPages, pageDefinitions, settings, qualifications, roadmap, agents,
    })),
  };
}

/** Explicit maintenance only. Automatic refresh never writes roadmap sources or executes hooks. */
export async function rebuildMemoryUnlocked(journal: RunJournal, projectRoot?: string): Promise<void> {
  if (projectRoot) {
    const config = await pathExists(path.join(projectRoot, CONFIG_FILE))
      ? await loadConfig(projectRoot)
      : DEFAULT_CONFIG;
    const direct = await loadDirectMemory(journal.memoryRoot);
    assertValidDirectMemory(direct);
    if (config.roadmap.provider === "internal") {
      const { syncRoadmapProjection } = await import("./roadmap-projection.js");
      await syncRoadmapProjection(projectRoot, direct.notes, config.roadmap.path);
    }
  }
  const { refreshMemoryUnlocked } = await import("./memory-refresh.js");
  await refreshMemoryUnlocked(journal, projectRoot);
}

export async function verifyMemory(journal: RunJournal, projectRoot?: string): Promise<VerifyReport> {
  const runs = await loadRuns(journal);
  const direct = await loadDirectMemory(journal.memoryRoot);
  const compact = await readCompactState(journal.memoryRoot);
  const imageJournal = new ImageGenerationJournal(journal.memoryRoot);
  const imageGenerations = await imageJournal.allRecords();
  let archives: Awaited<ReturnType<typeof loadCompactArchives>> = [];
  const issues: string[] = direct.issues.map((issue) => `direct: ${issue}`);
  let currentRoadmap: RoadmapSnapshot | null = null;
  try {
    const { readRefreshedMemory, refreshMemory } = await import("./memory-refresh.js");
    const published = await readRefreshedMemory(journal.memoryRoot);
    if (projectRoot) {
      const preview = await refreshMemory(journal, projectRoot, false);
      currentRoadmap = preview.projection.roadmap;
      if (published && preview.revision !== published.revision) {
        issues.push("refresh: project sources changed since publication; run memory refresh");
      }
      if (currentRoadmap?.freshness === "stale") {
        issues.push("roadmap: the external provider is unavailable; only a stale cached snapshot can be read");
      }
    }
  } catch (error) { issues.push(`refresh: ${error instanceof Error ? error.message : String(error)}`); }
  const sleepModule = await import("./sleep-memory.js");
  const sleepIssues = await sleepModule.verifySleep(journal.memoryRoot);
  if (currentRoadmap) sleepIssues.push(...await sleepModule.verifySleepRoadmap(journal.memoryRoot, currentRoadmap));
  issues.push(...sleepIssues.map((issue) => `sleep: ${issue}`));
  if (projectRoot && await pathExists(path.join(projectRoot, CONFIG_FILE))) {
    try {
      const { MemoryService } = await import("./memory-service.js");
      const searchIssues = await (await MemoryService.open(projectRoot)).verifyIndex();
      issues.push(...searchIssues.map((issue) => `search: ${issue}`));
    } catch (error) {
      issues.push(`search: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
    for (const relative of ["approved-manifest.yaml", "publication.json"]) {
      try {
        await readFile(path.join(archive.directory, ...relative.split("/")), "utf8");
      } catch {
        issues.push(`compact ${archive.state.milestone}: archive is missing ${relative}`);
      }
    }
    try {
      await readdir(path.join(archive.directory, "working"));
    } catch {
      issues.push(`compact ${archive.state.milestone}: archive is missing working`);
    }
    const archivedPages = archive.state.archivedPages;
    if (archivedPages !== undefined) {
      const seenIds = new Set<string>();
      const seenFiles = new Set<string>();
      for (const page of archivedPages) {
        const valid = page && typeof page.id === "string" && typeof page.filename === "string"
          && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(page.id)
          && page.filename === `${page.id}.md`
          && !seenIds.has(page.id)
          && !seenFiles.has(page.filename);
        if (!valid) {
          issues.push(`compact ${archive.state.milestone}: archived page catalogue is invalid`);
          break;
        }
        seenIds.add(page.id);
        seenFiles.add(page.filename);
        try {
          await readFile(path.join(archive.directory, "working", page.filename), "utf8");
        } catch {
          issues.push(`compact ${archive.state.milestone}: archive is missing working/${page.filename}`);
        }
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

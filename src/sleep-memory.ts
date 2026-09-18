import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertValidDirectMemory, loadDirectMemory, resolveDirectMemory, type DirectMemoryNote } from "./direct-memory.js";
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, memoryRoot, pathExists } from "./config.js";
import type { RunJournal } from "./journal.js";
import { loadRuns } from "./memory.js";
import { readCompactState } from "./milestone-memory.js";
import { loadRoadmap, type RoadmapState, type RoadmapTask } from "./roadmap.js";
import { createRoadmapStore, type RoadmapSnapshot } from "./roadmap-store.js";
import { contentHash } from "./utils.js";

export interface SleepTask {
  taskId: string;
  title: string;
  milestone: string;
  milestoneTitle: string;
  status: "active" | "scheduled";
  nextAction: string;
  sourceId: string | null;
}

export interface ExcludedFollowup {
  sourceId: string;
  task: string;
  reason: "completed-roadmap-task" | "scheduled-roadmap-task" | "unlinked-followup";
}

export interface SleepSubject {
  key: string;
  currentHeadIds: string[];
  parallelHeads: boolean;
  lineages: Array<{ headId: string; noteIds: string[] }>;
}

export interface SleepSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  roadmap: {
    path: string;
    hash: string;
    activeMilestone: string | null;
    completedTaskIds: string[];
  };
  activeTasks: SleepTask[];
  scheduledTasks: SleepTask[];
  excludedFollowups: ExcludedFollowup[];
  subjects: SleepSubject[];
  sourceCounts: {
    managedRuns: number;
    directNotes: number;
    followups: number;
  };
}

export interface SleepReceipt {
  snapshot: SleepSnapshot;
  published: boolean;
  snapshotPath: string | null;
}

interface Followup {
  sourceId: string;
  startedAt: string;
  task: string;
  nextAction: string;
  primaryTaskIds: string[];
  referencedTaskIds: string[];
}

interface SleepState {
  schemaVersion: 1;
  snapshotId: string;
  roadmapPath: string;
}

const TASK_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

export async function sleepMemory(
  root: string,
  journal: RunJournal,
  options: { publish: boolean },
): Promise<SleepReceipt> {
  const snapshot = await buildConfiguredSleepSnapshot(root, journal, { allowStale: !options.publish, cacheWrites: false });
  if (!options.publish) return { snapshot, published: false, snapshotPath: null };

  return journal.withProjectionLock(async () => {
    const snapshot = await buildConfiguredSleepSnapshot(root, journal, { allowStale: false, cacheWrites: true });
    const sleepRoot = path.join(journal.memoryRoot, "sleep");
    const snapshots = path.join(sleepRoot, "snapshots");
    const snapshotPath = path.join(snapshots, `${snapshot.snapshotId}.json`);
    await mkdir(snapshots, { recursive: true });
    try {
      await readFile(snapshotPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
    }
    const state: SleepState = {
      schemaVersion: 1,
      snapshotId: snapshot.snapshotId,
      roadmapPath: snapshot.roadmap.path,
    };
    await writeFile(path.join(sleepRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    const { refreshMemoryUnlocked } = await import("./memory-refresh.js");
    await refreshMemoryUnlocked(journal, root);
    return {
      snapshot,
      published: true,
      snapshotPath: path.relative(journal.memoryRoot, snapshotPath).split(path.sep).join("/"),
    };
  });
}

export async function sleepIsEnabled(memoryRoot: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(path.join(memoryRoot, "sleep", "state.json"), "utf8")) as Partial<SleepState>;
    return state.schemaVersion === 1 && typeof state.snapshotId === "string" && state.snapshotId.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function verifySleep(memoryRoot: string): Promise<string[]> {
  let state: Partial<SleepState>;
  try {
    state = JSON.parse(await readFile(path.join(memoryRoot, "sleep", "state.json"), "utf8")) as Partial<SleepState>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [`state.json is invalid: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (state.schemaVersion !== 1) return ["state.json has an unsupported schema version"];
  if (!state.snapshotId || !/^[a-f0-9]{64}$/.test(state.snapshotId)) return ["state.json has an invalid snapshot ID"];

  try {
    const raw = await readFile(path.join(memoryRoot, "sleep", "snapshots", `${state.snapshotId}.json`), "utf8");
    const snapshot = JSON.parse(raw) as Partial<SleepSnapshot>;
    if (snapshot.schemaVersion !== 1) return [`snapshot ${state.snapshotId} has an unsupported schema version`];
    if (snapshot.snapshotId !== state.snapshotId) return [`snapshot ${state.snapshotId} has an ID mismatch`];
    const { snapshotId: _snapshotId, ...payload } = snapshot;
    if (contentHash(JSON.stringify(payload)) !== state.snapshotId) return [`snapshot ${state.snapshotId} content hash does not match`];
    return [];
  } catch (error) {
    return [`snapshot ${state.snapshotId} is invalid or missing: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** Reports a published Sleep snapshot whose roadmap source or revision is no longer active. */
export async function verifySleepRoadmap(memoryRoot: string, roadmap: RoadmapSnapshot): Promise<string[]> {
  let state: Partial<SleepState>;
  try {
    state = JSON.parse(await readFile(path.join(memoryRoot, "sleep", "state.json"), "utf8")) as Partial<SleepState>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  if (!state.snapshotId) return [];
  try {
    const snapshot = JSON.parse(await readFile(
      path.join(memoryRoot, "sleep", "snapshots", `${state.snapshotId}.json`),
      "utf8",
    )) as Partial<SleepSnapshot>;
    const active = roadmapState(roadmap);
    if (snapshot.roadmap?.path !== active.path || snapshot.roadmap.hash !== active.hash) {
      return ["the active roadmap changed since the current Sleep snapshot; run orchbun memory sleep"];
    }
  } catch {
    // Structural snapshot errors are reported by verifySleep.
  }
  return [];
}

export async function reconciledActiveTasks(root: string, journal: RunJournal): Promise<string | undefined> {
  if (!(await sleepIsEnabled(journal.memoryRoot))) return undefined;
  const snapshot = await buildConfiguredSleepSnapshot(root, journal, { allowStale: true, cacheWrites: false });
  return renderActiveTasks(snapshot.activeTasks, snapshot.scheduledTasks);
}

/** The active milestone leads; remaining open roadmap work follows so no known task is hidden. */
export function renderActiveTasks(tasks: SleepTask[], scheduled: SleepTask[] = []): string {
  const list = (items: SleepTask[]): string => items
    .map((task) => `- **${task.taskId} · ${task.milestoneTitle}:** ${task.nextAction}`)
    .join("\n");
  const active = list(tasks) || "No active roadmap tasks recorded.";
  return `# Active tasks\n\n${active}\n${scheduled.length ? `\n## Scheduled\n\n${list(scheduled)}\n` : ""}`;
}

export async function buildSleepSnapshot(root: string, journal: RunJournal, roadmapPath = "ROADMAP.md"): Promise<SleepSnapshot> {
  const roadmap = await loadRoadmap(root, roadmapPath);
  return buildSleepSnapshotFromRoadmap(journal, roadmap);
}

/** Builds the deterministic reconciliation from an already normalized roadmap snapshot. */
export async function buildSleepSnapshotFromRoadmap(journal: RunJournal, roadmap: RoadmapState): Promise<SleepSnapshot> {
  const followupResult = await loadFollowups(journal, roadmap);
  const byId = new Map(roadmap.tasks.map((task) => [task.id, task]));
  const latest = new Map<string, Followup>();
  const excludedFollowups: ExcludedFollowup[] = [];

  for (const followup of followupResult.followups) {
    const referenced = followup.referencedTaskIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
    if (!referenced.length) {
      excludedFollowups.push({ sourceId: followup.sourceId, task: followup.task, reason: "unlinked-followup" });
      continue;
    }
    for (const task of referenced) {
      if (task.completed) {
        excludedFollowups.push({ sourceId: followup.sourceId, task: followup.task, reason: "completed-roadmap-task" });
      } else if (task.milestone !== roadmap.activeMilestone) {
        excludedFollowups.push({ sourceId: followup.sourceId, task: followup.task, reason: "scheduled-roadmap-task" });
      }
      const prior = latest.get(task.id);
      if (!prior || preferFollowup(followup, prior, task.id)) latest.set(task.id, followup);
    }
  }

  const activeTasks = roadmap.tasks
    .filter((task) => !task.completed && task.milestone === roadmap.activeMilestone)
    .map((task) => sleepTask(task, "active", latest.get(task.id)));
  const scheduledTasks = roadmap.tasks
    .filter((task) => !task.completed && task.milestone !== roadmap.activeMilestone)
    .map((task) => sleepTask(task, "scheduled", latest.get(task.id)));
  const payload = {
    schemaVersion: 1 as const,
    roadmap: {
      path: roadmap.path,
      hash: roadmap.hash,
      activeMilestone: roadmap.activeMilestone,
      completedTaskIds: roadmap.tasks.filter((task) => task.completed).map((task) => task.id),
    },
    activeTasks,
    scheduledTasks,
    excludedFollowups: uniqueExcluded(excludedFollowups),
    subjects: followupResult.subjects,
    sourceCounts: followupResult.counts,
  };
  return {
    ...payload,
    snapshotId: contentHash(JSON.stringify(payload)),
  };
}

export async function buildConfiguredSleepSnapshot(
  root: string,
  journal: RunJournal,
  options: { allowStale: boolean; cacheWrites?: boolean },
): Promise<SleepSnapshot> {
  const config = await pathExists(path.join(root, CONFIG_FILE)) ? await loadConfig(root) : DEFAULT_CONFIG;
  const store = createRoadmapStore({
    root,
    memoryRoot: memoryRoot(root, config),
    config: config.roadmap,
    cacheWrites: options.cacheWrites ?? false,
  });
  const snapshot = await store.list({ allowStale: options.allowStale });
  if (!options.allowStale && snapshot.freshness === "stale") {
    throw new Error("A fresh roadmap is required to publish Sleep memory");
  }
  return buildSleepSnapshotFromRoadmap(journal, roadmapState(snapshot));
}

export function roadmapState(snapshot: RoadmapSnapshot): RoadmapState {
  return {
    path: snapshot.source.provider === "internal"
      ? snapshot.source.artifact
      : `external:${snapshot.source.identity}`,
    hash: snapshot.source.provider === "internal"
      ? snapshot.revision
      : contentHash(JSON.stringify({ source: snapshot.source.identity, revision: snapshot.revision })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    activeMilestone: snapshot.activeMilestone,
  };
}

function sleepTask(task: RoadmapTask, status: SleepTask["status"], followup?: Followup): SleepTask {
  return {
    taskId: task.id,
    title: task.title,
    milestone: task.milestone,
    milestoneTitle: task.milestoneTitle,
    status,
    nextAction: followup ? focusedAction(followup.nextAction, task.id) : task.title,
    sourceId: followup?.sourceId ?? null,
  };
}

async function loadFollowups(journal: RunJournal, roadmap: RoadmapState): Promise<{
  followups: Followup[];
  counts: SleepSnapshot["sourceCounts"];
  subjects: SleepSubject[];
}> {
  const [runs, direct, compact] = await Promise.all([
    loadRuns(journal),
    loadDirectMemory(journal.memoryRoot),
    readCompactState(journal.memoryRoot),
  ]);
  assertValidDirectMemory(direct);
  const includedRunIds = new Set(compact?.includedManagedRunIds ?? []);
  const includedDirectIds = new Set(compact?.includedDirectNoteIds ?? []);
  const resolvedDirect = resolveDirectMemory(direct.notes);
  const followups: Followup[] = [];

  for (const run of runs) {
    if (!run.result || includedRunIds.has(run.metadata.runId)) continue;
    for (const nextAction of meaningful(run.result.next_actions)) {
      const task = run.metadata.taskId ?? run.result.task_id ?? run.result.prompt_intent;
      followups.push({
        sourceId: run.metadata.runId,
        startedAt: run.metadata.startedAt,
        task,
        nextAction,
        primaryTaskIds: roadmapReferences(task, roadmap),
        referencedTaskIds: roadmapReferences(`${task}\n${nextAction}`, roadmap),
      });
    }
  }
  for (const note of resolvedDirect.currentNotes) {
    if (includedDirectIds.has(note.id)) continue;
    for (const nextAction of meaningful(note.nextActions)) {
      followups.push({
        sourceId: note.id,
        startedAt: note.timestamp,
        task: note.task,
        nextAction,
        primaryTaskIds: roadmapReferences(note.task, roadmap),
        referencedTaskIds: roadmapReferences(`${note.task}\n${nextAction}`, roadmap),
      });
    }
  }
  for (const pending of meaningful(compact?.baseline.pendingWork ?? [])) {
    followups.push({
      sourceId: `compact:${compact!.milestone}`,
      startedAt: compact!.publishedAt,
      task: pending,
      nextAction: pending,
      primaryTaskIds: roadmapReferences(pending, roadmap),
      referencedTaskIds: roadmapReferences(pending, roadmap),
    });
  }
  followups.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sourceId.localeCompare(b.sourceId));
  return {
    followups,
    counts: {
      managedRuns: runs.length,
      directNotes: direct.notes.length,
      followups: followups.length,
    },
    subjects: buildSubjects(direct.notes, includedDirectIds, roadmap),
  };
}

function buildSubjects(notes: DirectMemoryNote[], includedIds: Set<string>, roadmap: RoadmapState): SleepSubject[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const resolved = resolveDirectMemory(notes);
  const grouped = new Map<string, Array<{ headId: string; noteIds: string[]; startedAt: string }>>();
  for (const head of resolved.currentNotes) {
    if (includedIds.has(head.id)) continue;
    const noteIds = resolved.lineages.get(head.id) ?? [head.id];
    const keys = new Set<string>();
    for (const id of noteIds) {
      const note = byId.get(id);
      if (!note) continue;
      for (const subject of note.subjects) keys.add(subject);
      const searchable = [note.task, note.outcome, ...note.decisions, ...note.risks, ...note.nextActions, ...note.changedFiles].join("\n");
      for (const taskId of roadmapReferences(searchable, roadmap)) keys.add(taskId);
    }
    if (!keys.size) keys.add("unclassified");
    for (const key of keys) {
      const entries = grouped.get(key) ?? [];
      entries.push({ headId: head.id, noteIds, startedAt: head.timestamp });
      grouped.set(key, entries);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
    entries.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.headId.localeCompare(right.headId));
    return {
      key,
      currentHeadIds: entries.map((entry) => entry.headId),
      parallelHeads: entries.length > 1,
      lineages: entries.map(({ headId, noteIds }) => ({ headId, noteIds })),
    };
  });
}

/** Stable task-id resolution shared by Sleep and the roadmap projection. */
export function roadmapReferences(text: string, roadmap: RoadmapState): string[] {
  const exact = new Set(text.match(TASK_ID) ?? []);
  const output: string[] = [];
  for (const task of roadmap.tasks) {
    const alias = task.id.split("-").slice(1).join("-");
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (exact.has(task.id) || new RegExp(`\\b${escapedAlias}\\b`, "i").test(text)) output.push(task.id);
  }
  return output;
}

function meaningful(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value && !["none", "n/a", "not applicable"].includes(value.toLowerCase()));
}

function focusedAction(action: string, taskId: string): string {
  const alias = taskId.split("-").slice(1).join("-");
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matching = action.split(/(?<=[.!?])\s+/).find((sentence) =>
    sentence.includes(taskId) || new RegExp(`\\b${escapedAlias}\\b`, "i").test(sentence),
  );
  return matching?.trim() || action;
}

function preferFollowup(candidate: Followup, current: Followup, taskId: string): boolean {
  const candidatePrimary = candidate.primaryTaskIds.includes(taskId);
  const currentPrimary = current.primaryTaskIds.includes(taskId);
  if (candidatePrimary !== currentPrimary) return candidatePrimary;
  if (candidate.referencedTaskIds.length !== current.referencedTaskIds.length) {
    return candidate.referencedTaskIds.length < current.referencedTaskIds.length;
  }
  return candidate.startedAt > current.startedAt;
}

function uniqueExcluded(items: ExcludedFollowup[]): ExcludedFollowup[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceId}\0${item.task}\0${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

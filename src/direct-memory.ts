import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const DIRECT_MEMORY_PROTOCOL = `# Direct agent memory

This directory stores compact memory notes from agents prompted outside Orchbun.

- Create one immutable Markdown note per task under \`YYYY/MM/\`.
- Name notes \`<UTC timestamp>-<task-slug>.md\`, for example \`20260810T143000Z-review-auth-flow.md\`.
- Record \`Agent\`, \`Recorded at\`, task, outcome, decisions, risks or blockers, next actions, changed files, verification, and \`Status\`.
- \`Recorded at\` must match the UTC timestamp in the filename. \`Status\` is \`active\` unless explicitly set to \`retired\` or \`superseded\`; retired notes also need a \`Reason\`.
- Optionally add \`Supersedes\` with one or more earlier note IDs to retire their current decisions, risks, and next actions without deleting history.
- Optionally add \`Subjects\` with stable keys such as \`memory/sleep\` to support deterministic, non-semantic grouping.
- Keep notes factual and compact. Do not place raw transcripts or secrets here.
- Orchbun validates these notes and merges them into generated working memory.
`;

export interface DirectMemoryNote {
  id: string;
  slug: string;
  relativePath: string;
  timestamp: string;
  task: string;
  outcome: string;
  decisions: string[];
  risks: string[];
  nextActions: string[];
  changedFiles: string[];
  verification: string[];
  supersedes: string[];
  subjects: string[];
  agent?: string;
  recordedAt?: string;
  status: "active" | "retired" | "superseded";
  reason?: string;
}

export interface DirectMemoryLoadResult {
  notes: DirectMemoryNote[];
  issues: string[];
}

type FieldName = "agent" | "recordedAt" | "task" | "outcome" | "decisions" | "risks" | "nextActions" | "changedFiles" | "verification" | "status" | "reason" | "supersedes" | "subjects";

const FIELD_NAMES: Record<string, FieldName> = {
  agent: "agent",
  "recorded at": "recordedAt",
  task: "task",
  outcome: "outcome",
  decisions: "decisions",
  "risks or blockers": "risks",
  "next actions": "nextActions",
  "changed files": "changedFiles",
  verification: "verification",
  status: "status",
  reason: "reason",
  supersedes: "supersedes",
  subjects: "subjects",
};
const REQUIRED_LABELS = ["task", "outcome", "decisions", "risks or blockers", "next actions", "changed files", "verification"];
const NOTE_FILE = /^(\d{8}T\d{6}Z)-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.md$/;

export async function loadDirectMemory(memoryRoot: string): Promise<DirectMemoryLoadResult> {
  const root = path.join(memoryRoot, "direct");
  const files = await markdownFiles(root);
  const notes: DirectMemoryNote[] = [];
  const issues: string[] = [];

  for (const absolute of files) {
    const relativePath = path.relative(memoryRoot, absolute).split(path.sep).join("/");
    const directRelative = path.relative(root, absolute).split(path.sep).join("/");
    if (directRelative === "README.md") continue;
    const parts = directRelative.split("/");
    const fileName = parts.at(-1) ?? "";
    const match = NOTE_FILE.exec(fileName);
    if (parts.length !== 3 || !match || parts[0] !== match[1]?.slice(0, 4) || parts[1] !== match[1]?.slice(4, 6)) {
      issues.push(`${relativePath}: expected direct/YYYY/MM/<UTC timestamp>-<task-slug>.md`);
      continue;
    }
    const compactTimestamp = match[1]!;
    const timestamp = isoTimestamp(compactTimestamp);
    if (!timestamp) {
      issues.push(`${relativePath}: invalid UTC timestamp ${compactTimestamp}`);
      continue;
    }
    const parsed = parseFields(await readFile(absolute, "utf8"));
    const missing = REQUIRED_LABELS.filter((label) => !parsed.present.has(label));
    if (missing.length) issues.push(`${relativePath}: missing fields ${missing.join(", ")}`);
    if (!parsed.values.task[0]?.trim()) issues.push(`${relativePath}: Task must not be empty`);
    if (!parsed.values.outcome[0]?.trim()) issues.push(`${relativePath}: Outcome must not be empty`);
    if (missing.length || !parsed.values.task[0]?.trim() || !parsed.values.outcome[0]?.trim()) continue;

    const hasLifecycleFields = ["agent", "recorded at", "status", "reason"].some((label) => parsed.present.has(label));
    const agent = parsed.values.agent[0]?.trim();
    const recordedAt = parsed.values.recordedAt[0]?.trim();
    const rawStatus = parsed.values.status[0]?.trim().toLowerCase();
    const status = rawStatus || "active";
    if (hasLifecycleFields && !agent) issues.push(`${relativePath}: Agent must not be empty when lifecycle fields are used`);
    if (hasLifecycleFields && !recordedAt) issues.push(`${relativePath}: Recorded at is required when lifecycle fields are used`);
    if (recordedAt && recordedAt !== timestamp) issues.push(`${relativePath}: Recorded at must match filename timestamp ${timestamp}`);
    if (!["active", "retired", "superseded"].includes(status)) issues.push(`${relativePath}: Status must be active, retired, or superseded`);
    const reason = parsed.values.reason[0]?.trim();
    if (status === "retired" && !reason) issues.push(`${relativePath}: Reason is required when Status is retired`);
    if (missing.length || !parsed.values.task[0]?.trim() || !parsed.values.outcome[0]?.trim() || (hasLifecycleFields && (!agent || !recordedAt)) || (recordedAt && recordedAt !== timestamp) || !["active", "retired", "superseded"].includes(status) || (status === "retired" && !reason)) continue;

    notes.push({
      id: fileName.slice(0, -3),
      slug: match[2]!,
      relativePath,
      timestamp,
      task: parsed.values.task[0]!.trim(),
      outcome: parsed.values.outcome[0]!.trim(),
      decisions: meaningful(parsed.values.decisions),
      risks: meaningful(parsed.values.risks),
      nextActions: meaningful(parsed.values.nextActions),
      changedFiles: meaningful(parsed.values.changedFiles),
      verification: meaningful(parsed.values.verification),
      supersedes: meaningful(parsed.values.supersedes),
      subjects: meaningful(parsed.values.subjects),
      ...(agent ? { agent } : {}),
      ...(recordedAt ? { recordedAt } : {}),
      status: status as DirectMemoryNote["status"],
      ...(reason ? { reason } : {}),
    });
  }

  notes.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  // A sweep moves superseded notes to archive/direct while leaving the
  // successor active. Archived IDs are still valid historical supersession
  // targets; otherwise a successful sweep makes the next rebuild fail.
  const ids = new Set([...notes.map((note) => note.id), ...await archivedDirectNoteIds(memoryRoot)]);
  const notesById = new Map(notes.map((note) => [note.id, note]));
  for (const note of notes) {
    for (const subject of note.subjects) {
      if (!/^[a-z0-9][a-z0-9/_-]*$/.test(subject)) issues.push(`${note.relativePath}: invalid subject ${subject}`);
    }
    for (const target of note.supersedes) {
      if (target === note.id) issues.push(`${note.relativePath}: a note cannot supersede itself`);
      else if (!ids.has(target)) issues.push(`${note.relativePath}: unknown superseded note ${target}`);
      else {
        const targetNote = notesById.get(target);
        if (targetNote && targetNote.timestamp >= note.timestamp) issues.push(`${note.relativePath}: superseded note ${target} must be older`);
      }
    }
  }
  issues.push(...supersessionCycleIssues(notes));
  return { notes, issues };
}

export interface DirectMemoryResolution {
  currentNotes: DirectMemoryNote[];
  supersededNoteIds: Set<string>;
  inactiveNoteIds: Set<string>;
  lineages: Map<string, string[]>;
}

/** Resolves immutable lifecycle records once for rebuild, Sleep, and sweep. */
export function resolveDirectMemory(notes: DirectMemoryNote[]): DirectMemoryResolution {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const supersededNoteIds = new Set<string>();
  const collect = (id: string): void => {
    if (supersededNoteIds.has(id)) return;
    supersededNoteIds.add(id);
    for (const target of byId.get(id)?.supersedes ?? []) collect(target);
  };
  for (const note of notes) {
    if (note.status === "superseded") collect(note.id);
    for (const target of note.supersedes) collect(target);
  }
  const inactiveNoteIds = new Set(notes.filter((note) => note.status !== "active" || supersededNoteIds.has(note.id)).map((note) => note.id));
  const currentNotes = notes.filter((note) => !inactiveNoteIds.has(note.id));
  const lineages = new Map(currentNotes.map((note) => [note.id, lineage(note.id, byId)]));
  return { currentNotes, supersededNoteIds, inactiveNoteIds, lineages };
}

function lineage(headId: string, byId: Map<string, DirectMemoryNote>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    output.push(id);
    for (const target of byId.get(id)?.supersedes ?? []) visit(target);
  };
  visit(headId);
  return output;
}

function supersessionCycleIssues(notes: DirectMemoryNote[]): string[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const issues = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) {
      issues.add(`supersession cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const target of byId.get(id)?.supersedes ?? []) if (byId.has(target)) visit(target);
    active.delete(id);
    visited.add(id);
  };
  for (const note of notes) visit(note.id);
  return [...issues].sort();
}

async function archivedDirectNoteIds(memoryRoot: string): Promise<string[]> {
  const files = await markdownFiles(path.join(memoryRoot, "archive", "direct"));
  return files.flatMap((file) => {
    const match = NOTE_FILE.exec(path.basename(file));
    return match ? [path.basename(file, ".md")] : [];
  });
}

export function assertValidDirectMemory(result: DirectMemoryLoadResult): void {
  if (result.issues.length) {
    throw new Error(`Direct memory validation failed:\n${result.issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(absolute);
    }
  };
  await visit(root);
  return output.sort();
}

function parseFields(text: string): { values: Record<FieldName, string[]>; present: Set<string> } {
  const values: Record<FieldName, string[]> = {
    agent: [], recordedAt: [], task: [], outcome: [], decisions: [], risks: [], nextActions: [], changedFiles: [], verification: [], status: [], reason: [], supersedes: [], subjects: [],
  };
  const present = new Set<string>();
  let current: FieldName | undefined;

  for (const line of text.split(/\r?\n/)) {
    const field = /^-\s+\*\*([^:]+):\*\*\s*(.*)$/.exec(line);
    if (field) {
      const label = field[1]!.trim().toLowerCase();
      current = FIELD_NAMES[label];
      if (!current) continue;
      present.add(label);
      if (field[2]!.trim()) values[current].push(field[2]!.trim());
      continue;
    }
    const nested = /^\s{2,}-\s+(.+)$/.exec(line);
    if (current && nested) values[current].push(nested[1]!.trim());
  }
  return { values, present };
}

function meaningful(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value && !["none", "n/a", "not applicable"].includes(value.toLowerCase()));
}

function isoTimestamp(compact: string): string | undefined {
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const roundTrip = parsed.toISOString().replace(/[-:]/g, "").replace(".000", "");
  return roundTrip === compact ? iso : undefined;
}

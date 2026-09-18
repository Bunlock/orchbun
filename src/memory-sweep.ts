import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { loadDirectMemory, resolveDirectMemory, type DirectMemoryNote } from "./direct-memory.js";
import { loadRuns, rebuildMemoryUnlocked, verifyMemory } from "./memory.js";
import { memoryPageCatalogue, type MemoryPageDefinition } from "./memory-pages.js";
import { loadApprovedMilestoneManifest, readCompactState } from "./milestone-memory.js";
import type { RunJournal } from "./journal.js";

export interface MemorySweepOptions {
  dryRun?: boolean;
  now?: Date;
  executor?: string;
  projectRoot?: string;
}

export interface MemorySweepReceipt {
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  milestoneBaseline: string | null;
  notes: { keptActive: number; archived: string[]; retirementCandidates: string[] };
  runsArchived: string[];
  workingLines: { before: Record<string, number>; after: Record<string, number> };
  snapshotPath: string | null;
  reportPath: string | null;
  report: string;
  verification: { passed: boolean; issues: string[] };
}

/** Applies only explicit lifecycle markers; candidates remain active until a human records a retirement reason. */
export async function sweepMemory(journal: RunJournal, options: MemorySweepOptions = {}): Promise<MemorySweepReceipt> {
  const now = options.now ?? new Date();
  const startedAt = isoSecond(now);
  const dryRun = options.dryRun ?? false;
  const executor = options.executor ?? "orchbun memory sweep";
  const config = options.projectRoot ? await loadConfig(options.projectRoot) : DEFAULT_CONFIG;
  const pageDefinitions = memoryPageCatalogue(config);
  await journal.initialize(pageDefinitions);

  return journal.withProjectionLock(async () => {
    const direct = await loadDirectMemory(journal.memoryRoot);
    if (direct.issues.length) throw new Error(`Direct memory validation failed:\n${direct.issues.map((issue) => `- ${issue}`).join("\n")}`);
    const baseline = await latestAcceptedBaseline(journal.memoryRoot);
    const superseded = resolveDirectMemory(direct.notes).supersededNoteIds;
    const archiveNotes = direct.notes.filter((note) => note.status !== "active" || superseded.has(note.id));
    const retirementCandidates = baseline
      ? direct.notes.filter((note) => note.status === "active" && !superseded.has(note.id) && note.timestamp <= baseline.acceptedAt).map((note) => note.id)
      : [];
    const runs = await loadRuns(journal);
    const archiveRuns = baseline
      ? runs.filter((run) => eligibleRun(run.metadata.startedAt, run.metadata.status, baseline.acceptedAt, now)).map((run) => run.directory)
      : [];
    const before = await workingLineCounts(journal.memoryRoot, pageDefinitions);
    const compactId = compactTimestamp(now);
    const snapshotRelative = `archive/sweeps/${compactId.slice(0, 4)}/${compactId.slice(4, 6)}/${compactId}`;
    const snapshot = path.join(journal.memoryRoot, ...snapshotRelative.split("/"));

    if (!dryRun) {
      await mkdir(path.dirname(snapshot), { recursive: true });
      await mkdir(snapshot, { recursive: false });
      await cp(path.join(journal.memoryRoot, "working"), snapshot, { recursive: true });
      for (const note of archiveNotes) await archiveDirectNote(journal.memoryRoot, note);
      for (const directory of archiveRuns) await archiveRun(journal.memoryRoot, directory);
      await writeFile(path.join(journal.memoryRoot, "archive", "sweeps", "latest.json"), `${JSON.stringify({ completedAt: startedAt, snapshotPath: snapshotRelative }, null, 2)}\n`);
      await rebuildMemoryUnlocked(journal, options.projectRoot);
    }

    const after = dryRun ? before : await workingLineCounts(journal.memoryRoot, pageDefinitions);
    const verificationReport = await verifyMemory(journal, options.projectRoot);
    const completedAt = isoSecond(new Date());
    const receipt: MemorySweepReceipt = {
      dryRun,
      startedAt,
      completedAt,
      milestoneBaseline: baseline ? `${baseline.milestone} @ ${baseline.acceptedAt}` : null,
      notes: {
        keptActive: direct.notes.length - archiveNotes.length,
        archived: archiveNotes.map((note) => note.id),
        retirementCandidates,
      },
      runsArchived: archiveRuns.map((directory) => path.basename(directory)),
      workingLines: { before, after },
      snapshotPath: dryRun ? null : snapshotRelative,
      reportPath: null,
      report: "",
      verification: { passed: verificationReport.issues.length === 0, issues: verificationReport.issues },
    };
    receipt.report = renderSweepReport(receipt, executor);

    if (!dryRun) {
      const reportPath = await writeSweepReport(journal.memoryRoot, receipt, executor);
      receipt.reportPath = reportPath;
      await rebuildMemoryUnlocked(journal, options.projectRoot);
      const finalReport = await verifyMemory(journal, options.projectRoot);
      receipt.verification = { passed: finalReport.issues.length === 0, issues: finalReport.issues };
      receipt.report = renderSweepReport(receipt, executor);
    }
    return receipt;
  });
}

async function latestAcceptedBaseline(memoryRoot: string): Promise<{ milestone: string; acceptedAt: string } | undefined> {
  const compact = await readCompactState(memoryRoot);
  const manifestRoot = path.join(memoryRoot, "milestones");
  const manifests = await filesNamed(manifestRoot, "approved.yaml");
  const accepted = await Promise.all(manifests.map(async (file) => {
    try {
      const { manifest } = await loadApprovedMilestoneManifest(file);
      return { milestone: manifest.milestone, acceptedAt: manifest.review.accepted_at };
    } catch {
      return undefined;
    }
  }));
  const current = compact ? [{ milestone: compact.milestone, acceptedAt: compact.publishedAt }] : [];
  return [...accepted.filter((item): item is { milestone: string; acceptedAt: string } => Boolean(item)), ...current]
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.milestone.localeCompare(a.milestone))[0];
}

function eligibleRun(startedAt: string, status: string, baseline: string, now: Date): boolean {
  if (startedAt >= baseline) return false;
  if (status !== "failed") return true;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && timestamp < now.getTime() - 90 * 24 * 60 * 60 * 1000;
}

async function archiveDirectNote(memoryRoot: string, note: DirectMemoryNote): Promise<void> {
  const source = path.join(memoryRoot, ...note.relativePath.split("/"));
  const destination = path.join(memoryRoot, "archive", "direct", note.relativePath.slice("direct/".length));
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
}

async function archiveRun(memoryRoot: string, directory: string): Promise<void> {
  const relative = path.relative(path.join(memoryRoot, "runs"), directory);
  const destination = path.join(memoryRoot, "archive", "runs", relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(directory, destination);
}

async function workingLineCounts(
  memoryRoot: string,
  pageDefinitions: readonly MemoryPageDefinition[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(pageDefinitions.map(async (page) => [
    page.filename,
    await lineCount(path.join(memoryRoot, "working", page.filename)),
  ] as const));
  return Object.fromEntries(entries);
}

async function lineCount(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeSweepReport(memoryRoot: string, receipt: MemorySweepReceipt, executor: string): Promise<string> {
  const stamp = compactTimestamp(new Date(receipt.completedAt));
  const relative = `direct/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp}-memory-delta-sweep.md`;
  const file = path.join(memoryRoot, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderSweepReport(receipt, executor));
  return relative;
}

function renderSweepReport(receipt: MemorySweepReceipt, executor: string): string {
  const notes = receipt.notes;
  const lines = Object.keys(receipt.workingLines.before).map((file) => `${file}: ${receipt.workingLines.before[file]} → ${receipt.workingLines.after[file]}`);
  return `# Memory delta sweep

- **Agent:** ${executor}
- **Recorded at:** ${receipt.completedAt}
- **Task:** Periodic memory housekeeping sweep.
- **Outcome:** ${receipt.dryRun ? "Dry-run classified memory without modifying files." : `Archived ${notes.archived.length} direct note(s) and ${receipt.runsArchived.length} managed run(s); rebuilt projections.`}
- **Decisions:** Only explicit retired/superseded lifecycle markers are archived automatically; pre-baseline active notes are reported as retirement candidates for human review.
- **Risks or blockers:** ${notes.retirementCandidates.length ? `${notes.retirementCandidates.length} active note(s) predate the milestone baseline and need an explicit retirement decision.` : "None"}
- **Next actions:** ${notes.retirementCandidates.length ? `Review retirement candidates: ${notes.retirementCandidates.join(", ")}.` : "None"}
- **Changed files:** ${receipt.dryRun ? "None" : `${receipt.snapshotPath}; ${receipt.reportPath ?? "this sweep report"}; working projections.`}
- **Verification:** ${receipt.verification.passed ? "pnpm orchbun memory verify passed." : receipt.verification.issues.join("; ")}
- **Status:** active
- **Started at:** ${receipt.startedAt}
- **Completed at:** ${receipt.completedAt}
- **Trigger:** ${receipt.dryRun ? "manual (dry-run)" : "manual"}
- **Milestone baseline:** ${receipt.milestoneBaseline ?? "none"}

## Classification

- Kept active: ${notes.keptActive}
- Archived or superseded: ${notes.archived.length}${notes.archived.length ? ` (${notes.archived.join(", ")})` : ""}
- Retirement candidates: ${notes.retirementCandidates.length}${notes.retirementCandidates.length ? ` (${notes.retirementCandidates.join(", ")})` : ""}
- Runs archived: ${receipt.runsArchived.length}${receipt.runsArchived.length ? ` (${receipt.runsArchived.join(", ")})` : ""}

## Working-file lines

${lines.map((line) => `- ${line}`).join("\n")}
`;
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function isoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function filesNamed(root: string, name: string): Promise<string[]> {
  const result: string[] = [];
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
      else if (entry.isFile() && entry.name === name) result.push(absolute);
    }
  };
  await visit(root);
  return result;
}

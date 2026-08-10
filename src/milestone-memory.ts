import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import AjvModule from "ajv/dist/2020.js";
import type { Options, ValidateFunction } from "ajv";
import { loadDirectMemory, assertValidDirectMemory } from "./direct-memory.js";
import type { RunJournal } from "./journal.js";
import { contentHash } from "./utils.js";

export interface MilestoneArtifact {
  path: string;
  description: string;
}

export interface ApprovedMilestoneManifest {
  schema_version: "1.0";
  milestone: string;
  scope: "shared";
  review: {
    decision: "accepted";
    accepted_at: string;
    accepted_by: string;
  };
  summary: string;
  validated_outcomes: string[];
  decisions: string[];
  contracts: string[];
  risks: string[];
  pending_work: string[];
  artifacts: MilestoneArtifact[];
  supersedes: string[];
}

export interface CompactState {
  schemaVersion: 1;
  milestone: string;
  scope: "shared";
  publishedAt: string;
  manifestPath: string;
  manifestHash: string;
  archivePath: string;
  includedManagedRunIds: string[];
  includedDirectNoteIds: string[];
  baseline: {
    summary: string;
    validatedOutcomes: string[];
    decisions: string[];
    contracts: string[];
    risks: string[];
    pendingWork: string[];
    artifacts: MilestoneArtifact[];
  };
}

export interface CompactReceipt {
  milestone: string;
  scope: "shared";
  publishedAt: string;
  workingPath: string;
  archivePath: string;
  manifestHash: string;
}

export interface CompactAllReceipt {
  requested: number;
  compacted: CompactReceipt[];
  skipped: number;
}

export interface CompactArchive {
  directory: string;
  relativePath: string;
  state: CompactState;
}

const MILESTONE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
let manifestValidator: ValidateFunction<ApprovedMilestoneManifest> | undefined;

const Ajv = AjvModule as unknown as new (options?: Options) => {
  compile<T>(schema: object): ValidateFunction<T>;
};

export async function loadApprovedMilestoneManifest(file: string): Promise<{ manifest: ApprovedMilestoneManifest; raw: string }> {
  const raw = await readFile(file, "utf8");
  const value = YAML.parse(raw) as unknown;
  if (!manifestValidator) {
    const schemaFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas/milestone-manifest.schema.json");
    const schema = JSON.parse(await readFile(schemaFile, "utf8")) as object;
    manifestValidator = new Ajv({ allErrors: true, strict: false }).compile<ApprovedMilestoneManifest>(schema);
  }
  if (!manifestValidator(value)) {
    const details = manifestValidator.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`Milestone manifest failed schema validation: ${details}`);
  }
  if (!MILESTONE.test(value.milestone)) throw new Error(`Invalid milestone name ${value.milestone}`);
  if (Number.isNaN(Date.parse(value.review.accepted_at))) {
    throw new Error("Milestone manifest review.accepted_at must be an ISO timestamp");
  }
  return { manifest: value, raw };
}

export async function readCompactState(memoryRoot: string): Promise<CompactState | undefined> {
  try {
    return JSON.parse(await readFile(path.join(memoryRoot, "working", "compact-state.json"), "utf8")) as CompactState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadCompactArchives(memoryRoot: string): Promise<CompactArchive[]> {
  const archiveRoot = path.join(memoryRoot, "archive");
  const archives: CompactArchive[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "publication.json")) {
      archives.push({
        directory,
        relativePath: path.relative(memoryRoot, directory).split(path.sep).join("/"),
        state: JSON.parse(await readFile(path.join(directory, "publication.json"), "utf8")) as CompactState,
      });
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) await visit(path.join(directory, entry.name));
  };
  await visit(archiveRoot);
  return archives.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function compactMemory(
  journal: RunJournal,
  manifestFile: string,
  expectedMilestone: string,
  scope: string,
  now = new Date(),
): Promise<CompactReceipt> {
  if (scope !== "shared") throw new Error("Only scope=shared is supported");
  if (!MILESTONE.test(expectedMilestone)) throw new Error(`Invalid milestone name ${expectedMilestone}`);
  const { manifest, raw } = await loadApprovedMilestoneManifest(manifestFile);
  if (manifest.milestone !== expectedMilestone) {
    throw new Error(`Manifest milestone ${manifest.milestone} does not match ${expectedMilestone}`);
  }
  if (manifest.scope !== scope) throw new Error(`Manifest scope ${manifest.scope} does not match ${scope}`);

  return journal.withProjectionLock(async () => {
    const prior = await readCompactState(journal.memoryRoot);
    const direct = await loadDirectMemory(journal.memoryRoot);
    assertValidDirectMemory(direct);
    const includedManagedRunIds = (await journal.allRunDirectories()).map((directory) => path.basename(directory));
    const includedDirectNoteIds = direct.notes.map((note) => note.id);
    const superseded = new Set(manifest.supersedes.map(normalize));
    const unique = (items: string[]): string[] => [
      ...new Map(items.filter((item) => !superseded.has(normalize(item))).map((item) => [normalize(item), item.trim()])).values(),
    ];
    const carried = prior?.baseline ?? {
      decisions: await readBullets(path.join(journal.memoryRoot, "working", "decisions.md")),
      contracts: await readBullets(path.join(journal.memoryRoot, "working", "contracts.md")),
      risks: await readBullets(path.join(journal.memoryRoot, "working", "risks.md")),
    };
    const publishedAt = now.toISOString();
    const compactId = publishedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const archiveRelative = `archive/${compactId.slice(0, 4)}/${compactId.slice(4, 6)}/${compactId}-${manifest.milestone}`;
    const manifestRelative = relativeOrAbsolute(journal.memoryRoot, manifestFile);
    const state: CompactState = {
      schemaVersion: 1,
      milestone: manifest.milestone,
      scope: manifest.scope,
      publishedAt,
      manifestPath: manifestRelative,
      manifestHash: contentHash(raw),
      archivePath: archiveRelative,
      includedManagedRunIds,
      includedDirectNoteIds,
      baseline: {
        summary: manifest.summary,
        validatedOutcomes: unique([...(prior?.baseline.validatedOutcomes ?? []), ...manifest.validated_outcomes]),
        decisions: unique([...(carried.decisions ?? []), ...manifest.decisions]),
        contracts: unique([...(carried.contracts ?? []), ...manifest.contracts]),
        risks: unique([...(carried.risks ?? []), ...manifest.risks]),
        pendingWork: unique(manifest.pending_work),
        artifacts: uniqueArtifacts([...(prior?.baseline.artifacts ?? []), ...manifest.artifacts]),
      },
    };

    const working = path.join(journal.memoryRoot, "working");
    const staged = path.join(journal.memoryRoot, `.working-${compactId}-${process.pid}.staged`);
    const archive = path.join(journal.memoryRoot, ...archiveRelative.split("/"));
    await mkdir(staged, { recursive: false });
    try {
      await writeCompactWorking(staged, state);
      await mkdir(path.dirname(archive), { recursive: true });
      await mkdir(archive, { recursive: false });
      await Promise.all([
        copyFile(manifestFile, path.join(archive, "approved-manifest.yaml")),
        writeFile(path.join(archive, "publication.json"), `${JSON.stringify(state, null, 2)}\n`),
      ]);
      await rename(working, path.join(archive, "working"));
      try {
        await rename(staged, working);
      } catch (error) {
        await rename(path.join(archive, "working"), working);
        throw error;
      }
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      if (!(await exists(path.join(archive, "working")))) {
        await rm(archive, { recursive: true, force: true });
      }
      throw error;
    }

    return {
      milestone: state.milestone,
      scope: state.scope,
      publishedAt,
      workingPath: "working",
      archivePath: archiveRelative,
      manifestHash: state.manifestHash,
    };
  });
}

export async function compactAllApprovedMilestones(
  journal: RunJournal,
  scope = "shared",
): Promise<CompactAllReceipt> {
  if (scope !== "shared") throw new Error("Only scope=shared is supported");
  const files = await approvedManifestFiles(path.join(journal.memoryRoot, "milestones"));
  const loaded = await Promise.all(files.map(async (file) => ({ file, ...(await loadApprovedMilestoneManifest(file)) })));
  loaded.sort((a, b) =>
    a.manifest.review.accepted_at.localeCompare(b.manifest.review.accepted_at)
      || a.manifest.milestone.localeCompare(b.manifest.milestone),
  );

  const publishedHashes = new Set((await loadCompactArchives(journal.memoryRoot)).map((archive) => archive.state.manifestHash));
  const seenHashes = new Set<string>();
  const pending = loaded.filter(({ raw }) => {
    const hash = contentHash(raw);
    if (publishedHashes.has(hash) || seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });
  const compacted: CompactReceipt[] = [];
  for (const item of pending) {
    compacted.push(await compactMemory(journal, item.file, item.manifest.milestone, scope));
  }
  return { requested: loaded.length, compacted, skipped: loaded.length - pending.length };
}

export async function writeCompactWorking(directory: string, state: CompactState): Promise<void> {
  const project = renderCompactProjectState(state);
  await Promise.all([
    writeFile(path.join(directory, "project-state.md"), project),
    writeFile(path.join(directory, "active-tasks.md"), `# Active tasks\n\n${markdownList(state.baseline.pendingWork, "No pending work recorded.")}\n`),
    writeFile(path.join(directory, "decisions.md"), `# Decisions\n\n${markdownList(state.baseline.decisions, "No decisions recorded.")}\n`),
    writeFile(path.join(directory, "contracts.md"), `# APIs and contracts\n\n${markdownList(state.baseline.contracts, "No APIs or contracts recorded.")}\n`),
    writeFile(path.join(directory, "risks.md"), `# Risks and blockers\n\n${markdownList(state.baseline.risks, "No risks recorded.")}\n`),
    writeFile(path.join(directory, "compact-state.json"), `${JSON.stringify(state, null, 2)}\n`),
  ]);
}

export function renderCompactProjectState(state: CompactState): string {
  return [
    "# Project state",
    "",
    `## Accepted milestone: ${state.milestone}`,
    "",
    state.baseline.summary,
    "",
    "## Validated outcomes",
    "",
    markdownList(state.baseline.validatedOutcomes, "No validated outcomes recorded."),
    "",
    "## Durable artifacts",
    "",
    state.baseline.artifacts.length
      ? state.baseline.artifacts.map((artifact) => `- \`${artifact.path}\` — ${artifact.description}`).join("\n")
      : "No durable artifacts recorded.",
    "",
    `Approved manifest: [${state.archivePath}/approved-manifest.yaml](../${state.archivePath}/approved-manifest.yaml)`,
    `Archived working context: [${state.archivePath}/working](../${state.archivePath}/working)`,
    "",
  ].join("\n");
}

async function readBullets(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).flatMap((line) => {
      const match = /^-\s+(.+)$/.exec(line);
      return match ? [match[1]!.trim()] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function markdownList(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueArtifacts(items: MilestoneArtifact[]): MilestoneArtifact[] {
  return [...new Map(items.map((item) => [item.path.trim(), { path: item.path.trim(), description: item.description.trim() }])).values()];
}

function relativeOrAbsolute(root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative.startsWith("../") ? file : relative;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await readFile(path.join(candidate, "project-state.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function approvedManifestFiles(root: string): Promise<string[]> {
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
      else if (entry.isFile() && entry.name === "approved.yaml") output.push(absolute);
    }
  };
  await visit(root);
  return output.sort();
}

import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { RunJournal } from "./journal.js";
import { readMemoryPage } from "./memory-overrides.js";
import { verifyMemory } from "./memory.js";
import { loadRoadmap, type RoadmapState } from "./roadmap.js";
import { contentHash } from "./utils.js";

export type Severity = "unrated" | "critical" | "major" | "minor";
export type Urgency = "unrated" | "high" | "medium" | "low";
export type WorkStatus = "active" | "blocked" | "done" | "resolved";

export interface Qualification {
  kind: "task" | "risk";
  id: string;
  severity: Severity;
  urgency: Urgency;
  priority: "Unrated" | "P1" | "P2" | "P3" | "P4" | "P5";
  actionLevel: string;
  status: WorkStatus;
}

export interface WebSettings {
  roadmapPath: string;
  agentsPath: string;
}

interface QualificationStore {
  schemaVersion: 1;
  entries: Record<string, Qualification>;
}

export interface RiskItem {
  id: string;
  text: string;
}

const DEFAULT_SETTINGS: WebSettings = { roadmapPath: "ROADMAP.md", agentsPath: "AGENTS.md" };
const MAX_PROJECT_MARKDOWN_BYTES = 1_000_000;

export async function deriveProjectName(projectRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.replace(/^@[^/]+\//, "");
  } catch {
    // The directory name is a stable fallback for projects without package metadata.
  }
  return path.basename(path.resolve(projectRoot));
}

export async function loadWebSettings(memoryRoot: string): Promise<WebSettings> {
  try {
    const parsed = JSON.parse(await readFile(path.join(memoryRoot, "manual", "web-settings.json"), "utf8")) as Partial<WebSettings>;
    return {
      roadmapPath: validRelativeMarkdown(parsed.roadmapPath) ? parsed.roadmapPath : DEFAULT_SETTINGS.roadmapPath,
      agentsPath: validRelativeMarkdown(parsed.agentsPath) ? parsed.agentsPath : DEFAULT_SETTINGS.agentsPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveWebSettings(memoryRoot: string, settings: WebSettings): Promise<WebSettings> {
  if (!validRelativeMarkdown(settings.roadmapPath) || !validRelativeMarkdown(settings.agentsPath)) {
    throw new Error("Project files must be project-relative .md paths");
  }
  const normalized = { roadmapPath: settings.roadmapPath.trim(), agentsPath: settings.agentsPath.trim() };
  await atomicJson(path.join(memoryRoot, "manual", "web-settings.json"), normalized);
  return normalized;
}

export async function readProjectMarkdown(projectRoot: string, relativePath: string): Promise<string> {
  const file = await safeProjectMarkdownPath(projectRoot, relativePath, false);
  return readFile(file, "utf8");
}

export async function writeProjectMarkdown(projectRoot: string, relativePath: string, markdown: string): Promise<void> {
  if (Buffer.byteLength(markdown, "utf8") > MAX_PROJECT_MARKDOWN_BYTES) throw new Error("Markdown file is larger than 1 MB");
  const file = await safeProjectMarkdownPath(projectRoot, relativePath, true);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`);
}

export async function loadQualifications(memoryRoot: string): Promise<Record<string, Qualification>> {
  try {
    const store = JSON.parse(await readFile(path.join(memoryRoot, "manual", "qualifications.json"), "utf8")) as QualificationStore;
    return store.schemaVersion === 1 && store.entries && typeof store.entries === "object" ? store.entries : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

export async function saveQualification(
  memoryRoot: string,
  value: Omit<Qualification, "priority" | "actionLevel">,
): Promise<Qualification> {
  if (!/^(task|risk)$/.test(value.kind) || !value.id || value.id.length > 200) throw new Error("Invalid qualification target");
  if (!["unrated", "critical", "major", "minor"].includes(value.severity)) throw new Error("Invalid severity");
  if (!["unrated", "high", "medium", "low"].includes(value.urgency)) throw new Error("Invalid urgency");
  const allowedStatuses: WorkStatus[] = value.kind === "task" ? ["active", "blocked", "done"] : ["active", "resolved"];
  if (!allowedStatuses.includes(value.status)) throw new Error(`Invalid ${value.kind} status`);
  const { priority, actionLevel } = qualify(value.severity, value.urgency);
  const qualification: Qualification = { ...value, priority, actionLevel };
  const entries = await loadQualifications(memoryRoot);
  entries[`${value.kind}:${value.id}`] = qualification;
  await atomicJson(path.join(memoryRoot, "manual", "qualifications.json"), { schemaVersion: 1, entries } satisfies QualificationStore);
  return qualification;
}

export function qualify(severity: Severity, urgency: Urgency): Pick<Qualification, "priority" | "actionLevel"> {
  if (severity === "unrated" || urgency === "unrated") return { priority: "Unrated", actionLevel: "Select severity and urgency." };
  const matrix = {
    critical: { high: "P1", medium: "P2", low: "P3" },
    major: { high: "P2", medium: "P3", low: "P4" },
    minor: { high: "P3", medium: "P4", low: "P5" },
  } as const;
  const priority = matrix[severity][urgency];
  const actionLevel = {
    P1: "Immediate: all hands; workaround or fix within hours.",
    P2: "Urgent: address within the same business day.",
    P3: "Standard: handle during the normal weekly sprint.",
    P4: "Low: target the next scheduled release.",
    P5: "Planning: retain in the backlog until capacity permits.",
  }[priority];
  return { priority, actionLevel };
}

export function parseRiskItems(markdown: string): RiskItem[] {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!match) return [];
    const text = match[1]!.trim();
    return text && !/^none\b/i.test(text) ? [{ id: contentHash(text).slice(0, 16), text }] : [];
  });
}

export async function loadRoadmapSafely(projectRoot: string, relativePath: string): Promise<RoadmapState | null> {
  try {
    await safeProjectMarkdownPath(projectRoot, relativePath, false);
    return await loadRoadmap(projectRoot, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function approveMilestone(
  projectRoot: string,
  journal: RunJournal,
  roadmapPath: string,
  milestone: string,
  acceptedBy = "OrchBun memory web",
  now = new Date(),
): Promise<{ manifestPath: string; alreadyApproved: boolean }> {
  const roadmap = await loadRoadmap(projectRoot, roadmapPath);
  const tasks = roadmap.tasks.filter((task) => task.milestone === milestone);
  if (!tasks.length) throw new Error(`Milestone ${milestone} has no roadmap steps`);
  const incomplete = tasks.filter((task) => !task.completed);
  if (incomplete.length) throw new Error(`Complete every ${milestone} step before approval: ${incomplete.map((task) => task.id).join(", ")}`);
  const report = await verifyMemory(journal);
  if (report.issues.length) throw new Error(`Memory verification must pass before approval: ${report.issues.join("; ")}`);
  const slug = milestone.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("Milestone name cannot be converted to a manifest name");
  const manifestPath = path.join(journal.memoryRoot, "milestones", slug, "approved.yaml");
  try {
    await readFile(manifestPath, "utf8");
    return { manifestPath: path.relative(journal.memoryRoot, manifestPath).split(path.sep).join("/"), alreadyApproved: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [projectState, decisions, contracts, risks] = await Promise.all([
    readMemoryPage(journal.memoryRoot, "project-state"),
    readMemoryPage(journal.memoryRoot, "decisions"),
    readMemoryPage(journal.memoryRoot, "contracts"),
    readMemoryPage(journal.memoryRoot, "risks"),
  ]);
  const title = tasks[0]!.milestoneTitle;
  const settings = await loadWebSettings(journal.memoryRoot);
  const manifest = {
    schema_version: "1.0",
    milestone: slug,
    scope: "shared",
    review: { decision: "accepted", accepted_at: now.toISOString(), accepted_by: acceptedBy },
    summary: `${milestone} — ${title} completed and accepted. ${firstContentLine(projectState)}`.slice(0, 2_000),
    validated_outcomes: tasks.map((task) => `${task.id}: ${task.title}`),
    decisions: bulletItems(decisions),
    contracts: bulletItems(contracts),
    risks: bulletItems(risks),
    pending_work: roadmap.tasks.filter((task) => !task.completed).map((task) => `${task.id}: ${task.title}`),
    artifacts: [
      { path: settings.roadmapPath, description: "Validated project roadmap." },
      { path: settings.agentsPath, description: "Project agent workflow contract." },
    ],
    supersedes: [],
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await atomicWrite(manifestPath, YAML.stringify(manifest));
  return { manifestPath: path.relative(journal.memoryRoot, manifestPath).split(path.sep).join("/"), alreadyApproved: false };
}

function bulletItems(markdown: string): string[] {
  return markdown.split(/\r?\n/).flatMap((line) => /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim() ?? []).filter((item) => !/^none\b/i.test(item));
}

function firstContentLine(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "The milestone checklist and memory verification passed.";
}

function validRelativeMarkdown(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !path.isAbsolute(value) && path.extname(value).toLowerCase() === ".md"
    && !path.normalize(value).split(path.sep).includes("..");
}

async function safeProjectMarkdownPath(projectRoot: string, relativePath: string, allowMissing: boolean): Promise<string> {
  if (!validRelativeMarkdown(relativePath)) throw new Error("Path must be a project-relative .md file");
  const root = await realpath(projectRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path must stay inside the project");
  try {
    const existing = await realpath(target);
    const realRelative = path.relative(root, existing);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("Project file symlink leaves the project");
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await nearestExistingDirectory(path.dirname(target));
    const parentRelative = path.relative(root, parent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error("Project file directory leaves the project");
  }
  return target;
}

async function nearestExistingDirectory(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

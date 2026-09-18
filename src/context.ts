import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OrchbunConfig } from "./config.js";
import { memoryRoot, pathExists } from "./config.js";
import type { ContextPacket, ContextRetrievalComparison, RunMode } from "./types.js";
import { contentHash, estimateTokens, safeWorkspacePath, truncate } from "./utils.js";
import { memoryPageCatalogue, type MemoryPageDefinition } from "./memory-pages.js";
import type { MemoryHit } from "./memory-service.js";

interface ContextOptions {
  sourcePrompt: string;
  taskId: string | null;
  mode: RunMode;
  contextFiles: string[];
  allowDelegation: boolean;
  runtimeAvailable?: boolean;
  memoryPages?: Record<string, string>;
}

type RetrievedMemoryHit = Pick<MemoryHit, "citation" | "snippet" | "rankExplanation"> & {
  document: Pick<MemoryHit["document"], "path" | "lifecycle">;
};

interface RetrievalContextOptions extends ContextOptions {
  retrievedMemory: { hits: RetrievedMemoryHit[] };
}

interface Candidate {
  label: string;
  relativePath: string;
  priority: number;
  text: string;
}

const MANDATORY_AUTHORITY = {
  "project-state": "PROJECT STATE",
  "active-tasks": "TASK STATE",
  contracts: "OPERATIONAL CONSTRAINTS",
  risks: "UNRESOLVED RISKS",
} as const;

function contract(mode: RunMode, allowDelegation: boolean, runtimeAvailable: boolean): string {
  const permissions = mode === "review"
    ? "MODE: REVIEW. Inspect and report only. Do not edit files, create files, install packages, commit, or run mutating commands."
    : "MODE: WORK. You may edit project files and run verification needed for this task.";
  const delegation = allowDelegation
    ? "For a bounded subtask, you may run: pnpm orchbun delegate --agent claude --prompt \"...\". Delegates default to REVIEW. Use --mode work only when edits are necessary."
    : "Do not delegate this run.";
  const runtime = runtimeAvailable
    ? "This run has an Orchbun-managed runtime. Use only `orchbun runtime status`, `orchbun runtime rebuild`, and `orchbun runtime logs`; do not invoke Docker directly."
    : "No Orchbun-managed runtime is available for this run.";
  return `${permissions}\n${delegation}\n${runtime}\nReturn only one JSON object matching the supplied schema. Be concise and factual. Record only material outcomes, file changes, decisions, risks, blockers, next actions, and verification you actually performed.`;
}

export async function buildContextPacket(
  controlRoot: string,
  config: OrchbunConfig,
  options: ContextOptions,
  workspaceRoot = controlRoot,
): Promise<ContextPacket> {
  const candidates: Candidate[] = [];
  const localMemory = memoryRoot(controlRoot, config);
  const catalogue = memoryPageCatalogue(config).filter((page) => page.includeInContext);

  for (const [index, page] of catalogue.entries()) {
    const absolute = path.join(localMemory, "working", page.filename);
    const projected = options.memoryPages?.[page.id];
    if (projected !== undefined || await pathExists(absolute)) {
      candidates.push({
        label: "WORKING MEMORY",
        relativePath: path.relative(controlRoot, absolute),
        priority: (page.kind === "builtin" ? 300 : 200) - index,
        text: projected ?? await readFile(absolute, "utf8"),
      });
    }
  }

  for (const relativePath of options.contextFiles) {
    const absolute = safeWorkspacePath(workspaceRoot, relativePath);
    if (!(await pathExists(absolute))) throw new Error(`Context file does not exist: ${relativePath}`);
    candidates.push({
      label: "EXPLICIT CONTEXT",
      relativePath,
      priority: 100,
      text: await readFile(absolute, "utf8"),
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.relativePath.localeCompare(b.relativePath));
  const header = contract(options.mode, options.allowDelegation, options.runtimeAvailable === true);
  const task = options.taskId ? `TASK: ${options.taskId}\n` : "";
  const request = `[REQUEST]\n${task}${options.sourcePrompt}`;
  const sections: string[] = [];
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  const seen = new Set<string>();
  let used = header.length + request.length + 4;

  for (const candidate of candidates) {
    const text = truncate(candidate.text.trim(), config.budgets.maxFileChars);
    const hash = contentHash(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const section = `[${candidate.label}: ${candidate.relativePath}]\n${text}`;
    const remaining = config.budgets.maxInputChars - used;
    if (remaining < 256) {
      omittedFiles.push(candidate.relativePath);
      continue;
    }
    const fitted = truncate(section, remaining);
    sections.push(fitted);
    includedFiles.push(candidate.relativePath);
    used += fitted.length + 2;
    if (fitted.length < section.length) omittedFiles.push(`${candidate.relativePath} (partial)`);
  }

  const expandedPrompt = truncate([header, request, ...sections].join("\n\n"), config.budgets.maxInputChars);
  return {
    taskId: options.taskId,
    sourcePrompt: options.sourcePrompt,
    expandedPrompt,
    includedFiles,
    omittedFiles,
    inputCharacters: expandedPrompt.length,
    estimatedInputTokens: estimateTokens(expandedPrompt),
  };
}

/** Builds an evaluation-only candidate. Callers must never send it in place of the baseline packet. */
export async function buildRetrievalCandidatePacket(
  controlRoot: string,
  config: OrchbunConfig,
  options: RetrievalContextOptions,
  workspaceRoot = controlRoot,
): Promise<ContextPacket> {
  const localMemory = memoryRoot(controlRoot, config);
  const catalogue = memoryPageCatalogue(config);
  const pages = await workingPages(localMemory, catalogue, options.memoryPages);
  const header = contract(options.mode, options.allowDelegation, options.runtimeAvailable === true);
  const task = options.taskId ? `TASK: ${options.taskId}\n` : "";
  const request = `[REQUEST]\n${task}${options.sourcePrompt}`;
  const mandatory = catalogue.flatMap((page) => {
    const label = MANDATORY_AUTHORITY[page.id as keyof typeof MANDATORY_AUTHORITY];
    if (!label || !page.includeInContext) return [];
    const body = compactAuthority(page.id as keyof typeof MANDATORY_AUTHORITY, pages[page.id] ?? "", options.taskId);
    return [mandatorySection(label, `working/${page.filename}`, body)];
  });
  const mandatorySections = [header, request, ...mandatory.map(item => item.text)];
  const mandatoryCharacters = mandatorySections.join("\n\n").length;
  if (mandatoryCharacters > config.budgets.maxInputChars) {
    throw new Error(
      `Context mandatory core requires ${mandatoryCharacters} characters, but maxInputChars is ${config.budgets.maxInputChars}. `
      + "Increase budgets.maxInputChars or reduce the current project/task state, operational constraints, or unresolved risks; none were omitted.",
    );
  }

  const includedFiles = mandatory.map(item => path.relative(controlRoot, path.join(localMemory, item.relativePath)));
  const omittedFiles: string[] = [];
  const optional: Candidate[] = [];
  for (const relativePath of options.contextFiles) {
    const absolute = safeWorkspacePath(workspaceRoot, relativePath);
    if (!(await pathExists(absolute))) throw new Error(`Context file does not exist: ${relativePath}`);
    optional.push({
      label: "EXPLICIT CONTEXT",
      relativePath,
      priority: 100,
      text: await readFile(absolute, "utf8"),
    });
  }
  // Configured authority projections are already represented by the compact
  // mandatory core. Decisions and opted-in custom pages remain eligible:
  // their manual content exists only in the projection.
  const projectedPaths = new Set(mandatory.map((item) => item.relativePath));
  const eligibleProjectionPaths = new Set(catalogue
    .filter((page) => page.includeInContext)
    .map((page) => `working/${page.filename}`));
  for (const [index, hit] of options.retrievedMemory.hits.entries()) {
    if (projectedPaths.has(hit.citation.path)) continue;
    if (hit.citation.id.startsWith("projection:") && !eligibleProjectionPaths.has(hit.citation.path)) continue;
    const explanation = formatRankExplanation(hit.rankExplanation);
    optional.push({
      label: `RETRIEVED MEMORY · ${hit.document.lifecycle}`,
      relativePath: hit.citation.path,
      priority: 50 - index,
      text: `Citation: ${hit.citation.id} · ${hit.citation.path} · ${hit.citation.hash}\nRank: ${explanation}\n${hit.snippet}`,
    });
  }

  const sections = [...mandatorySections];
  const seen = new Set(mandatory.map(item => contentHash(item.body)));
  let used = mandatoryCharacters;
  for (const candidate of optional) {
    const body = truncate(candidate.text.trim(), config.budgets.maxFileChars);
    const hash = contentHash(body);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const section = `[${candidate.label}: ${candidate.relativePath}]\n${body}`;
    const remaining = config.budgets.maxInputChars - used - 2;
    if (remaining < 256) {
      omittedFiles.push(candidate.relativePath);
      continue;
    }
    const fitted = truncate(section, remaining);
    sections.push(fitted);
    includedFiles.push(candidate.relativePath);
    used += fitted.length + 2;
    if (fitted.length < section.length) omittedFiles.push(`${candidate.relativePath} (partial)`);
  }

  const expandedPrompt = sections.join("\n\n");
  return {
    taskId: options.taskId,
    sourcePrompt: options.sourcePrompt,
    expandedPrompt,
    includedFiles: [...new Set(includedFiles)],
    omittedFiles,
    inputCharacters: expandedPrompt.length,
    estimatedInputTokens: estimateTokens(expandedPrompt),
  };
}

async function workingPages(
  localMemory: string,
  catalogue: readonly MemoryPageDefinition[],
  projected?: Record<string, string>,
): Promise<Record<string, string>> {
  const pages: Record<string, string> = {};
  for (const page of catalogue) {
    const projectedMarkdown = projected?.[page.id];
    if (projectedMarkdown !== undefined) {
      pages[page.id] = projectedMarkdown;
      continue;
    }
    const absolute = path.join(localMemory, "working", page.filename);
    pages[page.id] = await pathExists(absolute) ? await readFile(absolute, "utf8") : "";
  }
  return pages;
}

function compactAuthority(id: keyof typeof MANDATORY_AUTHORITY, markdown: string, taskId: string | null): string {
  switch (id) {
    case "project-state": return compactProjectState(markdown);
    case "active-tasks": return compactTaskState(markdown, taskId);
    case "contracts": return cleanMarkdown(markdown);
    case "risks": return unresolvedRisks(markdown);
  }
}

function mandatorySection(label: string, relativePath: string, body: string): { relativePath: string; body: string; text: string } {
  const selected = body.trim() || "None recorded.";
  return { relativePath, body: selected, text: `[MANDATORY ${label}: ${relativePath}]\n${selected}` };
}

function compactProjectState(markdown: string): string {
  const clean = cleanMarkdown(markdown);
  if (!clean) return "";
  const roadmap = markdownSection(clean, "Roadmap");
  const verification = markdownSection(clean, "Last recorded verification");
  return ["# Project state", roadmap, verification].filter(Boolean).join("\n\n");
}

function compactTaskState(markdown: string, taskId: string | null): string {
  const clean = cleanMarkdown(markdown);
  if (!taskId) return clean;
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matching = clean.split(/\r?\n/).filter(line => new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(line));
  return matching.length ? `# Matching task state\n\n${matching.join("\n")}` : `# Matching task state\n\nNo state recorded for ${taskId}.`;
}

function unresolvedRisks(markdown: string): string {
  const [generated = "", annotations = ""] = markdown.split("<!-- orchbun:annotation:start -->", 2);
  const unresolved = generated.split(/^## Resolved\s*$/m, 1)[0] ?? "";
  return [cleanMarkdown(unresolved), cleanMarkdown(annotations)].filter(Boolean).join("\n\n");
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--[^]*?-->/g, "")
    .split(/\r?\n/)
    .filter(line => !/^# (Project state|Tasks|APIs and contracts|Risks and blockers)\s*$/.test(line.trim()))
    .join("\n")
    .trim();
}

function markdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(markdown);
  return match ? `## ${heading}${match[1]}`.trim() : "";
}

function formatRankExplanation(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, entry]) => entry === false || entry === null || entry === undefined || entry === "" || (Array.isArray(entry) && !entry.length)
        ? []
        : [`${key}=${Array.isArray(entry) ? entry.join(",") : String(entry)}`])
      .join("; ");
  }
  return String(value ?? "deterministic lexical ranking");
}

export function compareContextPackets(
  baseline: ContextPacket,
  candidate: ContextPacket,
  sourceRevision: string,
  citationIds: readonly string[],
  mandatoryAuthorityMarkers: readonly string[],
): ContextRetrievalComparison {
  return {
    sourceRevision,
    baselineCharacters: baseline.expandedPrompt.length,
    candidateCharacters: candidate.expandedPrompt.length,
    topCitationIds: [...new Set(citationIds)].slice(0, 5),
    mandatoryAuthorityPreserved: mandatoryAuthorityMarkers.every(marker => candidate.expandedPrompt.includes(marker)),
  };
}

/** Markers used to prove that every configured authority page survived candidate composition. */
export function requiredAuthorityMarkers(config: OrchbunConfig): string[] {
  return memoryPageCatalogue(config).flatMap((page) => {
    const label = MANDATORY_AUTHORITY[page.id as keyof typeof MANDATORY_AUTHORITY];
    return label && page.includeInContext ? [`[MANDATORY ${label}:`] : [];
  });
}

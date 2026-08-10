import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OrchbunConfig } from "./config.js";
import { memoryRoot, pathExists } from "./config.js";
import type { ContextPacket, RunMode } from "./types.js";
import { contentHash, estimateTokens, safeWorkspacePath, truncate } from "./utils.js";

interface ContextOptions {
  sourcePrompt: string;
  taskId: string | null;
  mode: RunMode;
  contextFiles: string[];
  allowDelegation: boolean;
}

interface Candidate {
  label: string;
  relativePath: string;
  priority: number;
  text: string;
}

const WORKING_FILES = [
  "working/project-state.md",
  "working/active-tasks.md",
  "working/decisions.md",
  "working/risks.md",
] as const;

function contract(mode: RunMode, allowDelegation: boolean): string {
  const permissions = mode === "review"
    ? "MODE: REVIEW. Inspect and report only. Do not edit files, create files, install packages, commit, or run mutating commands."
    : "MODE: WORK. You may edit project files and run verification needed for this task.";
  const delegation = allowDelegation
    ? "For a bounded subtask, you may run: pnpm orchbun delegate --agent claude --prompt \"...\". Delegates default to REVIEW. Use --mode work only when edits are necessary."
    : "Do not delegate this run.";
  return `${permissions}\n${delegation}\nReturn only one JSON object matching the supplied schema. Be concise and factual. Record only material outcomes, file changes, decisions, risks, blockers, next actions, and verification you actually performed.`;
}

export async function buildContextPacket(
  root: string,
  config: OrchbunConfig,
  options: ContextOptions,
): Promise<ContextPacket> {
  const candidates: Candidate[] = [];
  const localMemory = memoryRoot(root, config);

  for (const [index, relative] of WORKING_FILES.entries()) {
    const absolute = path.join(localMemory, relative);
    if (await pathExists(absolute)) {
      candidates.push({
        label: "WORKING MEMORY",
        relativePath: path.relative(root, absolute),
        priority: 100 - index,
        text: await readFile(absolute, "utf8"),
      });
    }
  }

  for (const relativePath of options.contextFiles) {
    const absolute = safeWorkspacePath(root, relativePath);
    if (!(await pathExists(absolute))) throw new Error(`Context file does not exist: ${relativePath}`);
    candidates.push({
      label: "EXPLICIT CONTEXT",
      relativePath,
      priority: 50,
      text: await readFile(absolute, "utf8"),
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.relativePath.localeCompare(b.relativePath));
  const header = contract(options.mode, options.allowDelegation);
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

export type AgentKind = "codex" | "claude" | "openrouter";
export type RunMode = "review" | "work";
export type RunStatus = "pending" | "completed" | "partial" | "blocked" | "failed" | "interrupted";

export interface Deliverable {
  type: "file" | "commit" | "url" | "note" | "other";
  value: string;
  description: string;
}

export interface Verification {
  check: string;
  result: "passed" | "failed" | "not_run";
  evidence: string;
}

export interface FileChange {
  path: string;
  change: string;
}

export interface AgentResult {
  schema_version: "2.0";
  task_id: string | null;
  prompt_intent: string;
  outcome: "completed" | "partial" | "blocked" | "failed";
  summary: string;
  deliverables: Deliverable[];
  files_changed: FileChange[];
  decisions: string[];
  risks: string[];
  blockers: string[];
  open_questions: string[];
  next_actions: string[];
  verification: Verification[];
}

export interface ContextPacket {
  taskId: string | null;
  sourcePrompt: string;
  expandedPrompt: string;
  includedFiles: string[];
  omittedFiles: string[];
  inputCharacters: number;
  estimatedInputTokens: number;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface RunMetadata {
  runId: string;
  parentRunId: string | null;
  taskId: string | null;
  depth: number;
  agent: AgentKind;
  mode: RunMode;
  status: RunStatus;
  model?: string;
  startedAt: string;
  finishedAt: string | null;
  promptHash: string;
  inputCharacters: number;
  estimatedInputTokens: number;
  includedFiles: string[];
  omittedFiles: string[];
  gitBefore?: string;
  gitAfter?: string;
  usage?: AgentUsage;
}

export type AgentKind = "codex" | "claude" | "openrouter";
export type RunMode = "review" | "work";
export type RunStatus = "pending" | "running" | "completed" | "partial" | "blocked" | "failed" | "interrupted";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "partial", "blocked", "failed", "interrupted"];

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
  /** Shadow-only comparison. The production expandedPrompt remains the baseline packet. */
  retrievalComparison?: ContextRetrievalComparison;
}

export interface ContextRetrievalComparison {
  sourceRevision: string;
  baselineCharacters: number;
  candidateCharacters: number;
  topCitationIds: string[];
  mandatoryAuthorityPreserved: boolean;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface RuntimeIsolation {
  driver: "none" | "compose";
  project: string | null;
  frontendPort: number | null;
  backendPort: number | null;
  databasePort: number | null;
  frontendUrl: string | null;
  backendUrl: string | null;
  state: "disabled" | "allocated" | "ready" | "stopped" | "failed";
}

export interface WorktreeIsolation {
  leaseId: string;
  inherited: boolean;
  controlRoot: string;
  workspaceRoot: string;
  baseCommit: string;
  branch: string;
  lifecycle: "provisioned" | "running" | "retained" | "cleaned" | "recovery-required";
  runtime: RuntimeIsolation;
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
  isolation?: WorktreeIsolation;
  /** Provider conversation id reported by the agent, used to send follow-ups. */
  sessionId?: string;
  /** For a follow-up: the earlier run whose provider session this run resumes. */
  resumesRunId?: string;
  resumeSessionId?: string;
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OrchbunConfig } from "./config.js";
import { memoryRoot } from "./config.js";
import {
  buildContextPacket,
  buildRetrievalCandidatePacket,
  compareContextPackets,
  requiredAuthorityMarkers,
} from "./context.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { OpenRouterAdapter } from "./adapters/openrouter.js";
import type { AgentAdapter, AdapterResponse } from "./adapters/base.js";
import { gitSnapshot, snapshotLabel } from "./git.js";
import { RunJournal } from "./journal.js";
import { refreshMemory } from "./memory-refresh.js";
import type { AgentKind, AgentResult, ContextPacket, RunMetadata, RunMode, RunStatus } from "./types.js";
import { contentHash, estimateTokens, newRunId } from "./utils.js";
import { IsolationManager, RuntimeBroker } from "./isolation.js";
import type { WorktreeIsolation } from "./types.js";
import { MemoryService } from "./memory-service.js";
import { memoryPageCatalogue } from "./memory-pages.js";
import { createRoadmapStore, RoadmapStoreError } from "./roadmap-store.js";

export interface RunOptions {
  agent: AgentKind;
  mode: RunMode;
  sourcePrompt: string;
  taskId: string | null;
  parentRunId: string | null;
  depth: number;
  contextFiles: string[];
  model?: string;
  isolation?: WorktreeIsolation;
  /** Continue an earlier run's provider session with a bare follow-up prompt. */
  resume?: { runId: string; sessionId: string };
}

export interface PreparedRun {
  metadata: RunMetadata;
  packet: ContextPacket;
  runDirectory: string;
}

export interface CompletedRun {
  result: AgentResult;
  metadata: RunMetadata;
  runDirectory: string;
}

export class Orchestrator {
  private readonly adapters: Record<AgentKind, AgentAdapter>;
  readonly journal: RunJournal;
  readonly isolation: IsolationManager;

  constructor(
    private readonly root: string,
    private readonly config: OrchbunConfig,
    adapters: Partial<Record<AgentKind, AgentAdapter>> = {},
  ) {
    this.journal = new RunJournal(memoryRoot(root, config));
    this.isolation = new IsolationManager(root, config);
    this.adapters = {
      codex: new CodexAdapter(),
      claude: new ClaudeAdapter(),
      openrouter: new OpenRouterAdapter(),
      ...adapters,
    };
  }

  async context(
    options: RunOptions,
    workspaceRoot = this.root,
    runtimeAvailable = options.isolation?.runtime.driver === "compose",
  ): Promise<ContextPacket> {
    const memory = await refreshMemory(this.journal, this.root, false);
    const contextOptions = {
      memoryPages: memory.projection.pages,
      sourcePrompt: options.sourcePrompt,
      taskId: options.taskId,
      mode: options.mode,
      contextFiles: options.contextFiles,
      allowDelegation: options.mode === "work" && options.depth < this.config.delegation.maxDepth,
      runtimeAvailable,
    };
    const baseline = await buildContextPacket(this.root, this.config, contextOptions, workspaceRoot);
    try {
      const service = await MemoryService.open(this.root);
      if (service.sourceRevision !== memory.projection.sourceRevision) {
        throw new Error("Memory changed while preparing retrieval context");
      }
      const retrievedMemory = service.retrieve({
        text: options.sourcePrompt,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        maxCharacters: this.config.budgets.maxInputChars,
      });
      const candidate = await buildRetrievalCandidatePacket(this.root, this.config, {
        ...contextOptions,
        retrievedMemory,
      }, workspaceRoot);
      return {
        ...baseline,
        retrievalComparison: compareContextPackets(
          baseline,
          candidate,
          retrievedMemory.sourceRevision,
          retrievedMemory.hits.map(hit => hit.citation.id),
          requiredAuthorityMarkers(this.config),
        ),
      };
    } catch {
      // Shadow retrieval is disposable. Any ranking or candidate-composition
      // failure leaves the production five-page packet exactly unchanged.
      return baseline;
    }
  }

  async run(options: RunOptions): Promise<CompletedRun> {
    return this.execute(await this.prepare(options));
  }

  /**
   * Validates the request, provisions isolation, and records a pending run.
   * Everything that can reject a request happens here, before any agent starts.
   */
  async prepare(options: RunOptions): Promise<PreparedRun> {
    if (options.depth > this.config.delegation.maxDepth) {
      throw new Error(`Delegation depth ${options.depth} exceeds maximum ${this.config.delegation.maxDepth}`);
    }
    if (options.parentRunId && options.depth < 1) throw new Error("A child run must have depth 1 or greater");
    if (options.agent === "openrouter" && options.mode === "work") {
      throw new Error("OpenRouter cannot use work mode because it has no local file tools");
    }

    await this.journal.initialize(memoryPageCatalogue(this.config));
    const runId = newRunId(options.agent);
    const createsIsolation = !options.isolation && !options.resume && options.mode === "work" && this.config.isolation.enabled;
    // Build and validate context before creating external resources. A fresh
    // worktree is rooted at the same clean tracked HEAD, so the packet remains
    // exact while avoiding orphaned worktrees for invalid context requests.
    const preparedPacket = createsIsolation
      ? await this.context(options, this.root, this.config.isolation.runtime.driver === "compose")
      : undefined;
    const isolation = options.isolation ?? (
      createsIsolation
        ? await this.isolation.provision(runId, options.taskId)
        : undefined
    );
    const workspaceRoot = isolation?.workspaceRoot ?? this.root;
    const packet = options.resume
      ? followUpPacket(options.sourcePrompt, options.taskId)
      : preparedPacket ?? await this.context({ ...options, ...(isolation ? { isolation } : {}) }, workspaceRoot);
    const model = options.model ?? (options.agent === "openrouter" ? this.config.agents.openrouterModel : undefined);
    const metadata: RunMetadata = {
      runId,
      parentRunId: options.parentRunId,
      taskId: options.taskId,
      depth: options.depth,
      agent: options.agent,
      mode: options.mode,
      status: "pending",
      ...(model ? { model } : {}),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      promptHash: `sha256:${contentHash(options.sourcePrompt)}`,
      inputCharacters: packet.inputCharacters,
      estimatedInputTokens: packet.estimatedInputTokens,
      includedFiles: packet.includedFiles,
      omittedFiles: packet.omittedFiles,
      gitBefore: snapshotLabel(await gitSnapshot(workspaceRoot)),
      ...(isolation ? { isolation } : {}),
      ...(options.resume ? { resumesRunId: options.resume.runId, resumeSessionId: options.resume.sessionId } : {}),
    };
    const runDirectory = await this.journal.begin(metadata, packet);
    return { metadata, packet, runDirectory };
  }

  /** Reloads a pending run recorded by prepare, for execution in another process. */
  async load(runId: string): Promise<PreparedRun> {
    const runDirectory = this.runDirectory(runId);
    const metadata = await this.journal.readMetadata(runDirectory);
    if (metadata.status !== "pending") throw new Error(`Run ${runId} is ${metadata.status}; only a pending run can be executed`);
    const [sourcePrompt, expandedPrompt] = await Promise.all([
      readFile(path.join(runDirectory, "prompt.md"), "utf8"),
      readFile(path.join(runDirectory, "prompt.expanded.md"), "utf8"),
    ]);
    return {
      metadata,
      runDirectory,
      packet: {
        taskId: metadata.taskId,
        sourcePrompt,
        expandedPrompt,
        includedFiles: metadata.includedFiles,
        omittedFiles: metadata.omittedFiles,
        inputCharacters: metadata.inputCharacters,
        estimatedInputTokens: metadata.estimatedInputTokens,
      },
    };
  }

  /** Resolves a run id to its journal directory, rejecting ids that could escape it. */
  runDirectory(runId: string): string {
    if (!/^\d{8}T\d{6}Z-[a-z]+-[0-9a-f]{6}$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
    return this.journal.runDirectory(runId);
  }

  async execute(prepared: PreparedRun): Promise<CompletedRun> {
    const { metadata, packet, runDirectory } = prepared;
    const { runId, isolation } = metadata;
    const workspaceRoot = isolation?.workspaceRoot ?? this.root;
    const before = await gitSnapshot(workspaceRoot);
    const environment: NodeJS.ProcessEnv = {
      ...managedEnvironment(),
      ORCHBUN_ROOT: this.root,
      ORCHBUN_RUN_ID: runId,
      ORCHBUN_TASK_ID: metadata.taskId ?? "",
      ORCHBUN_DEPTH: String(metadata.depth),
      ORCHBUN_MODE: metadata.mode,
      ...(isolation ? {
        ...this.isolation.environment(isolation),
        ORCHBUN_BASE_COMMIT: isolation.baseCommit,
        ORCHBUN_RUNTIME_DRIVER: isolation.runtime.driver,
        ORCHBUN_RUNTIME_STATE: isolation.runtime.state,
        ORCHBUN_COMPOSE_PROJECT: isolation.runtime.project ?? "",
      } : {}),
    };
    let broker: RuntimeBroker | undefined;
    let resultRecorded = false;

    try {
      metadata.status = "running";
      await this.journal.markRunning(runDirectory, metadata);
      if (isolation) await this.isolation.markRunning(isolation);
      if (isolation?.runtime.driver === "compose" && isolation.runtime.state === "ready") {
        broker = new RuntimeBroker(this.isolation, isolation);
        const access = await broker.start();
        environment.ORCHBUN_RUNTIME_SOCKET = access.socketPath;
        environment.ORCHBUN_RUNTIME_TOKEN = access.token;
        environment.DOCKER_HOST = "unix:///nonexistent/orchbun-managed-docker.sock";
      }
      let response = await this.adapters[metadata.agent].execute(packet, {
        controlRoot: this.root,
        root: workspaceRoot,
        temporaryDir: path.join(this.journal.memoryRoot, "tmp"),
        mode: metadata.mode,
        environment,
        maxOutputTokens: this.config.budgets.maxOutputTokens,
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(metadata.resumeSessionId ? { resumeSessionId: metadata.resumeSessionId } : {}),
      });
      const sessionId = response.sessionId ?? metadata.resumeSessionId;
      if (sessionId) metadata.sessionId = sessionId;
      if (response.result.task_id !== metadata.taskId) {
        throw new Error(`Agent returned task_id ${String(response.result.task_id)}; expected ${String(metadata.taskId)}`);
      }

      if (metadata.mode === "work"
        && response.result.outcome === "completed"
        && metadata.taskId
        && this.config.roadmap.provider === "internal") {
        try {
          const store = createRoadmapStore({
            root: workspaceRoot,
            memoryRoot: this.journal.memoryRoot,
            config: this.config.roadmap,
          });
          const current = await store.list();
          if (current.tasks.some((task) => task.id === metadata.taskId)) {
            const roadmap = await store.setCompletion({
              taskId: metadata.taskId,
              completed: true,
              expectedRevision: current.revision,
            });
            if (roadmap.completion === "updated" && response.result.files_changed.length < 30) {
              response = {
                ...response,
                result: {
                  ...response.result,
                  files_changed: [
                    ...response.result.files_changed,
                    { path: this.config.roadmap.path, change: `Marked ${metadata.taskId} complete after the successful work run.` },
                  ],
                },
              };
            }
          }
        } catch (error) {
          if (!(error instanceof RoadmapStoreError && ["not_found", "unavailable"].includes(error.code))) throw error;
        }
      }

      const after = await gitSnapshot(workspaceRoot);
      if (metadata.mode === "review" && before.fingerprint !== after.fingerprint) {
        response = reviewViolation(response);
      }
      metadata.status = statusFor(response.result);
      metadata.finishedAt = new Date().toISOString();
      metadata.gitAfter = snapshotLabel(after);
      if (response.usage) metadata.usage = response.usage;
      if (response.model) metadata.model = response.model;
      await broker?.stop();
      if (isolation) await this.isolation.retain(isolation);
      await this.journal.complete(runDirectory, metadata, response);
      resultRecorded = true;
      await refreshMemory(this.journal, this.root);
      return { result: response.result, metadata, runDirectory };
    } catch (error) {
      if (resultRecorded) throw new Error(`Run ${runId} is recorded, but project-state refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      metadata.status = "failed";
      metadata.finishedAt = new Date().toISOString();
      metadata.gitAfter = snapshotLabel(await gitSnapshot(workspaceRoot));
      try { await broker?.stop(); } catch { /* Preserve the original run failure. */ }
      if (isolation) await this.isolation.retain(isolation, true);
      await this.journal.fail(runDirectory, metadata, error);
      await refreshMemory(this.journal, this.root);
      throw error;
    }
  }
}

// Identity of an interactive Claude Code host. A child agent CLI must start its
// own session rather than attach to, or impersonate, the orchestrating one.
const HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
];

function managedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of HOST_SESSION_VARIABLES) delete environment[name];
  return environment;
}

function followUpPacket(sourcePrompt: string, taskId: string | null): ContextPacket {
  const expandedPrompt = `[FOLLOW-UP]\n${taskId ? `TASK: ${taskId}\n` : ""}${sourcePrompt}\n\n`
    + "The rules from the first message of this session still apply. Return only one JSON object matching the supplied schema.";
  return {
    taskId,
    sourcePrompt,
    expandedPrompt,
    includedFiles: [],
    omittedFiles: [],
    inputCharacters: expandedPrompt.length,
    estimatedInputTokens: estimateTokens(expandedPrompt),
  };
}

function statusFor(result: AgentResult): RunStatus {
  return result.outcome;
}

function reviewViolation(response: AdapterResponse): AdapterResponse {
  return {
    ...response,
    result: {
      ...response.result,
      outcome: "failed",
      summary: `${response.result.summary} Review-mode violation: the repository changed during this run.`.slice(0, 1000),
      blockers: [...response.result.blockers, "Review-mode run changed the repository; inspect and revert manually if needed."],
    },
  };
}

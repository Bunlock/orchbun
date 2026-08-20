import path from "node:path";
import type { OrchbunConfig } from "./config.js";
import { memoryRoot } from "./config.js";
import { buildContextPacket } from "./context.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { OpenRouterAdapter } from "./adapters/openrouter.js";
import type { AgentAdapter, AdapterResponse } from "./adapters/base.js";
import { gitSnapshot, snapshotLabel } from "./git.js";
import { RunJournal } from "./journal.js";
import { rebuildMemory } from "./memory.js";
import { completeRoadmapTask } from "./roadmap.js";
import type { AgentKind, AgentResult, ContextPacket, RunMetadata, RunMode, RunStatus } from "./types.js";
import { contentHash, newRunId } from "./utils.js";
import { IsolationManager, RuntimeBroker } from "./isolation.js";
import type { WorktreeIsolation } from "./types.js";

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
    await this.journal.initialize();
    await rebuildMemory(this.journal, this.root);
    return buildContextPacket(this.root, this.config, {
      sourcePrompt: options.sourcePrompt,
      taskId: options.taskId,
      mode: options.mode,
      contextFiles: options.contextFiles,
      allowDelegation: options.mode === "work" && options.depth < this.config.delegation.maxDepth,
      runtimeAvailable,
    }, workspaceRoot);
  }

  async run(options: RunOptions): Promise<CompletedRun> {
    if (options.depth > this.config.delegation.maxDepth) {
      throw new Error(`Delegation depth ${options.depth} exceeds maximum ${this.config.delegation.maxDepth}`);
    }
    if (options.parentRunId && options.depth < 1) throw new Error("A child run must have depth 1 or greater");
    if (options.agent === "openrouter" && options.mode === "work") {
      throw new Error("OpenRouter cannot use work mode because it has no local file tools");
    }

    const runId = newRunId(options.agent);
    const createsIsolation = !options.isolation && options.mode === "work" && this.config.isolation.enabled;
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
    const packet = preparedPacket ?? await this.context({ ...options, ...(isolation ? { isolation } : {}) }, workspaceRoot);
    const before = await gitSnapshot(workspaceRoot);
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
      gitBefore: snapshotLabel(before),
      ...(isolation ? { isolation } : {}),
    };
    const runDirectory = await this.journal.begin(metadata, packet);

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ORCHBUN_ROOT: this.root,
      ORCHBUN_RUN_ID: runId,
      ORCHBUN_TASK_ID: options.taskId ?? "",
      ORCHBUN_DEPTH: String(options.depth),
      ORCHBUN_MODE: options.mode,
      ...(isolation ? {
        ...this.isolation.environment(isolation),
        ORCHBUN_BASE_COMMIT: isolation.baseCommit,
        ORCHBUN_RUNTIME_DRIVER: isolation.runtime.driver,
        ORCHBUN_RUNTIME_STATE: isolation.runtime.state,
        ORCHBUN_COMPOSE_PROJECT: isolation.runtime.project ?? "",
      } : {}),
    };
    let broker: RuntimeBroker | undefined;

    try {
      if (isolation) await this.isolation.markRunning(isolation);
      if (isolation?.runtime.driver === "compose" && isolation.runtime.state === "ready") {
        broker = new RuntimeBroker(this.isolation, isolation);
        const access = await broker.start();
        environment.ORCHBUN_RUNTIME_SOCKET = access.socketPath;
        environment.ORCHBUN_RUNTIME_TOKEN = access.token;
        environment.DOCKER_HOST = "unix:///nonexistent/orchbun-managed-docker.sock";
      }
      let response = await this.adapters[options.agent].execute(packet, {
        controlRoot: this.root,
        root: workspaceRoot,
        temporaryDir: path.join(this.journal.memoryRoot, "tmp"),
        mode: options.mode,
        environment,
        maxOutputTokens: this.config.budgets.maxOutputTokens,
        ...(model ? { model } : {}),
      });
      if (response.result.task_id !== options.taskId) {
        throw new Error(`Agent returned task_id ${String(response.result.task_id)}; expected ${String(options.taskId)}`);
      }

      if (options.mode === "work" && response.result.outcome === "completed" && options.taskId) {
        const roadmap = await completeRoadmapTask(workspaceRoot, options.taskId);
        if (roadmap === "updated" && response.result.files_changed.length < 30) {
          response = {
            ...response,
            result: {
              ...response.result,
              files_changed: [
                ...response.result.files_changed,
                { path: "ROADMAP.md", change: `Marked ${options.taskId} complete after the successful work run.` },
              ],
            },
          };
        }
      }

      const after = await gitSnapshot(workspaceRoot);
      if (options.mode === "review" && before.fingerprint !== after.fingerprint) {
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
      await rebuildMemory(this.journal, this.root);
      return { result: response.result, metadata, runDirectory };
    } catch (error) {
      metadata.status = "failed";
      metadata.finishedAt = new Date().toISOString();
      metadata.gitAfter = snapshotLabel(await gitSnapshot(workspaceRoot));
      try { await broker?.stop(); } catch { /* Preserve the original run failure. */ }
      if (isolation) await this.isolation.retain(isolation, true);
      await this.journal.fail(runDirectory, metadata, error);
      await rebuildMemory(this.journal, this.root);
      throw error;
    }
  }
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

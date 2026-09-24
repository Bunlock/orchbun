import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrchbunConfig } from "./config.js";
import { refreshMemory } from "./memory-refresh.js";
import type { Orchestrator, RunOptions } from "./orchestrator.js";
import { TERMINAL_RUN_STATUSES, type AgentResult, type RunMetadata, type RunStatus } from "./types.js";

/** Starts `orchbun runs execute --run ID` as a detached process and returns its pid. */
export type WorkerLauncher = (root: string, runId: string, logPath: string) => Promise<number>;

export interface RunView {
  run_id: string;
  status: RunStatus;
  agent: RunMetadata["agent"];
  mode: RunMetadata["mode"];
  task_id: string | null;
  parent_run_id: string | null;
  resumes_run_id: string | null;
  can_follow_up: boolean;
  started_at: string;
  finished_at: string | null;
  workspace: { path: string; branch: string } | null;
  run_directory: string;
  summary: string | null;
  result?: AgentResult;
  error?: string;
}

export interface WaitResult {
  finished: RunView[];
  running: RunView[];
  timed_out: boolean;
}

const WORKER_FILE = "worker.json";
const CLI_PATH = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));

/**
 * Background runs for an orchestrating session. Each run is prepared (validated,
 * isolated, recorded) in the caller's process, then executed by a detached worker.
 * The run journal stays the single source of truth for status and results.
 */
export class RunControl {
  constructor(
    private readonly root: string,
    private readonly config: OrchbunConfig,
    readonly orchestrator: Orchestrator,
    private readonly launch: WorkerLauncher = launchWorker,
    private readonly pollMs = 1_000,
  ) {}

  async start(options: RunOptions): Promise<RunView> {
    if (options.mode === "work" && !options.isolation && !this.config.isolation.enabled) {
      throw new Error("Background work runs need isolation.enabled: true in orchbun.yaml so parallel agents never share one checkout");
    }
    const active = await this.activeRuns();
    if (active.length >= this.config.delegation.maxConcurrent) {
      throw new Error(`${active.length} background runs are active; delegation.maxConcurrent is ${this.config.delegation.maxConcurrent}. Wait for one to finish.`);
    }
    const prepared = await this.orchestrator.prepare(options);
    const pid = await this.launch(this.root, prepared.metadata.runId, path.join(prepared.runDirectory, "worker.log"));
    await writeFile(path.join(prepared.runDirectory, WORKER_FILE), `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`);
    return this.status(prepared.metadata.runId);
  }

  /** Continues a finished run's provider session in the same workspace. */
  async send(runId: string, prompt: string): Promise<RunView> {
    const previous = await this.metadata(runId);
    if (!isTerminal(previous.status)) throw new Error(`Run ${runId} is ${previous.status}; wait for it to finish before sending a follow-up`);
    if (!previous.sessionId) throw new Error(`Run ${runId} has no provider session to continue`);
    const sessionId = previous.sessionId;
    if ((await this.activeRuns()).some((run) => run.resumeSessionId === sessionId)) {
      throw new Error(`A follow-up to the session of ${runId} is already running`);
    }
    let isolation = previous.isolation;
    if (isolation && !isolation.inherited) {
      isolation = await this.orchestrator.isolation.read(isolation.leaseId);
      if (isolation.lifecycle === "cleaned") throw new Error(`The workspace of ${runId} was cleaned up; start a new run instead`);
    }
    return this.start({
      agent: previous.agent,
      mode: previous.mode,
      sourcePrompt: prompt,
      taskId: previous.taskId,
      parentRunId: previous.parentRunId,
      depth: previous.depth,
      contextFiles: [],
      ...(previous.model ? { model: previous.model } : {}),
      ...(isolation ? { isolation } : {}),
      resume: { runId, sessionId },
    });
  }

  async status(runId: string): Promise<RunView> {
    return this.view(await this.metadata(runId), true);
  }

  async list(limit = 20): Promise<RunView[]> {
    // Run ids sort by second only; the recorded start time orders runs started within the same second.
    const directories = (await this.orchestrator.journal.allRunDirectories()).slice(-limit);
    const runs = await Promise.all(directories.map((directory) => this.reconcile(directory)));
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return Promise.all(runs.map((metadata) => this.view(metadata, false)));
  }

  /** Waits until any (or all) of the runs finish, or until the timeout elapses. */
  async wait(runIds: readonly string[], options: { all?: boolean; timeoutMs?: number } = {}): Promise<WaitResult> {
    if (!runIds.length) throw new Error("At least one run id is required");
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
    while (true) {
      const views = await Promise.all(runIds.map((runId) => this.status(runId)));
      const finished = views.filter((view) => isTerminal(view.status));
      const running = views.filter((view) => !isTerminal(view.status));
      const done = options.all ? running.length === 0 : finished.length > 0;
      if (done || Date.now() >= deadline) return { finished, running, timed_out: !done };
      await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async cancel(runId: string): Promise<RunView> {
    const directory = this.orchestrator.runDirectory(runId);
    const metadata = await this.reconcile(directory);
    if (isTerminal(metadata.status)) return this.view(metadata, true);
    const pid = await workerPid(directory);
    if (pid === null) throw new Error(`Run ${runId} was not started in the background; stop its process directly`);
    await stopProcessGroup(pid);
    await this.interrupt(directory, "Cancelled by the orchestrating session.");
    return this.status(runId);
  }

  private async metadata(runId: string): Promise<RunMetadata> {
    return this.reconcile(this.orchestrator.runDirectory(runId));
  }

  private async activeRuns(): Promise<RunMetadata[]> {
    const active: RunMetadata[] = [];
    for (const directory of await this.orchestrator.journal.allRunDirectories()) {
      const metadata = await this.reconcile(directory);
      if (!isTerminal(metadata.status) && await workerPid(directory) !== null) active.push(metadata);
    }
    return active;
  }

  /** A background run whose worker died without recording a result becomes interrupted. */
  private async reconcile(directory: string): Promise<RunMetadata> {
    const metadata = await this.orchestrator.journal.readMetadata(directory);
    if (isTerminal(metadata.status)) return metadata;
    const pid = await workerPid(directory);
    if (pid === null || processAlive(pid)) return metadata;
    return this.interrupt(directory, "The background worker exited without recording a result; see worker.log.");
  }

  private async interrupt(directory: string, reason: string): Promise<RunMetadata> {
    const journal = this.orchestrator.journal;
    const metadata = await journal.withProjectionLock(async () => {
      const current = await journal.readMetadata(directory);
      if (isTerminal(current.status)) return current;
      current.status = "interrupted";
      current.finishedAt = new Date().toISOString();
      await journal.failUnlocked(directory, current, new Error(reason));
      return current;
    });
    if (metadata.status === "interrupted" && metadata.isolation && !metadata.isolation.inherited) {
      await this.orchestrator.isolation.retain(await this.orchestrator.isolation.read(metadata.isolation.leaseId), true);
    }
    await refreshMemory(journal, this.root);
    return metadata;
  }

  private async view(metadata: RunMetadata, detailed: boolean): Promise<RunView> {
    const directory = this.orchestrator.runDirectory(metadata.runId);
    const result = isTerminal(metadata.status)
      ? await readOptional(path.join(directory, "result.json")).then((text) => text ? JSON.parse(text) as AgentResult : undefined)
      : undefined;
    const error = metadata.status === "failed" || metadata.status === "interrupted"
      ? (await readOptional(path.join(directory, "error.txt")))?.split("\n", 1)[0]
      : undefined;
    return {
      run_id: metadata.runId,
      status: metadata.status,
      agent: metadata.agent,
      mode: metadata.mode,
      task_id: metadata.taskId,
      parent_run_id: metadata.parentRunId,
      resumes_run_id: metadata.resumesRunId ?? null,
      can_follow_up: isTerminal(metadata.status) && Boolean(metadata.sessionId),
      started_at: metadata.startedAt,
      finished_at: metadata.finishedAt,
      workspace: metadata.isolation ? { path: metadata.isolation.workspaceRoot, branch: metadata.isolation.branch } : null,
      run_directory: directory,
      summary: result?.summary ?? null,
      ...(detailed && result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

async function launchWorker(root: string, runId: string, logPath: string): Promise<number> {
  const log = await open(logPath, "a");
  try {
    // The worker reuses this process's Node flags (for example a TypeScript loader);
    // keeping the caller's cwd lets those flags resolve exactly as they did here.
    const child = spawn(process.execPath, [...process.execArgv, CLI_PATH, "runs", "execute", "--run", runId, "--root", root], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: process.env,
    });
    await once(child, "spawn");
    child.unref();
    if (!child.pid) throw new Error(`Could not start the background worker for ${runId}`);
    return child.pid;
  } finally {
    await log.close();
  }
}

async function workerPid(directory: string): Promise<number | null> {
  const text = await readOptional(path.join(directory, WORKER_FILE));
  if (!text) return null;
  const pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The worker leads its own process group, so the agent CLI it started stops with it. */
async function stopProcessGroup(pid: number): Promise<void> {
  const signal = (name: NodeJS.Signals): void => {
    try { process.kill(-pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  for (let attempt = 0; attempt < 50 && processAlive(pid); attempt += 1) await delay(100);
  if (processAlive(pid)) signal("SIGKILL");
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

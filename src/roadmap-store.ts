import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadRoadmap,
  projectMarkdownPath,
  setRoadmapTaskCompletion,
  type RoadmapTask,
} from "./roadmap.js";
import { contentHash } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TASKS = 10_000;
const MAX_ID_CHARS = 256;
const MAX_TITLE_CHARS = 4_000;
const MAX_REVISION_CHARS = 1_024;

export type RoadmapConfiguration =
  | { provider: "internal"; path: string }
  | { provider: "external"; name: string; command: string[] };

export type RoadmapProvider = RoadmapConfiguration["provider"];
export type RoadmapFreshness = "fresh" | "stale";
export type RoadmapCompletion = "updated" | "unchanged";
export type RoadmapErrorCode = "conflict" | "not_found" | "unauthorized" | "unavailable" | "invalid_request";

export interface RoadmapSourceIdentity {
  provider: RoadmapProvider;
  /** Stable for one configured source. Display-name changes intentionally create a new external identity. */
  identity: string;
  label: string;
  /** Project-relative Markdown path or external executable name. */
  artifact: string;
}

export interface RoadmapSnapshot {
  source: RoadmapSourceIdentity;
  revision: string;
  freshness: RoadmapFreshness;
  tasks: RoadmapTask[];
  activeMilestone: string | null;
  /** Null for reads; populated by setCompletion. */
  completion: RoadmapCompletion | null;
}

export interface RoadmapStore {
  list(options?: { allowStale?: boolean }): Promise<RoadmapSnapshot>;
  setCompletion(input: {
    taskId: string;
    completed: boolean;
    expectedRevision: string;
  }): Promise<RoadmapSnapshot>;
}

export interface CreateRoadmapStoreOptions {
  root: string;
  memoryRoot: string;
  config: RoadmapConfiguration;
  /** Configuration previews can disable cache publication while still exercising the provider. */
  cacheWrites?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class RoadmapStoreError extends Error {
  readonly code: RoadmapErrorCode;

  constructor(code: RoadmapErrorCode, message: string) {
    super(message);
    this.name = "RoadmapStoreError";
    this.code = code;
  }
}

export class RoadmapConflictError extends RoadmapStoreError {
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;

  constructor(message: string, expectedRevision: string | null, actualRevision: string | null = null) {
    super("conflict", message);
    this.name = "RoadmapConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function createRoadmapStore(options: CreateRoadmapStoreOptions): RoadmapStore {
  const root = path.resolve(options.root);
  const memoryRoot = path.resolve(options.memoryRoot);
  const cacheWrites = options.cacheWrites ?? true;
  if (options.config.provider === "internal") {
    return new InternalRoadmapStore(root, validateInternalConfiguration(root, options.config));
  }
  const config = validateExternalConfiguration(options.config);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  return new ExternalRoadmapStore(root, memoryRoot, config, cacheWrites, timeoutMs, maxOutputBytes);
}

class InternalRoadmapStore implements RoadmapStore {
  readonly #root: string;
  readonly #path: string;
  readonly #source: RoadmapSourceIdentity;

  constructor(root: string, relativePath: string) {
    this.#root = root;
    this.#path = relativePath;
    this.#source = {
      provider: "internal",
      identity: `internal:${relativePath}`,
      label: relativePath,
      artifact: relativePath,
    };
  }

  async list(): Promise<RoadmapSnapshot> {
    try {
      const state = await loadRoadmap(this.#root, this.#path);
      return {
        source: { ...this.#source },
        revision: state.hash,
        freshness: "fresh",
        tasks: cloneTasks(state.tasks),
        activeMilestone: state.activeMilestone,
        completion: null,
      };
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new RoadmapStoreError("unavailable", `Internal roadmap does not exist: ${this.#path}`);
      }
      throw error;
    }
  }

  async setCompletion(input: {
    taskId: string;
    completed: boolean;
    expectedRevision: string;
  }): Promise<RoadmapSnapshot> {
    validateCompletionInput(input);
    const result = await setRoadmapTaskCompletion(
      this.#root,
      input.taskId,
      input.completed,
      this.#path,
      input.expectedRevision,
    );
    if (result === "conflict") {
      const actual = await this.list();
      throw new RoadmapConflictError(
        `Roadmap revision changed before ${input.taskId} could be updated`,
        input.expectedRevision,
        actual.revision,
      );
    }
    if (result === "not-found") {
      throw new RoadmapStoreError("not_found", `Roadmap task was not found: ${input.taskId}`);
    }
    if (result === "missing") {
      throw new RoadmapStoreError("unavailable", `Internal roadmap does not exist: ${this.#path}`);
    }
    const snapshot = await this.list();
    return { ...snapshot, completion: result === "updated" ? "updated" : "unchanged" };
  }
}

class ExternalRoadmapStore implements RoadmapStore {
  readonly #root: string;
  readonly #source: RoadmapSourceIdentity;
  readonly #command: string[];
  readonly #cacheFile: string;
  readonly #cacheWrites: boolean;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  #lastFresh: RoadmapSnapshot | null = null;

  constructor(
    root: string,
    memoryRoot: string,
    config: Extract<RoadmapConfiguration, { provider: "external" }>,
    cacheWrites: boolean,
    timeoutMs: number,
    maxOutputBytes: number,
  ) {
    this.#root = root;
    this.#command = [...config.command];
    const identityHash = contentHash(JSON.stringify({ name: config.name, command: config.command }));
    this.#source = {
      provider: "external",
      identity: `external:${identityHash}`,
      label: config.name,
      artifact: config.command[0]!,
    };
    this.#cacheFile = path.join(memoryRoot, "cache", "roadmap", `${identityHash}.json`);
    this.#cacheWrites = cacheWrites;
    this.#timeoutMs = timeoutMs;
    this.#maxOutputBytes = maxOutputBytes;
  }

  async list(options: { allowStale?: boolean } = {}): Promise<RoadmapSnapshot> {
    try {
      const output = await this.#request({ schema_version: "1.0", operation: "list" });
      const snapshot = this.#validateSnapshot(output, false);
      await this.#acceptFresh(snapshot);
      return snapshot;
    } catch (error) {
      if (options.allowStale && isUnavailable(error)) {
        const cached = await this.#readCache();
        if (cached) return { ...cached, freshness: "stale", completion: null };
      }
      throw error;
    }
  }

  async setCompletion(input: {
    taskId: string;
    completed: boolean;
    expectedRevision: string;
  }): Promise<RoadmapSnapshot> {
    validateCompletionInput(input);
    const output = await this.#request({
      schema_version: "1.0",
      operation: "set_completion",
      task_id: input.taskId,
      completed: input.completed,
      expected_revision: input.expectedRevision,
    }, input.expectedRevision);
    const snapshot = this.#validateSnapshot(output, true);
    const selected = snapshot.tasks.find((task) => task.id === input.taskId);
    if (!selected) {
      throw new RoadmapStoreError("invalid_request", "External roadmap completion response omitted the updated task");
    }
    if (selected.completed !== input.completed) {
      throw new RoadmapStoreError("invalid_request", "External roadmap completion response did not apply the requested state");
    }
    await this.#acceptFresh(snapshot);
    return snapshot;
  }

  async #request(request: ExternalRequest, expectedRevision: string | null = null): Promise<unknown> {
    const result = await runExternalCommand(
      this.#command,
      this.#root,
      request,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        const detail = result.stderr.trim().slice(0, 500);
        throw new RoadmapStoreError(
          "unavailable",
          `External roadmap provider exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        );
      }
      throw new RoadmapStoreError("invalid_request", "External roadmap provider returned invalid JSON");
    }
    const structured = providerError(parsed, expectedRevision);
    if (structured) throw structured;
    if (result.exitCode !== 0) {
      throw new RoadmapStoreError("unavailable", `External roadmap provider exited with code ${result.exitCode}`);
    }
    return parsed;
  }

  #validateSnapshot(value: unknown, requireCompletion: boolean): RoadmapSnapshot {
    const record = requireRecord(value, "External roadmap response");
    if (record.schema_version !== "1.0") {
      throw new RoadmapStoreError("invalid_request", "External roadmap response must use schema_version 1.0");
    }
    const revision = boundedString(record.revision, "revision", MAX_REVISION_CHARS);
    if (!Array.isArray(record.tasks)) {
      throw new RoadmapStoreError("invalid_request", "External roadmap response tasks must be an array");
    }
    if (record.tasks.length > MAX_TASKS) {
      throw new RoadmapStoreError("invalid_request", `External roadmap response exceeds ${MAX_TASKS} tasks`);
    }
    const seen = new Set<string>();
    const milestoneTitles = new Map<string, string>();
    const tasks = record.tasks.map((candidate, order): RoadmapTask => {
      const task = requireRecord(candidate, `tasks[${order}]`);
      const id = boundedString(task.id, `tasks[${order}].id`, MAX_ID_CHARS);
      const title = boundedString(task.title, `tasks[${order}].title`, MAX_TITLE_CHARS);
      const milestone = boundedString(task.milestone_id, `tasks[${order}].milestone_id`, MAX_ID_CHARS);
      const milestoneTitle = boundedString(task.milestone_title, `tasks[${order}].milestone_title`, MAX_TITLE_CHARS);
      if (typeof task.completed !== "boolean") {
        throw new RoadmapStoreError("invalid_request", `tasks[${order}].completed must be a boolean`);
      }
      if (seen.has(id)) {
        throw new RoadmapStoreError("invalid_request", `External roadmap response contains duplicate task id: ${id}`);
      }
      seen.add(id);
      const priorTitle = milestoneTitles.get(milestone);
      if (priorTitle !== undefined && priorTitle !== milestoneTitle) {
        throw new RoadmapStoreError("invalid_request", `Milestone ${milestone} has inconsistent titles`);
      }
      milestoneTitles.set(milestone, milestoneTitle);
      return { id, title, completed: task.completed, milestone, milestoneTitle, order };
    });
    let completion: RoadmapCompletion | null = null;
    if (requireCompletion) {
      if (record.result !== "updated" && record.result !== "unchanged") {
        throw new RoadmapStoreError("invalid_request", "Completion response result must be updated or unchanged");
      }
      completion = record.result;
    }
    return {
      source: { ...this.#source },
      revision,
      freshness: "fresh",
      tasks,
      activeMilestone: tasks.find((task) => !task.completed)?.milestone ?? null,
      completion,
    };
  }

  async #acceptFresh(snapshot: RoadmapSnapshot): Promise<void> {
    if (this.#lastFresh) assertRevisionIntegrity(this.#lastFresh, snapshot);
    const cached = await this.#readCache();
    if (cached) assertRevisionIntegrity(cached, snapshot);
    const neutral = { ...snapshot, completion: null };
    if (this.#cacheWrites) await this.#writeCache(neutral);
    this.#lastFresh = neutral;
  }

  async #readCache(): Promise<RoadmapSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.#cacheFile, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const parsed = requireRecord(JSON.parse(raw) as unknown, "Roadmap cache");
      if (parsed.cache_schema !== "1.0" || parsed.source_identity !== this.#source.identity) return null;
      const snapshot = this.#validateSnapshot(parsed, false);
      return { ...snapshot, freshness: "stale", completion: null };
    } catch (error) {
      if (error instanceof RoadmapStoreError || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async #writeCache(snapshot: RoadmapSnapshot): Promise<void> {
    const directory = path.dirname(this.#cacheFile);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.#cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    const payload = {
      cache_schema: "1.0",
      schema_version: "1.0",
      source_identity: this.#source.identity,
      revision: snapshot.revision,
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        completed: task.completed,
        milestone_id: task.milestone,
        milestone_title: task.milestoneTitle,
      })),
    };
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#cacheFile);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

interface ExternalRequest {
  schema_version: "1.0";
  operation: "list" | "set_completion";
  task_id?: string;
  completed?: boolean;
  expected_revision?: string;
}

interface ExternalResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runExternalCommand(
  command: string[],
  cwd: string,
  request: ExternalRequest,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ExternalResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      settleReject(new RoadmapStoreError("unavailable", `External roadmap provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      settleReject(new RoadmapStoreError("unavailable", `Could not start external roadmap provider: ${error.message}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        settleReject(new RoadmapStoreError("invalid_request", `External roadmap provider stdout exceeds ${maxOutputBytes} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        settleReject(new RoadmapStoreError("invalid_request", `External roadmap provider stderr exceeds ${maxOutputBytes} bytes`));
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function providerError(value: unknown, expectedRevision: string | null): RoadmapStoreError | null {
  if (!isRecord(value) || value.error === undefined) return null;
  if (value.schema_version !== "1.0") {
    return new RoadmapStoreError("invalid_request", "External roadmap error must use schema_version 1.0");
  }
  const error = requireRecord(value.error, "External roadmap error");
  const code = error.code;
  if (code !== "conflict" && code !== "not_found" && code !== "unauthorized" && code !== "unavailable" && code !== "invalid_request") {
    return new RoadmapStoreError("invalid_request", "External roadmap provider returned an unknown error code");
  }
  const message = boundedString(error.message, "error.message", MAX_TITLE_CHARS);
  if (code === "conflict") {
    const actual = error.actual_revision === undefined
      ? null
      : boundedString(error.actual_revision, "error.actual_revision", MAX_REVISION_CHARS);
    return new RoadmapConflictError(message, expectedRevision, actual);
  }
  return new RoadmapStoreError(code, message);
}

function validateInternalConfiguration(
  root: string,
  config: Extract<RoadmapConfiguration, { provider: "internal" }>,
): string {
  try {
    const absolute = projectMarkdownPath(root, config.path);
    return path.relative(root, absolute).split(path.sep).join("/");
  } catch (error) {
    throw new RoadmapStoreError("invalid_request", error instanceof Error ? error.message : "Invalid internal roadmap path");
  }
}

function validateExternalConfiguration(
  config: Extract<RoadmapConfiguration, { provider: "external" }>,
): Extract<RoadmapConfiguration, { provider: "external" }> {
  const name = boundedString(config.name, "External roadmap name", 200);
  if (!Array.isArray(config.command) || config.command.length === 0 || config.command.length > 64) {
    throw new RoadmapStoreError("invalid_request", "External roadmap command must contain 1 to 64 arguments");
  }
  const command = config.command.map((argument, index) => {
    if (typeof argument !== "string" || !argument || argument.includes("\0") || argument.length > 4_096) {
      throw new RoadmapStoreError("invalid_request", `External roadmap command argument ${index} is invalid`);
    }
    return argument;
  });
  return { provider: "external", name, command };
}

function validateCompletionInput(input: { taskId: string; completed: boolean; expectedRevision: string }): void {
  boundedString(input.taskId, "taskId", MAX_ID_CHARS);
  boundedString(input.expectedRevision, "expectedRevision", MAX_REVISION_CHARS);
  if (typeof input.completed !== "boolean") {
    throw new RoadmapStoreError("invalid_request", "completed must be a boolean");
  }
}

function boundedString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maxChars || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RoadmapStoreError("invalid_request", `${field} must be a non-empty trimmed string of at most ${maxChars} characters`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RoadmapStoreError("invalid_request", `${field} must be a positive integer`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RoadmapStoreError("invalid_request", `${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isUnavailable(error: unknown): error is RoadmapStoreError {
  return error instanceof RoadmapStoreError && error.code === "unavailable";
}

function cloneTasks(tasks: RoadmapTask[]): RoadmapTask[] {
  return tasks.map((task) => ({ ...task }));
}

function snapshotFingerprint(snapshot: RoadmapSnapshot): string {
  return contentHash(JSON.stringify({
    source: snapshot.source.identity,
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      completed: task.completed,
      milestone: task.milestone,
      milestoneTitle: task.milestoneTitle,
      order: task.order,
    })),
  }));
}

function assertRevisionIntegrity(previous: RoadmapSnapshot, next: RoadmapSnapshot): void {
  if (previous.revision === next.revision && snapshotFingerprint(previous) !== snapshotFingerprint(next)) {
    throw new RoadmapStoreError(
      "invalid_request",
      `External roadmap provider reused revision ${next.revision} for different content`,
    );
  }
}

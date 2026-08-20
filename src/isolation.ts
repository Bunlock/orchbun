import { chmod, open, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import type { OrchbunConfig } from "./config.js";
import { pathExists } from "./config.js";
import { runProcess } from "./adapters/process.js";
import type { RuntimeIsolation, WorktreeIsolation } from "./types.js";
import { safeWorkspacePath, slug } from "./utils.js";

type ProcessRunner = typeof runProcess;
export type RuntimeCommand = "status" | "rebuild" | "logs";

export interface IsolationEnvironment {
  ORCHBUN_CONTROL_ROOT: string;
  ORCHBUN_WORKSPACE_ROOT: string;
  ORCHBUN_LEASE_ID: string;
  ORCHBUN_BRANCH: string;
  ORCHBUN_FRONTEND_PORT: string;
  ORCHBUN_BACKEND_PORT: string;
  ORCHBUN_DATABASE_PORT: string;
  ORCHBUN_FRONTEND_URL: string;
  ORCHBUN_BACKEND_URL: string;
}

export class IsolationManager {
  private readonly leasesRoot: string;
  private readonly lockPath: string;

  constructor(
    private readonly controlRoot: string,
    private readonly config: OrchbunConfig,
    private readonly run: ProcessRunner = runProcess,
    private readonly portAvailable: (port: number) => Promise<boolean> = canBind,
  ) {
    this.leasesRoot = path.join(controlRoot, config.memoryDir, "leases");
    this.lockPath = path.join(controlRoot, config.memoryDir, "locks", "isolation.lock");
  }

  async provision(runId: string, taskId: string | null): Promise<WorktreeIsolation> {
    await this.assertCleanTrackedRoot();
    const head = await this.git(["rev-parse", "HEAD"], this.controlRoot);
    const branch = `${this.config.isolation.branchPrefix}${slug(taskId ?? "work")}-${slug(runId).slice(-18)}`;
    await this.assertValidBranch(branch);
    const worktreesRoot = safeWorkspacePath(this.controlRoot, this.config.isolation.worktreeDir);
    const workspaceRoot = path.join(worktreesRoot, runId);
    if (await pathExists(workspaceRoot)) throw new Error(`Managed worktree path already exists: ${workspaceRoot}`);
    await mkdir(worktreesRoot, { recursive: true });

    const created = await this.run("git", ["worktree", "add", "-b", branch, workspaceRoot, head], this.controlRoot);
    if (created.exitCode !== 0) throw new Error(`Could not create worktree: ${created.stderr.trim() || created.stdout.trim()}`);

    const isolation: WorktreeIsolation = {
      leaseId: runId,
      inherited: false,
      controlRoot: this.controlRoot,
      workspaceRoot,
      baseCommit: head,
      branch,
      lifecycle: "provisioned",
      runtime: disabledRuntime(),
    };

    try {
      await this.withLock(async () => {
        isolation.runtime = await this.allocateRuntime(runId);
        await this.writeLease(isolation);
      });
      if (isolation.runtime.driver === "compose") {
        isolation.runtime.state = "allocated";
        await this.writeLease(isolation);
        await this.startRuntime(isolation);
      }
      return isolation;
    } catch (error) {
      isolation.lifecycle = "recovery-required";
      isolation.runtime.state = "failed";
      await this.writeLease(isolation);
      throw error;
    }
  }

  async markRunning(isolation: WorktreeIsolation): Promise<void> {
    if (isolation.inherited) return;
    isolation.lifecycle = "running";
    await this.writeLease(isolation);
  }

  async retain(isolation: WorktreeIsolation, failed = false): Promise<void> {
    if (isolation.inherited) return;
    if (isolation.runtime.driver === "compose" && isolation.runtime.state === "ready") {
      try {
        await this.stopRuntime(isolation, false);
      } catch {
        failed = true;
        isolation.runtime.state = "failed";
      }
    }
    isolation.lifecycle = failed ? "recovery-required" : "retained";
    await this.writeLease(isolation);
  }

  async list(): Promise<WorktreeIsolation[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.leasesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const leases: WorktreeIsolation[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      leases.push(JSON.parse(await readFile(path.join(this.leasesRoot, name), "utf8")) as WorktreeIsolation);
    }
    return leases;
  }

  async read(leaseId: string): Promise<WorktreeIsolation> {
    assertLeaseId(leaseId);
    try {
      return JSON.parse(await readFile(this.leasePath(leaseId), "utf8")) as WorktreeIsolation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown isolation lease: ${leaseId}`);
      throw error;
    }
  }

  async cleanup(leaseId: string): Promise<WorktreeIsolation> {
    return this.withLock(async () => {
      const isolation = await this.read(leaseId);
      if (isolation.lifecycle === "cleaned") return isolation;
      this.assertManagedIsolation(isolation);
      const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], isolation.workspaceRoot);
      if (status.trim()) throw new Error(`Worktree ${leaseId} has uncommitted files; cleanup refused`);
      const merged = await this.run("git", ["merge-base", "--is-ancestor", isolation.branch, "HEAD"], this.controlRoot);
      if (merged.exitCode !== 0) throw new Error(`Branch ${isolation.branch} is not merged into the control checkout; cleanup refused`);
      if (isolation.runtime.driver === "compose") await this.stopRuntime(isolation, true);
      const removed = await this.run("git", ["worktree", "remove", isolation.workspaceRoot], this.controlRoot);
      if (removed.exitCode !== 0) throw new Error(`Could not remove worktree: ${removed.stderr.trim() || removed.stdout.trim()}`);
      const branchRemoved = await this.run("git", ["branch", "-d", isolation.branch], this.controlRoot);
      if (branchRemoved.exitCode !== 0) throw new Error(`Could not remove branch: ${branchRemoved.stderr.trim() || branchRemoved.stdout.trim()}`);
      isolation.lifecycle = "cleaned";
      isolation.runtime.state = isolation.runtime.driver === "none" ? "disabled" : "stopped";
      await this.writeLease(isolation);
      return isolation;
    });
  }

  async runtimeCommand(isolation: WorktreeIsolation, command: RuntimeCommand): Promise<string> {
    if (isolation.runtime.driver !== "compose" || !isolation.runtime.project) {
      throw new Error("This isolation lease has no Compose runtime");
    }
    this.assertManagedIsolation(isolation);
    const prefix = composePrefix(this.config.isolation.runtime.composeFiles, isolation.runtime.project);
    const args = command === "status"
      ? [...prefix, "ps"]
      : command === "logs"
        ? [...prefix, "logs", "--no-color", "--tail", "200", ...this.config.isolation.runtime.services]
        : [...prefix, "up", "-d", "--build", ...this.config.isolation.runtime.services];
    const result = await this.run("docker", args, isolation.workspaceRoot, this.composeEnvironment(isolation));
    if (result.exitCode !== 0) throw new Error(`Runtime ${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    if (command === "rebuild" && this.config.isolation.runtime.healthUrl) {
      await waitForHealth(expandHealthUrl(this.config.isolation.runtime.healthUrl, isolation.runtime), this.config.isolation.runtime.healthTimeoutMs);
    }
    if (command === "rebuild") {
      isolation.runtime.state = "ready";
      await this.writeLease(isolation);
    }
    return `${result.stdout}${result.stderr}`.trim().slice(-32_000);
  }

  environment(isolation: WorktreeIsolation): IsolationEnvironment {
    const runtime = isolation.runtime;
    return {
      ORCHBUN_CONTROL_ROOT: isolation.controlRoot,
      ORCHBUN_WORKSPACE_ROOT: isolation.workspaceRoot,
      ORCHBUN_LEASE_ID: isolation.leaseId,
      ORCHBUN_BRANCH: isolation.branch,
      ORCHBUN_FRONTEND_PORT: String(runtime.frontendPort ?? ""),
      ORCHBUN_BACKEND_PORT: String(runtime.backendPort ?? ""),
      ORCHBUN_DATABASE_PORT: String(runtime.databasePort ?? ""),
      ORCHBUN_FRONTEND_URL: runtime.frontendUrl ?? "",
      ORCHBUN_BACKEND_URL: runtime.backendUrl ?? "",
    };
  }

  private async allocateRuntime(runId: string): Promise<RuntimeIsolation> {
    const runtime = this.config.isolation.runtime;
    if (runtime.driver === "none") return disabledRuntime();
    this.validateRuntimeConfig();
    const active = (await this.list()).filter((lease) => lease.lifecycle !== "cleaned");
    const used = new Set(active.flatMap((lease) => [
      lease.runtime.frontendPort,
      lease.runtime.backendPort,
      lease.runtime.databasePort,
    ]).filter((port): port is number => port !== null));
    const frontendPort = await availablePort(runtime.frontendPorts, used, this.portAvailable);
    used.add(frontendPort);
    const backendPort = await availablePort(runtime.backendPorts, used, this.portAvailable);
    used.add(backendPort);
    const databasePort = await availablePort(runtime.databasePorts, used, this.portAvailable);
    const project = `${slug(runtime.projectPrefix)}-${slug(runId)}`.slice(0, 63);
    return {
      driver: "compose",
      project,
      frontendPort,
      backendPort,
      databasePort,
      frontendUrl: `http://127.0.0.1:${frontendPort}`,
      backendUrl: `http://127.0.0.1:${backendPort}`,
      state: "allocated",
    };
  }

  private async startRuntime(isolation: WorktreeIsolation): Promise<void> {
    const runtime = this.config.isolation.runtime;
    const args = composePrefix(runtime.composeFiles, isolation.runtime.project!);
    args.push("up", "-d", "--build", ...runtime.services);
    const result = await this.run("docker", args, isolation.workspaceRoot, this.composeEnvironment(isolation));
    if (result.exitCode !== 0) throw new Error(`Compose startup failed: ${result.stderr.trim() || result.stdout.trim()}`);
    if (runtime.healthUrl) await waitForHealth(expandHealthUrl(runtime.healthUrl, isolation.runtime), runtime.healthTimeoutMs);
    isolation.runtime.state = "ready";
    await this.writeLease(isolation);
  }

  private async stopRuntime(isolation: WorktreeIsolation, volumes: boolean): Promise<void> {
    const args = composePrefix(this.config.isolation.runtime.composeFiles, isolation.runtime.project!);
    args.push("down", "--remove-orphans");
    if (volumes) args.push("--volumes");
    const result = await this.run("docker", args, isolation.workspaceRoot, this.composeEnvironment(isolation));
    if (result.exitCode !== 0) throw new Error(`Compose shutdown failed: ${result.stderr.trim() || result.stdout.trim()}`);
    isolation.runtime.state = "stopped";
  }

  private composeEnvironment(isolation: WorktreeIsolation): NodeJS.ProcessEnv {
    const runtime = this.config.isolation.runtime;
    return {
      ...process.env,
      [runtime.backendPortEnv]: String(isolation.runtime.backendPort),
      [runtime.databasePortEnv]: String(isolation.runtime.databasePort),
      [runtime.frontendUrlEnv]: isolation.runtime.frontendUrl ?? "",
      ORCHBUN_FRONTEND_PORT: String(isolation.runtime.frontendPort),
      ORCHBUN_BACKEND_URL: isolation.runtime.backendUrl ?? "",
    };
  }

  private validateRuntimeConfig(): void {
    const runtime = this.config.isolation.runtime;
    for (const file of runtime.composeFiles) safeWorkspacePath(this.controlRoot, file);
    if (!runtime.composeFiles.length) throw new Error("Compose isolation requires at least one compose file");
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(runtime.projectPrefix)) throw new Error("Invalid Compose project prefix");
    for (const [label, range] of [["frontend", runtime.frontendPorts], ["backend", runtime.backendPorts], ["database", runtime.databasePorts]] as const) {
      if (!validRange(range)) throw new Error(`Invalid ${label} port range`);
    }
  }

  private async assertCleanTrackedRoot(): Promise<void> {
    const diff = await this.run("git", ["diff", "--quiet", "HEAD", "--"], this.controlRoot);
    if (diff.exitCode === 1) throw new Error("Worktree isolation requires a clean tracked control checkout");
    if (diff.exitCode !== 0) throw new Error(`Could not inspect Git state: ${diff.stderr.trim()}`);
  }

  private async assertValidBranch(branch: string): Promise<void> {
    const result = await this.run("git", ["check-ref-format", "--branch", branch], this.controlRoot);
    if (result.exitCode !== 0) throw new Error(`Invalid managed branch name: ${branch}`);
  }

  private assertManagedIsolation(isolation: WorktreeIsolation): void {
    assertLeaseId(isolation.leaseId);
    const managedRoot = safeWorkspacePath(this.controlRoot, this.config.isolation.worktreeDir);
    const relative = path.relative(managedRoot, isolation.workspaceRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Lease worktree is outside the managed directory");
    if (!isolation.branch.startsWith(this.config.isolation.branchPrefix)) throw new Error("Lease branch is outside the managed prefix");
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const result = await this.run("git", args, cwd);
    if (result.exitCode !== 0) throw new Error(`Git command failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim();
  }

  private leasePath(leaseId: string): string {
    assertLeaseId(leaseId);
    return path.join(this.leasesRoot, `${leaseId}.json`);
  }

  private async writeLease(isolation: WorktreeIsolation): Promise<void> {
    await mkdir(this.leasesRoot, { recursive: true });
    const target = this.leasePath(isolation.leaseId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(isolation, null, 2)}\n`, "utf8");
    await import("node:fs/promises").then(({ rename }) => rename(temporary, target));
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(this.lockPath, "wx");
        await handle.writeFile(`${process.pid}\n`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw new Error("Timed out waiting for the isolation lock");
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}

export class RuntimeBroker {
  private readonly token = randomBytes(24).toString("hex");
  private readonly socketPath = path.join(osTemporaryDirectory(), `orchbun-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  private server: net.Server | undefined;

  constructor(private readonly manager: IsolationManager, private readonly isolation: WorktreeIsolation) {}

  async start(): Promise<{ socketPath: string; token: string }> {
    if (this.server) throw new Error("Runtime broker is already running");
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) socket.destroy(new Error("Runtime request is too large"));
      });
      socket.on("end", async () => {
        socket.end(`${await handleRuntimeRequest(this.manager, this.isolation, this.token, body)}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    return { socketPath: this.socketPath, token: this.token };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(this.socketPath, { force: true });
  }
}

export async function handleRuntimeRequest(
  manager: IsolationManager,
  isolation: WorktreeIsolation,
  expectedToken: string,
  body: string,
): Promise<string> {
  try {
    const request = JSON.parse(body) as { token?: unknown; command?: unknown };
    if (request.token !== expectedToken) throw new Error("Runtime broker authentication failed");
    if (!isRuntimeCommand(request.command)) throw new Error("Unsupported runtime command");
    const output = await manager.runtimeCommand(isolation, request.command);
    return JSON.stringify({ ok: true, output });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function requestRuntimeCommand(socketPath: string, token: string, command: RuntimeCommand): Promise<string> {
  if (!path.isAbsolute(socketPath)) throw new Error("Runtime broker path must be absolute");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("end", () => {
      try {
        const response = JSON.parse(body) as { ok?: unknown; output?: unknown; error?: unknown };
        if (response.ok === true) resolve(typeof response.output === "string" ? response.output : "");
        else reject(new Error(typeof response.error === "string" ? response.error : "Runtime broker request failed"));
      } catch (error) {
        reject(error);
      }
    });
    socket.end(`${JSON.stringify({ token, command })}\n`);
  });
}

export function inheritedIsolation(environment: NodeJS.ProcessEnv): WorktreeIsolation | undefined {
  const leaseId = environment.ORCHBUN_LEASE_ID;
  const workspaceRoot = environment.ORCHBUN_WORKSPACE_ROOT;
  const controlRoot = environment.ORCHBUN_CONTROL_ROOT;
  const branch = environment.ORCHBUN_BRANCH;
  if (!leaseId || !workspaceRoot || !controlRoot || !branch) return undefined;
  return {
    leaseId,
    inherited: true,
    controlRoot,
    workspaceRoot,
    baseCommit: environment.ORCHBUN_BASE_COMMIT ?? "inherited",
    branch,
    lifecycle: "running",
    runtime: {
      driver: environment.ORCHBUN_RUNTIME_DRIVER === "compose" ? "compose" : "none",
      project: environment.ORCHBUN_COMPOSE_PROJECT || null,
      frontendPort: numberOrNull(environment.ORCHBUN_FRONTEND_PORT),
      backendPort: numberOrNull(environment.ORCHBUN_BACKEND_PORT),
      databasePort: numberOrNull(environment.ORCHBUN_DATABASE_PORT),
      frontendUrl: environment.ORCHBUN_FRONTEND_URL || null,
      backendUrl: environment.ORCHBUN_BACKEND_URL || null,
      state: environment.ORCHBUN_RUNTIME_STATE === "ready" ? "ready" : "disabled",
    },
  };
}

function disabledRuntime(): RuntimeIsolation {
  return { driver: "none", project: null, frontendPort: null, backendPort: null, databasePort: null, frontendUrl: null, backendUrl: null, state: "disabled" };
}

function composePrefix(files: string[], project: string): string[] {
  return ["compose", ...files.flatMap((file) => ["-f", file]), "-p", project];
}

function validRange(range: [number, number]): boolean {
  return Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] > 0 && range[1] <= 65_535 && range[0] <= range[1];
}

async function availablePort(range: [number, number], used: Set<number>, probe: (port: number) => Promise<boolean>): Promise<number> {
  for (let port = range[0]; port <= range[1]; port += 1) {
    if (!used.has(port) && await probe(port)) return port;
  }
  throw new Error(`No available port in range ${range[0]}-${range[1]}`);
}

async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Runtime health check timed out for ${url}: ${last}`);
}

function expandHealthUrl(template: string, runtime: RuntimeIsolation): string {
  return template
    .replaceAll("{frontendPort}", String(runtime.frontendPort))
    .replaceAll("{backendPort}", String(runtime.backendPort))
    .replaceAll("{databasePort}", String(runtime.databasePort));
}

function assertLeaseId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid isolation lease id: ${value}`);
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  return value === "status" || value === "rebuild" || value === "logs";
}

function osTemporaryDirectory(): string {
  return process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : "/tmp";
}

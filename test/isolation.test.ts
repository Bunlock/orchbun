import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AdapterOptions, AdapterResponse, AgentAdapter } from "../src/adapters/base.js";
import { runProcess } from "../src/adapters/process.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { handleRuntimeRequest, IsolationManager } from "../src/isolation.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ContextPacket } from "../src/types.js";

const execute = promisify(execFile);

class RootCapturingAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  roots: string[] = [];

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    this.roots.push(options.root);
    return {
      result: {
        schema_version: "2.0",
        task_id: packet.taskId,
        prompt_intent: "Exercise isolation",
        outcome: "completed",
        summary: "The isolated run completed.",
        deliverables: [], files_changed: [], decisions: [], risks: [], blockers: [],
        open_questions: [], next_actions: [], verification: [],
      },
      nativeOutput: "{}",
      nativeFileName: "response.native.json",
    };
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd: root })).stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-isolation-"));
  await git(root, "init");
  await git(root, "config", "user.email", "tests@example.invalid");
  await git(root, "config", "user.name", "Orchbun Tests");
  await writeFile(path.join(root, ".gitignore"), "memory/\n");
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n- [ ] **ORCH-B4** Isolate work runs.\n");
  await git(root, "add", ".gitignore", "orchbun.yaml", "ROADMAP.md");
  await git(root, "commit", "-m", "fixture");
  return root;
}

function isolatedConfig() {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    isolation: { ...structuredClone(DEFAULT_CONFIG.isolation), enabled: true },
  };
}

test("top-level work runs use retained worktrees and delegates inherit them", async () => {
  const root = await repository();
  const adapter = new RootCapturingAdapter();
  const orchestrator = new Orchestrator(root, isolatedConfig(), { codex: adapter });
  const parent = await orchestrator.run({
    agent: "codex", mode: "work", sourcePrompt: "Implement B4.", taskId: "ORCH-B4",
    parentRunId: null, depth: 0, contextFiles: [],
  });
  const lease = parent.metadata.isolation;
  assert.ok(lease);
  assert.notEqual(lease.workspaceRoot, root);
  assert.equal(lease.lifecycle, "retained");
  assert.match(lease.branch, /^orchbun\/orch-b4-/);
  assert.equal(adapter.roots[0], lease.workspaceRoot);
  const recorded = await orchestrator.journal.readMetadata(parent.runDirectory);
  assert.equal(recorded.isolation?.leaseId, lease.leaseId);
  assert.equal(recorded.isolation?.runtime.state, "disabled");
  assert.match(await readFile(path.join(lease.workspaceRoot, "ROADMAP.md"), "utf8"), /- \[x\] \*\*ORCH-B4\*\*/);
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /- \[ \] \*\*ORCH-B4\*\*/);

  const child = await orchestrator.run({
    agent: "codex", mode: "review", sourcePrompt: "Review B4.", taskId: "ORCH-B4",
    parentRunId: parent.metadata.runId, depth: 1, contextFiles: [],
    isolation: { ...lease, inherited: true, lifecycle: "running" },
  });
  assert.equal(child.metadata.isolation?.workspaceRoot, lease.workspaceRoot);
  assert.equal(child.metadata.isolation?.inherited, true);
  assert.equal(adapter.roots[1], lease.workspaceRoot);
  await assert.rejects(orchestrator.isolation.cleanup(lease.leaseId), /uncommitted files/);

  await git(lease.workspaceRoot, "add", "ROADMAP.md");
  await git(lease.workspaceRoot, "commit", "-m", "complete B4");
  await git(root, "merge", "--ff-only", lease.branch);
  const cleaned = await orchestrator.isolation.cleanup(lease.leaseId);
  assert.equal(cleaned.lifecycle, "cleaned");
});

test("tracked source changes block isolated provisioning", async () => {
  const root = await repository();
  await writeFile(path.join(root, "ROADMAP.md"), "dirty\n");
  const orchestrator = new Orchestrator(root, isolatedConfig(), { codex: new RootCapturingAdapter() });
  await assert.rejects(orchestrator.run({
    agent: "codex", mode: "work", sourcePrompt: "Do work.", taskId: null,
    parentRunId: null, depth: 0, contextFiles: [],
  }), /clean tracked control checkout/);
});

test("invalid context is rejected before an isolation lease is created", async () => {
  const root = await repository();
  const orchestrator = new Orchestrator(root, isolatedConfig(), { codex: new RootCapturingAdapter() });
  await assert.rejects(orchestrator.run({
    agent: "codex", mode: "work", sourcePrompt: "Do work.", taskId: null,
    parentRunId: null, depth: 0, contextFiles: ["missing.md"],
  }), /Context file does not exist/);
  assert.deepEqual(await orchestrator.isolation.list(), []);
});

test("compose runtime receives only its allocated project and endpoint environment", async () => {
  const root = await repository();
  await writeFile(path.join(root, "docker-compose.yml"), "services: {}\n");
  await git(root, "add", "docker-compose.yml");
  await git(root, "commit", "-m", "compose fixture");
  const dockerCalls: Array<{ args: string[]; environment?: NodeJS.ProcessEnv }> = [];
  const runner: typeof runProcess = async (command, args, cwd, environment) => {
    if (command === "docker") {
      dockerCalls.push({ args, environment });
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return runProcess(command, args, cwd, environment);
  };
  const config = isolatedConfig();
  config.isolation.runtime = {
    ...config.isolation.runtime,
    driver: "compose",
    composeFiles: ["docker-compose.yml"],
    services: ["backend"],
  };
  const manager = new IsolationManager(root, config, runner, async () => true);
  const lease = await manager.provision("20260820T100000Z-codex-abc123", "ORCH-B4");
  assert.equal(lease.runtime.state, "ready");
  assert.match(lease.runtime.project ?? "", /^orchbun-/);
  assert.deepEqual(dockerCalls[0]?.args.slice(-4), ["up", "-d", "--build", "backend"]);
  assert.equal(dockerCalls[0]?.environment?.BACKEND_PORT, String(lease.runtime.backendPort));
  assert.equal(dockerCalls[0]?.environment?.FRONTEND_URL, lease.runtime.frontendUrl);
  const token = "test-token";
  assert.equal(JSON.parse(await handleRuntimeRequest(manager, lease, token, JSON.stringify({ token, command: "status" }))).ok, true);
  assert.equal(JSON.parse(await handleRuntimeRequest(manager, lease, token, JSON.stringify({ token, command: "rebuild" }))).ok, true);
  assert.equal(JSON.parse(await handleRuntimeRequest(manager, lease, token, JSON.stringify({ token, command: "logs" }))).ok, true);
  assert.match(JSON.parse(await handleRuntimeRequest(manager, lease, token, JSON.stringify({ token: "wrong", command: "status" }))).error, /authentication failed/);
  assert.equal(dockerCalls[1]?.args.includes("ps"), true);
  assert.equal(dockerCalls[2]?.args.includes("--build"), true);
  assert.equal(dockerCalls[3]?.args.includes("--tail"), true);
  await manager.retain(lease);
  assert.equal(dockerCalls[4]?.args.includes("down"), true);
  assert.equal(dockerCalls[4]?.args.includes("--volumes"), false);
});

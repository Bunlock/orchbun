import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AdapterOptions, AdapterResponse, AgentAdapter } from "../src/adapters/base.js";
import { DEFAULT_CONFIG, type OrchbunConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RunControl, type WorkerLauncher } from "../src/run-control.js";
import type { AgentKind, ContextPacket } from "../src/types.js";

const execute = promisify(execFile);
const cli = path.resolve("src/cli.ts");

class SessionAdapter implements AgentAdapter {
  readonly calls: { prompt: string; resumeSessionId?: string }[] = [];

  constructor(readonly kind: AgentKind) {}

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    this.calls.push({ prompt: packet.expandedPrompt, ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}) });
    return {
      result: {
        schema_version: "2.0", task_id: packet.taskId, prompt_intent: "Answer", outcome: "completed",
        summary: `Answered call ${this.calls.length}.`, deliverables: [], files_changed: [], decisions: [], risks: [],
        blockers: [], open_questions: [], next_actions: [], verification: [],
      },
      nativeOutput: "{}",
      nativeFileName: "response.native.json",
      sessionId: "session-1",
    };
  }
}

async function project(config: Partial<OrchbunConfig["delegation"]> = {}): Promise<{ root: string; config: OrchbunConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-runs-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  return { root, config: { ...DEFAULT_CONFIG, delegation: { ...DEFAULT_CONFIG.delegation, ...config } } };
}

/** Executes the prepared run in this process, as the detached worker would. */
function inProcessLauncher(orchestrator: Orchestrator): WorkerLauncher {
  return async (_root, runId) => {
    setImmediate(() => { void orchestrator.load(runId).then((prepared) => orchestrator.execute(prepared)); });
    return process.pid;
  };
}

/** Starts a real detached process that stands in for a worker. */
async function processLauncher(command: string, args: string[]): Promise<{ launcher: WorkerLauncher; pids: number[] }> {
  const pids: number[] = [];
  return {
    pids,
    launcher: async () => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      await once(child, "spawn");
      child.unref();
      pids.push(child.pid!);
      return child.pid!;
    },
  };
}

const request = { mode: "review" as const, taskId: null, parentRunId: null, depth: 0, contextFiles: [] };

test("a background run records its session and accepts a follow-up in the same session", async () => {
  const { root, config } = await project();
  const claude = new SessionAdapter("claude");
  const orchestrator = new Orchestrator(root, config, { claude });
  const control = new RunControl(root, config, orchestrator, inProcessLauncher(orchestrator), 10);

  const started = await control.start({ ...request, agent: "claude", sourcePrompt: "Review the parser." });
  assert.ok(["pending", "running"].includes(started.status));
  const first = await control.wait([started.run_id], { timeoutMs: 5_000 });
  assert.equal(first.timed_out, false);
  assert.equal(first.finished[0]?.status, "completed");
  assert.equal(first.finished[0]?.can_follow_up, true);
  assert.match(claude.calls[0]!.prompt, /ROLE: You are a managed agent/);

  const followUp = await control.send(started.run_id, "Now check the error path.");
  const second = await control.wait([followUp.run_id], { timeoutMs: 5_000 });
  assert.equal(second.finished[0]?.resumes_run_id, started.run_id);
  assert.equal(second.finished[0]?.result?.summary, "Answered call 2.");
  assert.equal(claude.calls[1]?.resumeSessionId, "session-1");
  assert.match(claude.calls[1]!.prompt, /^\[FOLLOW-UP\]\nNow check the error path\./);
  assert.deepEqual((await control.list()).map((run) => run.run_id), [followUp.run_id, started.run_id]);
});

test("background work runs require isolation and respect the concurrency limit", async () => {
  const { root, config } = await project({ maxConcurrent: 1 });
  const { launcher, pids } = await processLauncher("sleep", ["30"]);
  const control = new RunControl(root, config, new Orchestrator(root, config), launcher, 10);

  await assert.rejects(control.start({ ...request, mode: "work", agent: "codex", sourcePrompt: "Edit" }), /isolation.enabled/);
  const running = await control.start({ ...request, agent: "codex", sourcePrompt: "Review one" });
  await assert.rejects(control.start({ ...request, agent: "codex", sourcePrompt: "Review two" }), /maxConcurrent is 1/);
  await assert.rejects(control.send(running.run_id, "More"), /wait for it to finish/);

  const cancelled = await control.cancel(running.run_id);
  assert.equal(cancelled.status, "interrupted");
  assert.match(cancelled.error ?? "", /Cancelled by the orchestrating session/);
  assert.throws(() => process.kill(pids[0]!, 0), /ESRCH/);
});

test("a worker that exits without a result is reported as interrupted", async () => {
  const { root, config } = await project();
  const { launcher, pids } = await processLauncher("true", []);
  const control = new RunControl(root, config, new Orchestrator(root, config), launcher, 10);
  const started = await control.start({ ...request, agent: "codex", sourcePrompt: "Review" });
  while ((() => { try { process.kill(pids[0]!, 0); return true; } catch { return false; } })()) await new Promise((resolve) => setTimeout(resolve, 20));

  const waited = await control.wait([started.run_id], { timeoutMs: 2_000 });
  assert.equal(waited.finished[0]?.status, "interrupted");
  assert.match(waited.finished[0]?.error ?? "", /worker exited without recording a result/);
  await assert.rejects(control.send(started.run_id, "Retry"), /no provider session/);
});

test("the CLI runs a detached agent and resumes its session through a follow-up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-runs-cli-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "orchbun-fake-bin-"));
  const log = path.join(bin, "calls.jsonl");
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({
  schema_version: "2.0", task_id: null, prompt_intent: "Answer", outcome: "completed", summary: "Fake codex answered.",
  deliverables: [], files_changed: [], decisions: [], risks: [], blockers: [], open_questions: [], next_actions: [], verification: [],
}));
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-7" }));
`);
  await chmod(path.join(bin, "codex"), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = async (...args: string[]) => (await execute(process.execPath, ["--import", "tsx", cli, ...args, "--root", root], { env })).stdout;
  await run("init");

  const started = JSON.parse(await run("run", "--agent", "codex", "--prompt", "Review", "--detach", "--json")) as { run_id: string };
  const first = JSON.parse(await run("runs", "wait", "--run", started.run_id, "--timeout", "30", "--json")) as { status: string; summary: string };
  assert.deepEqual([first.status, first.summary], ["completed", "Fake codex answered."]);

  const followUp = JSON.parse(await run("runs", "send", "--run", started.run_id, "--prompt", "Go on", "--json")) as { run_id: string };
  assert.match(await run("runs", "wait", "--run", followUp.run_id, "--timeout", "30"), /→ completed/);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls[0]!.slice(2, 4), ["--sandbox", "read-only"]);
  assert.deepEqual(calls[1]!.slice(0, 3), ["exec", "resume", "thread-7"]);
  assert.match(calls[1]![3]!, /^\[FOLLOW-UP\]\nGo on/);
  assert.ok(calls[1]!.includes('sandbox_mode="read-only"'));
  assert.match(await run("runs", "list"), new RegExp(`${followUp.run_id}\\tcompleted`));
});

test("managed runs cannot write memory or start other runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-runs-guard-"));
  await execute(process.execPath, ["--import", "tsx", cli, "init", "--root", root]);
  await writeFile(path.join(root, "note.md"), "# Note\n");
  const env = { ...process.env, ORCHBUN_RUN_ID: "20260101T000000Z-codex-abcdef" };
  const attempt = (...args: string[]) => execute(process.execPath, ["--import", "tsx", cli, ...args, "--root", root], { env });
  await assert.rejects(attempt("memory", "record", "--file", "note.md"), /do not write Orchbun memory/);
  await assert.rejects(attempt("memory", "sweep"), /do not write Orchbun memory/);
  await assert.rejects(attempt("run", "--prompt", "Nested", "--detach"), /cannot start or steer/);
  await assert.rejects(attempt("runs", "cancel", "--run", "20260101T000000Z-codex-abcdef"), /cannot start or steer/);
  assert.match((await attempt("memory", "sweep", "--dry-run", "--json")).stdout, /"dryRun": true/);
  assert.match((await attempt("run", "--prompt", "Preview", "--dry-run")).stdout, /Verify with unit tests only/);
});

test("a work follow-up continues in the same isolated worktree", async () => {
  const { root, config: base } = await project();
  const git = (...args: string[]) => execute("git", args, { cwd: root });
  await writeFile(path.join(root, ".gitignore"), "memory/\n");
  await git("init", "-q");
  await git("-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
  await git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
  const config: OrchbunConfig = { ...base, isolation: { ...base.isolation, enabled: true } };
  const roots: string[] = [];
  const codex = new SessionAdapter("codex");
  const original = codex.execute.bind(codex);
  codex.execute = async (packet, options) => { roots.push(options.root); return original(packet, options); };
  const orchestrator = new Orchestrator(root, config, { codex });
  const control = new RunControl(root, config, orchestrator, inProcessLauncher(orchestrator), 10);

  const started = await control.start({ ...request, mode: "work", agent: "codex", sourcePrompt: "Edit" });
  await control.wait([started.run_id], { timeoutMs: 10_000 });
  const followUp = await control.send(started.run_id, "Adjust");
  const done = await control.wait([followUp.run_id], { timeoutMs: 10_000 });

  assert.equal(done.finished[0]?.status, "completed");
  assert.equal(roots.length, 2);
  assert.equal(roots[0], roots[1]);
  assert.notEqual(roots[0], root);
  assert.equal((await orchestrator.isolation.read(started.run_id)).lifecycle, "retained");
});

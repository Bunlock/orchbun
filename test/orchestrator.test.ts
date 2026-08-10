import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdapterOptions, AdapterResponse, AgentAdapter } from "../src/adapters/base.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { verifyMemory } from "../src/memory.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentKind, ContextPacket } from "../src/types.js";

class FakeAdapter implements AgentAdapter {
  capturedEnvironment?: NodeJS.ProcessEnv;

  constructor(readonly kind: AgentKind) {}

  async execute(packet: ContextPacket, options: AdapterOptions): Promise<AdapterResponse> {
    this.capturedEnvironment = options.environment;
    return {
      result: {
        schema_version: "2.0",
        task_id: packet.taskId,
        prompt_intent: `Handle ${packet.taskId ?? "request"}`,
        outcome: "completed",
        summary: `${this.kind} completed its bounded task.`,
        deliverables: [],
        files_changed: [],
        decisions: [],
        risks: [],
        blockers: [],
        open_questions: [],
        next_actions: [],
        verification: [],
      },
      nativeOutput: JSON.stringify({ provider: this.kind }),
      nativeFileName: "response.native.json",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

test("records linked parent and child runs without a provider call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-orchestrator-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  const codex = new FakeAdapter("codex");
  const claude = new FakeAdapter("claude");
  const orchestrator = new Orchestrator(root, DEFAULT_CONFIG, { codex, claude });

  const parent = await orchestrator.run({
    agent: "codex",
    mode: "work",
    sourcePrompt: "Coordinate the review.",
    taskId: "HEX-2",
    parentRunId: null,
    depth: 0,
    contextFiles: [],
  });
  const child = await orchestrator.run({
    agent: "claude",
    mode: "review",
    sourcePrompt: "Review the proposed change.",
    taskId: "HEX-2",
    parentRunId: parent.metadata.runId,
    depth: 1,
    contextFiles: [],
  });

  assert.equal(child.metadata.parentRunId, parent.metadata.runId);
  assert.equal(codex.capturedEnvironment?.ORCHBUN_MODE, "work");
  assert.equal(claude.capturedEnvironment?.ORCHBUN_DEPTH, "1");
  assert.equal(await readFile(path.join(child.runDirectory, "prompt.md"), "utf8"), "Review the proposed change.");
  assert.deepEqual(await verifyMemory(orchestrator.journal), { runs: 2, issues: [] });
});

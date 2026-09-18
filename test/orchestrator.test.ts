import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
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
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n- [ ] **HEX-2** Coordinate the review.\n");
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
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /- \[x\] \*\*HEX-2\*\*/);
  assert.deepEqual(parent.result.files_changed, [
    { path: "ROADMAP.md", change: "Marked HEX-2 complete after the successful work run." },
  ]);
  assert.equal(await readFile(path.join(child.runDirectory, "prompt.md"), "utf8"), "Review the proposed change.");
  assert.deepEqual(await verifyMemory(orchestrator.journal), {
    runs: 2, directNotes: 0, compactArchives: 0, imageGenerations: 0, issues: [],
  });
});

test("refreshes direct memory before building managed context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-orchestrator-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const directDirectory = path.join(root, "memory", "agents", "direct", "2026", "08");
  await mkdir(directDirectory, { recursive: true });
  await writeFile(path.join(directDirectory, "20260810T122000Z-direct-context.md"), `# Direct context

- **Task:** HEX-DIRECT-2
- **Outcome:** Direct memory is available to managed agents.
- **Decisions:** Include direct notes in projections.
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Context assertion.
`);
  const orchestrator = new Orchestrator(root, DEFAULT_CONFIG, { codex: new FakeAdapter("codex") });

  const packet = await orchestrator.context({
    agent: "codex",
    mode: "review",
    sourcePrompt: "Inspect unified memory.",
    taskId: "HEX-3",
    parentRunId: null,
    depth: 0,
    contextFiles: [],
  });

  assert.match(packet.expandedPrompt, /Direct memory is available to managed agents/);
  assert.ok(packet.includedFiles.includes("memory/agents/working/project-state.md"));
});

test("managed work never completes an external roadmap task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-orchestrator-external-"));
  const requestLog = path.join(root, "provider-requests.jsonl");
  const provider = path.join(root, "provider.mjs");
  await writeFile(provider, `
import { appendFileSync } from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
appendFileSync(process.argv[2], JSON.stringify(request) + "\\n");
process.stdout.write(JSON.stringify({
  schema_version: "1.0",
  revision: "external-r1",
  tasks: [{
    id: "APP-1", title: "Review external completion.", completed: false,
    milestone_id: "A", milestone_title: "Foundation"
  }]
}));
`);
  const config = {
    ...DEFAULT_CONFIG,
    roadmap: { provider: "external" as const, name: "Fixture", command: [process.execPath, provider, requestLog] },
  };
  await writeFile(path.join(root, "orchbun.yaml"), YAML.stringify(config));
  const orchestrator = new Orchestrator(root, config, { codex: new FakeAdapter("codex") });

  await orchestrator.run({
    agent: "codex", mode: "work", sourcePrompt: "Complete APP-1 locally.", taskId: "APP-1",
    parentRunId: null, depth: 0, contextFiles: [],
  });

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { operation: string });
  assert.ok(requests.length >= 1);
  assert.deepEqual(new Set(requests.map(({ operation }) => operation)), new Set(["list"]));
});

test("a refresh failure preserves an already recorded successful run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-refresh-failure-"));
  const fake = new FakeAdapter("codex");
  const orchestrator = new Orchestrator(root, DEFAULT_CONFIG, { codex: {
    kind: "codex", async execute(packet, options) {
      const result = await fake.execute(packet, options);
      const direct = path.join(root, "memory", "agents", "direct", "2026", "09");
      await mkdir(direct, { recursive: true });
      await writeFile(path.join(direct, "20260905T120000Z-bad.md"), "# Invalid external note\n");
      return result;
    },
  } });
  await assert.rejects(orchestrator.run({ agent: "codex", mode: "work", sourcePrompt: "Complete the bounded task.", taskId: null, parentRunId: null, depth: 0, contextFiles: [] }), /is recorded, but project-state refresh failed/);
  const [directory] = await orchestrator.journal.allRunDirectories();
  assert.ok(directory);
  assert.equal((await orchestrator.journal.readMetadata(directory)).status, "completed");
  assert.equal((await orchestrator.journal.readResult(directory)).outcome, "completed");
});

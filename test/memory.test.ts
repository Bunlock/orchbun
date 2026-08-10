import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { rebuildMemory, verifyMemory } from "../src/memory.js";
import type { AdapterResponse } from "../src/adapters/base.js";
import type { ContextPacket, RunMetadata } from "../src/types.js";

const validResult = {
  schema_version: "2.0",
  task_id: "HEX-1",
  prompt_intent: "Review the economy",
  outcome: "completed",
  summary: "Reviewed the economy and found no regression.",
  deliverables: [],
  files_changed: [],
  decisions: [],
  risks: [],
  blockers: [],
  open_questions: [],
  next_actions: ["Review balance constants."],
  verification: [],
};

test("journal preserves raw prompts/results and rebuilds working memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-"));
  const journal = new RunJournal(root);
  await journal.initialize();
  const metadata: RunMetadata = {
    runId: "20260810T120000Z-codex-abc123",
    parentRunId: null,
    taskId: "HEX-1",
    depth: 0,
    agent: "codex",
    mode: "review",
    status: "pending",
    startedAt: "2026-08-10T12:00:00Z",
    finishedAt: null,
    promptHash: "sha256:test",
    inputCharacters: 100,
    estimatedInputTokens: 25,
    includedFiles: [],
    omittedFiles: [],
  };
  const packet: ContextPacket = {
    taskId: "HEX-1",
    sourcePrompt: "Exact original prompt",
    expandedPrompt: "Contract\n\nExact original prompt",
    includedFiles: [],
    omittedFiles: [],
    inputCharacters: 31,
    estimatedInputTokens: 8,
  };
  const directory = await journal.begin(metadata, packet);
  metadata.status = "completed";
  metadata.finishedAt = "2026-08-10T12:01:00Z";
  const response: AdapterResponse = {
    result: await import("../src/schema.js").then(({ validateAgentResult }) => validateAgentResult(validResult)),
    nativeOutput: '{"native":true}\n',
    nativeFileName: "events.jsonl",
  };
  await journal.complete(directory, metadata, response);
  await rebuildMemory(journal);

  assert.equal(await readFile(path.join(directory, "prompt.md"), "utf8"), "Exact original prompt");
  assert.match(await readFile(path.join(root, "working", "project-state.md"), "utf8"), /Reviewed the economy/);
  assert.deepEqual(await verifyMemory(journal), { runs: 1, issues: [] });
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentResult } from "../src/schema.js";

export const validResult = {
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

test("validates the compact v2 result", async () => {
  assert.deepEqual(await validateAgentResult(validResult), validResult);
});

test("rejects oversized summaries", async () => {
  await assert.rejects(() => validateAgentResult({ ...validResult, summary: "x".repeat(1_001) }), /schema validation/);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildContextPacket } from "../src/context.js";

test("context is bounded and never scans memory/design", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-"));
  await mkdir(path.join(root, "memory", "agents", "working"), { recursive: true });
  await mkdir(path.join(root, "memory", "design"), { recursive: true });
  await writeFile(path.join(root, "memory", "agents", "working", "project-state.md"), "S".repeat(4_000));
  await writeFile(path.join(root, "memory", "design", "huge.md"), "SECRET-DESIGN".repeat(10_000));
  const config = { ...DEFAULT_CONFIG, budgets: { ...DEFAULT_CONFIG.budgets, maxInputChars: 900, maxFileChars: 700 } };
  const packet = await buildContextPacket(root, config, {
    sourcePrompt: "Review the economy.",
    taskId: "HEX-1",
    mode: "review",
    contextFiles: [],
    allowDelegation: false,
  });
  assert.ok(packet.inputCharacters <= 900);
  assert.ok(!packet.expandedPrompt.includes("SECRET-DESIGN"));
  assert.match(packet.expandedPrompt, /MODE: REVIEW/);
});

test("explicit context cannot leave the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-"));
  await assert.rejects(() => buildContextPacket(root, DEFAULT_CONFIG, {
    sourcePrompt: "Inspect",
    taskId: null,
    mode: "review",
    contextFiles: ["../outside.md"],
    allowDelegation: false,
  }), /leaves workspace/);
});

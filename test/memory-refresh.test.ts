import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { recordDirectMemory } from "../src/direct-memory.js";
import { MemoryConflict, readRefreshedMemory, refreshMemory, updateMemory } from "../src/memory-refresh.js";
import { saveMemoryOverride } from "../src/memory-overrides.js";
import { loadQualifications, saveQualification, parseRiskItems } from "../src/memory-workspace.js";
import { createMemoryServer, loadMemorySnapshot } from "../src/memory-web.js";
import { rebuildMemory } from "../src/memory.js";
import { buildContextPacket } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

const roadmap = "# Roadmap\n\n## A — Foundation\n\n- [ ] **APP-A1** Finish the first task.\n- [ ] **APP-A2** Finish the second task.\n";

async function workspace(initialize = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-refresh-"));
  await writeFile(path.join(root, "ROADMAP.md"), roadmap);
  await writeFile(path.join(root, "AGENTS.md"), "# Rules\n");
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  if (initialize) await journal.initialize();
  return { root, journal };
}

function note(outcome = "Implemented the first change.", timestamp = "2026-09-05T10:00:00Z") {
  return `# Update
- **Agent:** codex
- **Recorded at:** ${timestamp}
- **Task:** APP-A1
- **Outcome:** ${outcome}
- **Decisions:** Keep project memory local.
- **Risks or blockers:** Waiting for browser verification.
- **Next actions:** Verify APP-A1 in the browser.
- **Changed files:** src/example.ts
- **Verification:** Focused test passed.
- **Status:** active
- **Work status:** partial
`;
}

test("refresh previews and context are read-only, including on a workspace with no memory directory", async () => {
  const { root, journal } = await workspace(false);
  const before = await readdir(root);
  const memory = await refreshMemory(journal, root, false);
  assert.equal(memory.refreshedAt, null);
  assert.match(memory.projection.pages["active-tasks"], /APP-A1/);
  const config = await loadConfig(root);
  const orchestrator = new Orchestrator(root, config);
  const packet = await orchestrator.context({ agent: "codex", mode: "review", sourcePrompt: "Review the current task.", taskId: "APP-A1", parentRunId: null, depth: 0, contextFiles: [] });
  assert.match(packet.expandedPrompt, /APP-A1/);
  assert.deepEqual(await readdir(root), before);
});

test("the next publishing refresh upgrades an unchanged v1 snapshot to schema v2", async () => {
  const { root, journal } = await workspace();
  const published = await refreshMemory(journal, root);
  const statePath = path.join(journal.memoryRoot, "refresh", "state.json");
  await writeFile(statePath, `${JSON.stringify({ ...published, schemaVersion: 1 }, null, 2)}\n`);

  const upgraded = await refreshMemory(journal, root);

  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.revision, published.revision);
  assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number }).schemaVersion, 2);
});

test("an unchanged refresh prunes working Markdown outside the configured catalogue", async () => {
  const { root, journal } = await workspace();
  const published = await refreshMemory(journal, root);
  const stalePage = path.join(journal.memoryRoot, "working", "removed-process.md");
  await writeFile(stalePage, "# Removed process\n");

  const refreshed = await refreshMemory(journal, root);

  assert.equal(refreshed.revision, published.revision);
  await assert.rejects(readFile(stalePage, "utf8"), { code: "ENOENT" });
});

test("record refreshes immediately, is idempotent with explicit provenance, and preserves manual content", async () => {
  const { root, journal } = await workspace();
  const manual = "# My notes\n\nKeep the mobile experience first.\n";
  await saveMemoryOverride(journal.memoryRoot, "project-state", manual);
  const first = await recordDirectMemory(journal, root, note());
  assert.equal(first.recorded, true);
  const state = first.memory;
  assert.match(state.projection.pages["project-state"], /Implemented the first change/);
  assert.match(state.projection.pages["project-state"], /Keep the mobile experience first/);
  assert.equal(await readFile(path.join(journal.memoryRoot, "manual", "project-state.md"), "utf8"), manual);
  const again = await recordDirectMemory(journal, root, note());
  assert.equal(again.recorded, false);
  assert.equal(again.id, first.id);
  assert.equal(again.memory.revision, state.revision);
  assert.equal(again.memory.refreshedAt, state.refreshedAt);
  const working = path.join(journal.memoryRoot, "working", "project-state.md");
  const before = await stat(working);
  assert.deepEqual(await refreshMemory(journal, root), state);
  assert.equal((await stat(working)).mtimeMs, before.mtimeMs);
  assert.equal(state.projection.lastVerification?.recordedAt, "2026-09-05T10:00:00Z");
});

test("refresh reconciles external roadmap changes and avoids maintenance hooks and roadmap projection", async () => {
  const { root, journal } = await workspace();
  await writeFile(path.join(root, "orchbun.yaml"), 'version: 1\nhooks:\n  after_memory_rebuild: node -e "require(\'fs\').writeFileSync(\'hook-ran\', \'yes\')"\n');
  await recordDirectMemory(journal, root, note().replace("**Task:** APP-A1", "**Task:** Investigate startup"));
  assert.equal(await readFile(path.join(root, "ROADMAP.md"), "utf8"), roadmap);
  await assert.rejects(readFile(path.join(root, "hook-ran")), { code: "ENOENT" });
  await writeFile(path.join(root, "ROADMAP.md"), roadmap.replace("[ ] **APP-A1**", "[x] **APP-A1**"));
  const view = await loadMemorySnapshot(journal.memoryRoot, root);
  assert.equal(view.roadmap?.tasks[0]?.completed, true);
  assert.doesNotMatch(view.pages.find(page => page.id === "active-tasks")!.markdown, /\*\*APP-A1/);
  await rebuildMemory(journal, root);
  assert.equal(await readFile(path.join(root, "hook-ran"), "utf8"), "yes");
});

test("priorities, blocked tasks, and resolved risks agree across web, Markdown, and agent context", async () => {
  const { root, journal } = await workspace();
  let memory = (await recordDirectMemory(journal, root, note())).memory;
  memory = (await updateMemory(journal, root, memory.revision, async () => {
    await saveQualification(journal.memoryRoot, { kind: "task", id: "APP-A1", status: "blocked", severity: "major", urgency: "high" });
    await saveQualification(journal.memoryRoot, { kind: "risk", id: memory.projection.risks[0]!.id, status: "resolved", severity: "minor", urgency: "low" });
  })).memory;
  const view = await loadMemorySnapshot(journal.memoryRoot, root);
  assert.equal(view.revision, memory.revision);
  assert.equal(view.qualifications["task:APP-A1"]?.status, "blocked");
  const taskPage = memory.projection.pages["active-tasks"];
  assert.match(taskPage, /## Blocked\n\n- \*\*APP-A1 .*P2/);
  const riskPage = memory.projection.pages.risks;
  assert.match(riskPage, /No open risks recorded/);
  assert.match(riskPage, /## Resolved\n\n- Waiting for browser verification/);
  const packet = await buildContextPacket(root, await loadConfig(root), { sourcePrompt: "Review.", taskId: "APP-A1", mode: "review", contextFiles: [], allowDelegation: false, memoryPages: memory.projection.pages });
  assert.ok(packet.expandedPrompt.includes(taskPage.trim()));
  assert.ok(packet.expandedPrompt.includes(riskPage.trim()));
});

test("a stale edit conflicts before mutation and concurrent saves do not lose an update", async () => {
  const { root, journal } = await workspace();
  const original = await refreshMemory(journal, root);
  const saves = await Promise.allSettled(["first", "second"].map(text => updateMemory(journal, root, original.revision,
    async () => saveMemoryOverride(journal.memoryRoot, "decisions", text))));
  assert.equal(saves.filter(result => result.status === "fulfilled").length, 1);
  const rejected = saves.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof MemoryConflict);
  const saved = await readFile(path.join(journal.memoryRoot, "manual", "decisions.md"), "utf8");
  assert.ok(saved === "first\n" || saved === "second\n");
});

test("invalid source updates retain the last valid snapshot and recover after correction", async () => {
  const { root, journal } = await workspace();
  const first = (await recordDirectMemory(journal, root, note())).memory;
  const directory = path.join(journal.memoryRoot, "direct", "2026", "09");
  const bad = path.join(directory, "20260905T110000Z-invalid.md");
  await writeFile(bad, "# Incomplete external edit\n");
  await assert.rejects(refreshMemory(journal, root), /Direct memory validation failed/);
  const view = await loadMemorySnapshot(journal.memoryRoot, root);
  assert.equal(view.freshness.status, "refresh-failed");
  assert.equal(view.revision, first.revision);
  assert.deepEqual(await readRefreshedMemory(journal.memoryRoot), first);
  await rm(bad);
  assert.equal((await loadMemorySnapshot(journal.memoryRoot, root)).freshness.status, "current");
  const before = await readdir(directory);
  await assert.rejects(recordDirectMemory(journal, root, "# Missing required fields\n"), /missing fields/);
  assert.deepEqual(await readdir(directory), before);
});

test("a manual config pointing at a missing internal roadmap preserves the last published view", async () => {
  const { root, journal } = await workspace();
  const published = await refreshMemory(journal, root);
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
roadmap:
  provider: internal
  path: missing.md
`);

  await assert.rejects(refreshMemory(journal, root), /Internal roadmap does not exist: missing\.md/);
  assert.deepEqual(await readRefreshedMemory(journal.memoryRoot), published);
  const view = await loadMemorySnapshot(journal.memoryRoot, root);
  assert.equal(view.freshness.status, "refresh-failed");
  assert.match(view.freshness.error ?? "", /Internal roadmap does not exist: missing\.md/);
});

test("explicit risk identities survive wording edits", () => {
  assert.equal(parseRiskItems("- [risk:browser-check] Browser proof pending.")[0]?.id, parseRiskItems("- [risk:browser-check] Browser proof now blocked.")[0]?.id);
});

test("an interrupted working-directory swap is recovered from the last publication", async () => {
  const { root, journal } = await workspace();
  const original = await refreshMemory(journal, root);
  const token = "12345678-1234-1234-1234-123456789abc";
  const working = path.join(journal.memoryRoot, "working");
  await writeFile(path.join(working, "retained.txt"), "Preserve unrelated working metadata.");
  await rename(working, path.join(journal.memoryRoot, `.refresh-backup-${token}`));
  await mkdir(path.join(journal.memoryRoot, `.refresh-${token}`));
  await writeFile(path.join(journal.memoryRoot, "refresh", "pending.json"), JSON.stringify({ token, revision: "f".repeat(64) }));
  await assert.rejects(refreshMemory(journal, root, false), /interrupted refresh/);
  const recovered = await refreshMemory(journal, root);
  assert.equal(recovered.revision, original.revision);
  assert.equal(await readFile(path.join(working, "retained.txt"), "utf8"), "Preserve unrelated working metadata.");
  assert.equal((await readdir(journal.memoryRoot)).some(file => file.startsWith(".refresh-")), false);
});

test("web save and refresh enforce revision checks and publish one consistent task update", async t => {
  const { root, journal } = await workspace();
  const server = createMemoryServer(journal.memoryRoot, { projectRoot: root });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const snapshot = await (await fetch(`${url}/api/memory`)).json();
  const payload = { revision: snapshot.revision, kind: "task", id: "APP-A1", status: "done", severity: "major", urgency: "high" };
  const save = await fetch(`${url}/api/qualifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(save.status, 200, await save.text());
  const current = await (await fetch(`${url}/api/memory`)).json();
  assert.equal(current.roadmap.tasks[0].completed, true);
  assert.equal(current.qualifications["task:APP-A1"].status, "active");
  assert.doesNotMatch(current.pages.find((page: { id: string }) => page.id === "active-tasks").markdown, /\*\*APP-A1/);
  const stale = await fetch(`${url}/api/qualifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, status: "active" }) });
  assert.equal(stale.status, 409);
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /\[x\] \*\*APP-A1/);
});

test("legacy qualification status cannot complete an external roadmap task", async t => {
  const { root, journal } = await workspace();
  const requests = path.join(root, "provider-requests.jsonl");
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
    id: "APP-A1", title: "Finish the first task.", completed: false,
    milestone_id: "A", milestone_title: "Foundation"
  }]
}));
`);
  await writeFile(path.join(root, "orchbun.yaml"), JSON.stringify({
    version: 1,
    roadmap: { provider: "external", name: "Fixture Jira", command: [process.execPath, provider, requests] },
  }));
  const server = createMemoryServer(journal.memoryRoot, { projectRoot: root });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const snapshot = await (await fetch(`${url}/api/memory`)).json();
  const response = await fetch(`${url}/api/qualifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: snapshot.revision,
      kind: "task",
      id: "APP-A1",
      status: "done",
      severity: "major",
      urgency: "high",
    }),
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Complete external roadmap tasks with the roadmap checkbox/);
  assert.equal((await loadQualifications(journal.memoryRoot))["task:APP-A1"], undefined);
  const operations = (await readFile(requests, "utf8")).trim().split("\n")
    .map(line => (JSON.parse(line) as { operation: string }).operation);
  assert.ok(operations.length >= 1);
  assert.deepEqual(new Set(operations), new Set(["list"]));
});

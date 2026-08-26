import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { loadDirectMemory, resolveDirectMemory, type DirectMemoryNote } from "../src/direct-memory.js";
import { rebuildMemory, verifyMemory } from "../src/memory.js";
import { compactMemory } from "../src/milestone-memory.js";
import { sweepMemory } from "../src/memory-sweep.js";
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

test("memory rebuild runs the configured hook from the project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-hook-"));
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize();
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
hooks:
  after_memory_rebuild: node -e "require('node:fs').writeFileSync('hook-ran.txt', 'yes')"
`);

  await rebuildMemory(journal, root);

  assert.equal(await readFile(path.join(root, "hook-ran.txt"), "utf8"), "yes");
});

test("direct memory resolves transitive supersession before lifecycle projections", () => {
  const note = (id: string, timestamp: string, status: DirectMemoryNote["status"], supersedes: string[]): DirectMemoryNote => ({
    id,
    slug: id,
    relativePath: `direct/2026/08/${id}.md`,
    timestamp,
    task: "ORCH-M1",
    outcome: id,
    decisions: [],
    risks: [],
    nextActions: [],
    changedFiles: [],
    verification: [],
    supersedes,
    subjects: ["memory/sleep"],
    status,
  });
  const base = note("base", "2026-08-10T12:00:00Z", "active", []);
  const middle = note("middle", "2026-08-10T12:01:00Z", "superseded", ["base"]);
  const head = note("head", "2026-08-10T12:02:00Z", "active", ["middle"]);
  const retired = note("retired", "2026-08-10T12:03:00Z", "retired", []);

  const resolved = resolveDirectMemory([base, middle, head, retired]);
  assert.deepEqual(resolved.currentNotes.map((item) => item.id), ["head"]);
  assert.deepEqual([...resolved.supersededNoteIds].sort(), ["base", "middle"]);
  assert.deepEqual(resolved.lineages.get("head"), ["head", "middle", "base"]);
  assert.ok(resolved.inactiveNoteIds.has("retired"));
});

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
  const directDirectory = path.join(root, "direct", "2026", "08");
  await mkdir(directDirectory, { recursive: true });
  await writeFile(path.join(directDirectory, "20260810T120200Z-document-economy-review.md"), `# Document economy review

- **Task:** HEX-DIRECT-1
- **Outcome:** Documented the follow-up economy decision.
- **Decisions:** Keep provincial treasuries authoritative.
- **Risks or blockers:** Backend migration is still pending.
- **Next actions:** Seed the shared package.
- **Changed files:** None
- **Verification:** Reviewed the existing managed result.
`);
  await writeFile(path.join(directDirectory, "20260810T120300Z-finalize-economy-review.md"), `# Finalize economy review

- **Task:** HEX-DIRECT-1
- **Outcome:** Finalized the direct economy memory.
- **Decisions:** Use the unified memory projection.
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Supersession assertion.
- **Supersedes:** 20260810T120200Z-document-economy-review
`);
  await rebuildMemory(journal);

  assert.equal(await readFile(path.join(directory, "prompt.md"), "utf8"), "Exact original prompt");
  const projectState = await readFile(path.join(root, "working", "project-state.md"), "utf8");
  assert.match(projectState, /Reviewed the economy/);
  assert.match(projectState, /Documented the follow-up economy decision/);
  assert.match(projectState, /Finalized the direct economy memory/);
  const decisions = await readFile(path.join(root, "working", "decisions.md"), "utf8");
  assert.match(decisions, /unified memory projection/);
  assert.doesNotMatch(decisions, /provincial treasuries/);
  assert.doesNotMatch(await readFile(path.join(root, "working", "risks.md"), "utf8"), /Backend migration/);
  assert.deepEqual(await verifyMemory(journal), {
    runs: 1, directNotes: 2, compactArchives: 0, imageGenerations: 0, issues: [],
  });
});

test("verify reports malformed direct memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-"));
  const journal = new RunJournal(root);
  await journal.initialize();
  const directDirectory = path.join(root, "direct", "2026", "08");
  await mkdir(directDirectory, { recursive: true });
  await writeFile(path.join(directDirectory, "20260810T121000Z-incomplete-note.md"), "# Incomplete\n\n- **Task:** HEX-2\n");

  const report = await verifyMemory(journal);
  assert.equal(report.directNotes, 0);
  assert.ok(report.issues.some((issue) => issue.includes("missing fields")));
  await assert.rejects(() => rebuildMemory(journal), /Direct memory validation failed/);
});

test("memory sweep snapshots projections and archives only explicit lifecycle records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-sweep-"));
  const journal = new RunJournal(root);
  await journal.initialize();
  const direct = path.join(root, "direct", "2026", "08");
  await mkdir(direct, { recursive: true });
  await writeFile(path.join(direct, "20260810T120000Z-retired-note.md"), `# Retired note

- **Agent:** test/runner
- **Recorded at:** 2026-08-10T12:00:00Z
- **Task:** Retire stale decision.
- **Outcome:** This is no longer active.
- **Decisions:** None
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Reviewed.
- **Status:** retired
- **Reason:** Covered by accepted milestone.
`);
  await writeFile(path.join(direct, "20260810T120100Z-active-note.md"), `# Active note

- **Task:** Keep for human review.
- **Outcome:** Still needs an explicit retirement choice.
- **Decisions:** Keep review explicit.
- **Risks or blockers:** None
- **Next actions:** Decide whether to retire this note.
- **Changed files:** None
- **Verification:** Reviewed.
`);
  await writeFile(path.join(direct, "20260810T120200Z-successor-note.md"), `# Successor note

- **Task:** Retain the replacement decision.
- **Outcome:** The replacement remains active after the older note is swept.
- **Decisions:** Use the replacement decision.
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Reviewed.
- **Supersedes:** 20260810T120000Z-retired-note
`);
  const milestone = path.join(root, "milestones", "accepted", "approved.yaml");
  await mkdir(path.dirname(milestone), { recursive: true });
  await writeFile(milestone, `schema_version: "1.0"
milestone: accepted
scope: shared
review:
  decision: accepted
  accepted_at: 2026-08-11T00:00:00Z
  accepted_by: test
summary: Accepted.
validated_outcomes: []
decisions: []
contracts: []
risks: []
pending_work: []
artifacts: []
supersedes: []
`);
  const receipt = await sweepMemory(journal, { now: new Date("2026-08-12T12:00:00Z"), executor: "test/sweep" });
  assert.equal(receipt.verification.passed, true);
  assert.deepEqual(receipt.notes.archived, ["20260810T120000Z-retired-note"]);
  assert.deepEqual(receipt.notes.retirementCandidates, ["20260810T120100Z-active-note", "20260810T120200Z-successor-note"]);
  assert.match(receipt.snapshotPath ?? "", /^archive\/sweeps\/2026\/08\//);
  await assert.rejects(readFile(path.join(direct, "20260810T120000Z-retired-note.md")));
  assert.match(await readFile(path.join(root, "archive", "direct", "2026", "08", "20260810T120000Z-retired-note.md"), "utf8"), /Status:\*\* retired/);
  assert.match(await readFile(path.join(root, "working", "project-state.md"), "utf8"), /Generated by: orchbun memory rebuild/);
  assert.deepEqual(await verifyMemory(journal), {
    runs: 0, directNotes: 3, compactArchives: 0, imageGenerations: 0, issues: [],
  });
  assert.ok(receipt.reportPath);
});

test("compact publishes only an accepted milestone manifest and preserves an audit archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-"));
  const journal = new RunJournal(root);
  await journal.initialize();
  await writeFile(path.join(root, "working", "project-state.md"), "# Project state\n\nTransient implementation log.\n");
  await writeFile(path.join(root, "working", "decisions.md"), "# Decisions\n\n- Keep the stable identity contract.\n- Remove this superseded detail.\n");
  await writeFile(path.join(root, "working", "risks.md"), "# Risks and blockers\n\n- Existing deployment risk.\n");
  const milestoneDirectory = path.join(root, "milestones", "hex-a3");
  await mkdir(milestoneDirectory, { recursive: true });
  const manifest = path.join(milestoneDirectory, "approved.yaml");
  await writeFile(manifest, `schema_version: "1.0"
milestone: hex-a3
scope: shared
review:
  decision: accepted
  accepted_at: 2026-08-10T14:00:00Z
  accepted_by: gameplay-review
summary: Deterministic battle replay is accepted.
validated_outcomes:
  - Replay produces the approved golden vector.
decisions:
  - Use mulberry32 for replay seeds.
contracts:
  - POST /battles/:id/replay returns the canonical action log.
risks:
  - Old saves need a version adapter.
pending_work:
  - Plan the persistence milestone.
artifacts:
  - path: packages/sim-battle/src/seeded-random.ts
    description: Canonical deterministic PRNG.
supersedes:
  - Remove this superseded detail.
`);

  const receipt = await compactMemory(journal, manifest, "hex-a3", "shared", new Date("2026-08-10T14:05:00Z"));
  assert.equal(receipt.archivePath, "archive/2026/08/20260810T140500Z-hex-a3");
  const state = await readFile(path.join(root, "working", "project-state.md"), "utf8");
  assert.match(state, /Deterministic battle replay is accepted/);
  assert.match(state, /seeded-random\.ts/);
  assert.doesNotMatch(state, /Transient implementation log/);
  const decisions = await readFile(path.join(root, "working", "decisions.md"), "utf8");
  assert.match(decisions, /stable identity contract/);
  assert.match(decisions, /mulberry32/);
  assert.doesNotMatch(decisions, /superseded detail/);
  assert.match(await readFile(path.join(root, "working", "contracts.md"), "utf8"), /POST \/battles/);
  assert.match(await readFile(path.join(root, receipt.archivePath, "working", "project-state.md"), "utf8"), /Transient implementation log/);
  assert.match(await readFile(path.join(root, receipt.archivePath, "approved-manifest.yaml"), "utf8"), /decision: accepted/);

  await mkdir(path.join(root, "direct", "2026", "08"), { recursive: true });
  await writeFile(path.join(root, "direct", "2026", "08", "20260810T141000Z-plan-persistence.md"), `# Plan persistence

- **Task:** HEX-A4
- **Outcome:** Began planning after the accepted replay milestone.
- **Decisions:** Keep replay validation at the service boundary.
- **Risks or blockers:** None
- **Next actions:** Draft the persistence acceptance criteria.
- **Changed files:** None
- **Verification:** Confirmed the compact baseline was active.
`);
  await rebuildMemory(journal);
  assert.doesNotMatch(await readFile(path.join(root, "working", "project-state.md"), "utf8"), /Transient implementation log/);
  assert.match(await readFile(path.join(root, "working", "project-state.md"), "utf8"), /Began planning after the accepted replay milestone/);
  assert.match(await readFile(path.join(root, "working", "decisions.md"), "utf8"), /mulberry32/);
  assert.match(await readFile(path.join(root, "working", "decisions.md"), "utf8"), /service boundary/);
  assert.deepEqual(await verifyMemory(journal), {
    runs: 0, directNotes: 1, compactArchives: 1, imageGenerations: 0, issues: [],
  });
});

test("compact rejects a milestone before acceptance without changing working memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-"));
  const journal = new RunJournal(root);
  await journal.initialize();
  const before = await readFile(path.join(root, "working", "project-state.md"), "utf8");
  const manifest = path.join(root, "milestones", "review-pending", "approved.yaml");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, `schema_version: "1.0"
milestone: review-pending
scope: shared
review:
  decision: pending
  accepted_at: 2026-08-10T14:00:00Z
  accepted_by: reviewer
summary: Not accepted.
validated_outcomes: []
decisions: []
contracts: []
risks: []
pending_work: []
artifacts: []
supersedes: []
`);

  await assert.rejects(() => compactMemory(journal, manifest, "review-pending", "shared"), /schema validation/);
  assert.equal(await readFile(path.join(root, "working", "project-state.md"), "utf8"), before);
});

test("a lifecycle marker can be added to a note that never recorded its agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-lifecycle-"));
  const memoryRoot = path.join(root, "memory", "agents");
  const directory = path.join(memoryRoot, "direct", "2026", "08");
  await mkdir(directory, { recursive: true });
  const body = (extra: string) => `# Note

- **Task:** Ship the thing.
- **Outcome:** Shipped.
- **Decisions:** None
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Reviewed.
${extra}`;

  await writeFile(path.join(directory, "20260810T120000Z-retired-no-agent.md"), body(`- **Status:** retired\n- **Reason:** Delivered.\n`));
  await writeFile(path.join(directory, "20260810T120100Z-provenance-half.md"), body(`- **Recorded at:** 2026-08-10T12:01:00Z\n`));

  const loaded = await loadDirectMemory(memoryRoot);
  assert.deepEqual(loaded.notes.map((note) => note.status), ["retired"]);
  assert.deepEqual(loaded.issues, [
    "direct/2026/08/20260810T120100Z-provenance-half.md: Agent must not be empty when provenance fields are used",
  ]);
});

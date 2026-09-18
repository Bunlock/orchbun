import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { MemoryService } from "../src/memory-service.js";
import { saveMemoryOverride } from "../src/memory-overrides.js";
import type { ContextPacket, RunMetadata } from "../src/types.js";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-service-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Test rules\n");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Current\n\n- [ ] **HEX-B1** Test retrieval.\n");
  const memoryRoot = path.join(root, "memory", "agents");
  const journal = new RunJournal(memoryRoot);
  await journal.initialize();
  return { root, memoryRoot, journal };
}

async function directNote(
  memoryRoot: string,
  stamp: string,
  name: string,
  fields: {
    task?: string;
    outcome: string;
    decisions?: string;
    risks?: string;
    nextActions?: string;
    verification?: string;
    subjects?: string[];
    supersedes?: string[];
    status?: "active" | "retired" | "superseded";
    reason?: string;
    archived?: boolean;
  },
): Promise<string> {
  const id = `${stamp}-${name}`;
  const base = fields.archived ? path.join(memoryRoot, "archive", "direct") : path.join(memoryRoot, "direct");
  const directory = path.join(base, stamp.slice(0, 4), stamp.slice(4, 6));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.md`), `# ${name}

- **Task:** ${fields.task ?? "HEX-B1 mobile play"}
- **Outcome:** ${fields.outcome}
- **Decisions:** ${fields.decisions ?? "Keep deterministic retrieval."}
- **Risks or blockers:** ${fields.risks ?? "None"}
- **Next actions:** ${fields.nextActions ?? "Review the current evidence."}
- **Changed files:** None
- **Verification:** ${fields.verification ?? "Focused memory test passed."}
${fields.subjects?.length ? `- **Subjects:**\n${fields.subjects.map((subject) => `  - ${subject}`).join("\n")}\n` : ""}${fields.supersedes?.length ? `- **Supersedes:**\n${fields.supersedes.map((target) => `  - ${target}`).join("\n")}\n` : ""}- **Status:** ${fields.status ?? "active"}
${fields.reason ? `- **Reason:** ${fields.reason}\n` : ""}`);
  return id;
}

test("retrieval uses lifecycle authority, exact task IDs, generated annotations, and no raw prompts", async () => {
  const { root, memoryRoot, journal } = await workspace();
  const old = await directNote(memoryRoot, "20260901T120000Z", "old-retrieval", {
    outcome: "Legacy quasar retrieval is obsolete.", subjects: ["memory/retrieval"],
  });
  const head = await directNote(memoryRoot, "20260901T120100Z", "current-retrieval", {
    outcome: "Current nebula retrieval is authoritative.", subjects: ["memory/retrieval"], supersedes: [old],
  });
  const parallel = await directNote(memoryRoot, "20260901T120200Z", "parallel-retrieval", {
    task: "ORCH-M2 review", outcome: "Parallel nebula investigation remains open.", subjects: ["memory/retrieval"],
  });
  const retired = await directNote(memoryRoot, "20260801T120000Z", "retired-retrieval", {
    outcome: "Retired pulsar retrieval history.", status: "retired", reason: "Replaced after review.", archived: true,
  });
  const stopNoise = await directNote(memoryRoot, "20260901T120300Z", "stop-word-noise", {
    task: "ORCH-NOISE", outcome: "The and to are filler words without retrieval evidence.",
  });
  const frenchStopNoise = await directNote(memoryRoot, "20260901T120400Z", "french-stop-word-noise", {
    task: "ORCH-BRUIT", outcome: "Le et de sont seulement des mots sans preuve pertinente.",
  });
  await saveMemoryOverride(memoryRoot, "decisions", "# Human decision\n\nPreserve the heliotrope manual constraint.\n");

  const metadata: RunMetadata = {
    runId: "20260901T130000Z-codex-a1b2c3", parentRunId: null, taskId: "HEX-B1", depth: 0,
    agent: "codex", mode: "review", status: "pending", startedAt: "2026-09-01T13:00:00Z", finishedAt: null,
    promptHash: "secret", inputCharacters: 12, estimatedInputTokens: 3, includedFiles: [], omittedFiles: [],
  };
  const packet: ContextPacket = {
    taskId: "HEX-B1", sourcePrompt: "TOP-SECRET-RAW-PROMPT", expandedPrompt: "TOP-SECRET-EXPANDED-PROMPT",
    includedFiles: [], omittedFiles: [], inputCharacters: 21, estimatedInputTokens: 6,
  };
  await journal.begin(metadata, packet);

  const service = await MemoryService.open(root);
  const current = service.retrieve({ text: "nebula", taskId: "HEX-B1", subjects: ["memory/retrieval"] });
  assert.equal(current.hits[0]?.document.id, `direct:${head}`);
  assert.equal(current.hits[0]?.rankExplanation.exactTask, true);
  assert.ok(current.hits.some((hit) => hit.document.id === `direct:${parallel}`));
  assert.ok(!current.hits.some((hit) => hit.document.id === `direct:${old}`));
  assert.ok(!current.hits.some((hit) => hit.document.id === `direct:${retired}`));

  const history = service.retrieve({ text: "quasar pulsar", includeHistory: true });
  assert.ok(history.hits.some((hit) => hit.document.id === `direct:${old}` && hit.document.lifecycle === "superseded"));
  assert.ok(history.hits.some((hit) => hit.document.id === `direct:${retired}` && hit.document.archiveStatus === "archived"));
  assert.equal(service.retrieve({ text: "TOP-SECRET-RAW-PROMPT", includeHistory: true }).hits.length, 0);
  assert.equal(service.retrieve({ text: "TOP-SECRET-EXPANDED-PROMPT", includeHistory: true }).hits.length, 0);
  assert.match(service.retrieve({ text: "heliotrope" }).hits[0]?.document.id ?? "", /^projection:/);
  const stopFiltered = service.retrieve({ text: "the and to nebula" });
  assert.ok(stopFiltered.hits.length > 0);
  assert.ok(!stopFiltered.hits.some((hit) => hit.document.id === `direct:${stopNoise}`));
  assert.deepEqual(stopFiltered.hits[0]?.rankExplanation.matchedTerms, ["nebula"]);
  assert.equal(service.retrieve({ text: "the and to" }).hits.length, 0);
  const frenchStopFiltered = service.retrieve({ text: "le et de nebula" });
  assert.ok(!frenchStopFiltered.hits.some((hit) => hit.document.id === `direct:${frenchStopNoise}`));
  assert.deepEqual(frenchStopFiltered.hits[0]?.rankExplanation.matchedTerms, ["nebula"]);
  const bounded = service.retrieve({ text: "nebula", maxCharacters: 17 });
  assert.ok(bounded.characters <= 17);
  assert.equal(bounded.hits.reduce((sum, hit) => sum + hit.snippet.length, 0), bounded.characters);
  assert.equal("sections" in (bounded.hits[0]?.document ?? {}), false);
});

test("the disposable index publishes atomically, validates, and is optional", async () => {
  const { root, memoryRoot } = await workspace();
  await directNote(memoryRoot, "20260902T120000Z", "index-source", { outcome: "Indexable aurora evidence." });
  const service = await MemoryService.open(root);
  assert.deepEqual(await service.verifyIndex(), []);
  await service.refreshIndex();
  assert.deepEqual(await service.verifyIndex(), []);
  const file = path.join(memoryRoot, "search", "index-v1.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { sourceRevision: string; documentHashes: Record<string, string> };
  assert.equal(parsed.sourceRevision, service.sourceRevision);
  assert.ok(Object.keys(parsed.documentHashes).some((id) => id.startsWith("direct:")));
  await directNote(memoryRoot, "20260902T120100Z", "newer-index-source", { outcome: "Newer borealis evidence." });
  await assert.rejects(service.refreshIndex(), /Memory changed after this search index was built/);
  const fresh = await MemoryService.open(root);
  await fresh.refreshIndex();
  await writeFile(file, "{broken");
  const recovered = await MemoryService.open(root);
  assert.ok((await recovered.verifyIndex())[0]?.includes("invalid JSON"));
  assert.ok(recovered.retrieve({ text: "aurora" }).hits.length > 0);
});

test("opening the read-only memory service does not publish an external roadmap cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-service-external-"));
  const provider = path.join(root, "provider.mjs");
  await writeFile(provider, `
for await (const _chunk of process.stdin) {}
process.stdout.write(JSON.stringify({
  schema_version: "1.0",
  revision: "jira-r1",
  tasks: [{ id: "APP-1", title: "Read without writes.", completed: false, milestone_id: "A", milestone_title: "Foundation" }]
}));
`);
  await writeFile(path.join(root, "orchbun.yaml"), JSON.stringify({
    version: 1,
    roadmap: { provider: "external", name: "Jira", command: [process.execPath, provider] },
  }));
  await writeFile(path.join(root, "AGENTS.md"), "# Rules\n");
  const memoryRoot = path.join(root, "memory", "agents");
  await new RunJournal(memoryRoot).initialize();

  await MemoryService.open(root);

  await assert.rejects(readdir(path.join(memoryRoot, "cache", "roadmap")), { code: "ENOENT" });
});

test("dream proposals are deterministic, cited, review-gated, stale-safe, and retry-safe", async () => {
  const { root, memoryRoot } = await workspace();
  const base = await directNote(memoryRoot, "20260903T120000Z", "dream-source", {
    outcome: "The cinder index is current.",
    decisions: "Use deterministic lexical ranking.",
    risks: "Physical archival still needs human review.",
    nextActions: "Review the cinder synthesis.",
    verification: "Focused cinder retrieval passed.",
    subjects: ["memory/dream"],
  });
  const parallel = await directNote(memoryRoot, "20260903T120100Z", "dream-parallel", {
    outcome: "A second cinder head remains explicit.", subjects: ["memory/dream"],
  });
  const before = await readdir(path.join(memoryRoot, "direct", "2026", "09"));
  const service = await MemoryService.open(root);
  const first = service.proposeDream({ taskId: "HEX-B1" });
  assert.deepEqual(service.proposeDream({ taskId: "HEX-B1" }), first);
  assert.deepEqual(await readdir(path.join(memoryRoot, "direct", "2026", "09")), before);
  assert.deepEqual(first.proposedSupersedes, []);
  assert.deepEqual(first.parallelHeadConflicts, [{ subject: "memory/dream", headIds: [base, parallel] }]);
  assert.ok(first.citations.length > 0);
  assert.match(first.draftMarkdown, /\[source:direct:/);
  assert.match(first.draftMarkdown, /Based on revision/);
  assert.match(first.draftMarkdown, /Parallel heads for memory\/dream/);
  assert.match(first.draftMarkdown, /Conflict resolutions:\*\* None/);

  await assert.rejects(
    service.acceptDream(first, first.draftMarkdown.replace(/\[source:[^\]]+\]/g, "")),
    /at least one inline source citation|missing an inline source citation/,
  );
  const supersedes = `- **Supersedes:**\n  - ${base}\n  - ${parallel}`;
  const unresolvedDraft = first.draftMarkdown.replace("- **Conflict resolutions:** None", supersedes);
  await assert.rejects(service.acceptDream(first, unresolvedDraft, "test-agent"), /must resolve parallel subject memory\/dream/);
  const resolvedDraft = first.draftMarkdown.replace(
    "- **Conflict resolutions:** None",
    `${supersedes}\n- **Conflict resolutions:**\n  - memory/dream: ${base}, ${parallel}`,
  );
  const incompleteResolution = resolvedDraft.replace(
    `  - memory/dream: ${base}, ${parallel}`,
    `  - memory/dream: ${base}`,
  );
  await assert.rejects(service.acceptDream(first, incompleteResolution, "test-agent"), /must reference every head/);
  const tampered = structuredClone(first);
  tampered.completenessWarnings = [];
  await assert.rejects(service.acceptDream(tampered, resolvedDraft, "test-agent"), /proposal metadata changed/);
  await assert.rejects(
    service.acceptDream(first, `${resolvedDraft.trimEnd()}\n- **Recorded at:** 2099-01-01T00:00:00Z\n`, "test-agent"),
    /must not set Agent or Recorded at/,
  );
  await assert.rejects(
    service.acceptDream(first, resolvedDraft.replace("- **Status:** active", "- **Status:** retired\n- **Reason:** Manual override"), "test-agent"),
    /Status must be active/,
  );
  const accepted = await service.acceptDream(first, resolvedDraft, "test-agent");
  assert.equal(accepted.recorded, true);
  assert.equal((await service.acceptDream(first, resolvedDraft, "test-agent")).recorded, false);
  await assert.rejects(
    service.acceptDream(first, resolvedDraft.replace("The cinder index is current.", "The cinder index remains current."), "test-agent"),
    /Dream proposal is stale/,
  );
  assert.equal((await readdir(path.join(memoryRoot, "archive", "direct"))).length, 0);
});

test("an all-memory dream permits explicitly reviewed current supersession targets", async () => {
  const { root, memoryRoot } = await workspace();
  const source = await directNote(memoryRoot, "20260903T130000Z", "all-dream-source", {
    task: "ORCH-ALL", outcome: "The jade all-memory source remains current.", subjects: ["memory/all"],
  });
  const service = await MemoryService.open(root);
  const proposal = service.proposeDream({ all: true });
  assert.deepEqual(proposal.proposedSupersedes, []);
  const reviewed = proposal.draftMarkdown.replace(
    "- **Sources:**",
    `- **Supersedes:**\n  - ${source}\n- **Sources:**`,
  );
  const accepted = await service.acceptDream(proposal, reviewed, "test-agent");
  assert.equal(accepted.recorded, true);
  const current = await MemoryService.open(root);
  assert.equal(current.retrieve({ text: "jade" }).hits.some((hit) => hit.citation.id === `direct:${source}`), false);
  assert.equal(current.retrieve({ text: "jade", includeHistory: true }).hits
    .some((hit) => hit.citation.id === `direct:${source}` && hit.document.lifecycle === "superseded"), true);
});

test("accepted compact baselines own current retrieval and only propose retirement review", async () => {
  const { root, memoryRoot } = await workspace();
  const source = await directNote(memoryRoot, "20260904T120000Z", "compacted-source", {
    outcome: "The ember baseline source was accepted.", subjects: ["memory/compact"],
  });
  const olderUnlisted = await directNote(memoryRoot, "20260904T115900Z", "older-unlisted-source", {
    outcome: "An older active head was not listed in the compact receipt.", subjects: ["memory/other"],
  });
  await directNote(memoryRoot, "20260904T120200Z", "newer-unlisted-source", {
    outcome: "A newer active head postdates the compact baseline.", subjects: ["memory/other"],
  });
  const manifestHash = "a".repeat(64);
  await writeFile(path.join(memoryRoot, "working", "compact-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    milestone: "retrieval-v1",
    scope: "shared",
    publishedAt: "2026-09-04T12:01:00.000Z",
    manifestPath: "milestones/retrieval-v1/approved.yaml",
    manifestHash,
    archivePath: "archive/2026/09/20260904T120100Z-retrieval-v1",
    includedManagedRunIds: [],
    includedDirectNoteIds: [source],
    baseline: {
      summary: "Accepted ember baseline.", validatedOutcomes: ["Ember retrieval is ready."],
      decisions: [], contracts: [], risks: [], pendingWork: ["Review ember rollout."], artifacts: [],
    },
  }, null, 2)}\n`);

  const service = await MemoryService.open(root);
  const result = service.retrieve({ text: "ember", taskId: "HEX-B1" });
  assert.equal(result.hits[0]?.document.id, `compact:${manifestHash}`);
  assert.ok(!result.hits.some((hit) => hit.document.id === `direct:${source}`));
  const proposal = service.proposeDream({ taskId: "HEX-B1" });
  assert.deepEqual(proposal.proposedSupersedes, []);
  assert.deepEqual(proposal.retirementCandidates, [olderUnlisted, source].sort().map((id) => ({
    id,
    reason: "Current active head predates the accepted compact baseline; retirement requires review.",
  })));
});

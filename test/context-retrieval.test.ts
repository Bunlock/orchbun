import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildContextPacket, buildRetrievalCandidatePacket } from "../src/context.js";
import { refreshMemory } from "../src/memory-refresh.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { MemoryPageId } from "../src/memory-overrides.js";
import type { RunMetadata } from "../src/types.js";

const pages: Record<MemoryPageId, string> = {
  "project-state": `# Project state

## Roadmap

- Current milestone: B.

## Recent recorded outcomes

- Current retrieval work is active.
`,
  "active-tasks": `# Active tasks

- **ORCH-1 · Retrieval:** Add query-specific context.
- **ORCH-2 · Other:** This unrelated task must not enter the mandatory task core.
`,
  decisions: "# Decisions\n\n- FIXED-DECISION-PAGE-MUST-NOT-BE-INCLUDED\n",
  contracts: "# Operational constraints\n\n- Never publish raw prompts.\n",
  risks: `# Risks and blockers

- Retrieval can omit authority state.

## Resolved

- OLD-RESOLVED-RISK-MUST-NOT-BE-INCLUDED
`,
};

test("shadow retrieval candidate keeps mandatory authority first, then explicit and cited evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-retrieval-"));
  await writeFile(path.join(root, "notes.md"), "EXPLICIT-EVIDENCE");
  const packet = await buildRetrievalCandidatePacket(root, DEFAULT_CONFIG, {
    sourcePrompt: "Implement query-specific context.",
    taskId: "ORCH-1",
    mode: "work",
    contextFiles: ["notes.md"],
    allowDelegation: false,
    memoryPages: pages,
    retrievedMemory: { hits: [
      {
        document: { path: "direct/2026/09/note.md", lifecycle: "current" },
        citation: { id: "note", path: "direct/2026/09/note.md", hash: "abc123" },
        snippet: "RETRIEVED-EVIDENCE",
        rankExplanation: { exactTask: true, exactSubjects: [], lexicalScore: 1, matchedTerms: ["context"] },
      },
      {
        document: { path: "working/decisions.md", lifecycle: "current" },
        citation: { id: "projection:decisions", path: "working/decisions.md", hash: "def456" },
        snippet: "MANUAL-DECISION-ANNOTATION",
        rankExplanation: { exactTask: false, exactSubjects: [], lexicalScore: 0.5, matchedTerms: ["context"] },
      },
    ] },
  });

  const project = packet.expandedPrompt.indexOf("[MANDATORY PROJECT STATE");
  const task = packet.expandedPrompt.indexOf("[MANDATORY TASK STATE");
  const constraints = packet.expandedPrompt.indexOf("[MANDATORY OPERATIONAL CONSTRAINTS");
  const risks = packet.expandedPrompt.indexOf("[MANDATORY UNRESOLVED RISKS");
  const explicit = packet.expandedPrompt.indexOf("EXPLICIT-EVIDENCE");
  const retrieved = packet.expandedPrompt.indexOf("RETRIEVED-EVIDENCE");
  assert.ok(project > 0 && project < task && task < constraints && constraints < risks && risks < explicit && explicit < retrieved);
  assert.match(packet.expandedPrompt, /ORCH-1 · Retrieval/);
  assert.doesNotMatch(packet.expandedPrompt, /ORCH-2 · Other/);
  assert.doesNotMatch(packet.expandedPrompt, /FIXED-DECISION-PAGE-MUST-NOT-BE-INCLUDED/);
  assert.match(packet.expandedPrompt, /MANUAL-DECISION-ANNOTATION/);
  assert.doesNotMatch(packet.expandedPrompt, /OLD-RESOLVED-RISK-MUST-NOT-BE-INCLUDED/);
  assert.match(packet.expandedPrompt, /Citation: note · direct\/2026\/09\/note\.md · abc123/);
  assert.deepEqual(packet.includedFiles, [
    "memory/agents/working/project-state.md",
    "memory/agents/working/active-tasks.md",
    "memory/agents/working/contracts.md",
    "memory/agents/working/risks.md",
    "notes.md",
    "direct/2026/09/note.md",
    "working/decisions.md",
  ]);
});

test("shadow retrieval candidate fails explicitly instead of truncating mandatory authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-budget-"));
  const config = { ...DEFAULT_CONFIG, budgets: { ...DEFAULT_CONFIG.budgets, maxInputChars: 700 } };
  await assert.rejects(buildRetrievalCandidatePacket(root, config, {
    sourcePrompt: "Review.",
    taskId: "ORCH-1",
    mode: "review",
    contextFiles: [],
    allowDelegation: false,
    memoryPages: pages,
    retrievedMemory: { hits: [] },
  }), /Context mandatory core requires .* Increase budgets\.maxInputChars/);
});

test("orchestrator keeps the five-page prompt and attaches only a shadow comparison receipt", async () => {
  const retrievalRoot = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-service-"));
  await writeFile(path.join(retrievalRoot, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(retrievalRoot, "ROADMAP.md"), "# Roadmap\n\n- [ ] **ORCH-1** Retrieve the exact memory.\n");
  const direct = path.join(retrievalRoot, "memory", "agents", "direct", "2026", "09");
  await mkdir(direct, { recursive: true });
  await writeFile(path.join(direct, "20260917T120000Z-retrieval.md"), `# Retrieval
- **Task:** ORCH-1
- **Outcome:** UNIQUE-RETRIEVED-OUTCOME
- **Decisions:** None
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Focused retrieval test passed.
`);
  const before = await readdir(retrievalRoot);
  const orchestrator = new Orchestrator(retrievalRoot, DEFAULT_CONFIG);
  const runOptions = {
    agent: "codex", mode: "review", sourcePrompt: "Find UNIQUE-RETRIEVED-OUTCOME.", taskId: "ORCH-1",
    parentRunId: null, depth: 0, contextFiles: [],
  } as const;
  const memory = await refreshMemory(orchestrator.journal, retrievalRoot, false);
  const baseline = await buildContextPacket(retrievalRoot, DEFAULT_CONFIG, {
    memoryPages: memory.projection.pages,
    sourcePrompt: runOptions.sourcePrompt,
    taskId: runOptions.taskId,
    mode: runOptions.mode,
    contextFiles: [],
    allowDelegation: false,
    runtimeAvailable: false,
  });
  const retrieved = await orchestrator.context(runOptions);
  const { retrievalComparison, ...productionPacket } = retrieved;
  assert.deepEqual(productionPacket, baseline);
  assert.match(retrieved.expandedPrompt, /\[WORKING MEMORY: memory\/agents\/working\/project-state\.md]/);
  assert.match(retrieved.expandedPrompt, /\[WORKING MEMORY: memory\/agents\/working\/decisions\.md]/);
  assert.doesNotMatch(retrieved.expandedPrompt, /\[RETRIEVED MEMORY|Citation: direct:/);
  assert.equal(retrieved.includedFiles.some(file => file.startsWith("direct/")), false);
  assert.equal(retrievalComparison?.baselineCharacters, retrieved.inputCharacters);
  assert.ok((retrievalComparison?.candidateCharacters ?? 0) > 0);
  assert.match(retrievalComparison?.sourceRevision ?? "", /^[a-f0-9]{64}$/);
  assert.ok(retrievalComparison?.topCitationIds.includes("direct:20260917T120000Z-retrieval"));
  assert.equal(retrievalComparison?.mandatoryAuthorityPreserved, true);
  const runId = "20260917T130000Z-codex-shadow01";
  const metadata: RunMetadata = {
    runId, parentRunId: null, taskId: runOptions.taskId, depth: 0, agent: "codex", mode: "review", status: "pending",
    startedAt: "2026-09-17T13:00:00Z", finishedAt: null, promptHash: "shadow", inputCharacters: retrieved.inputCharacters,
    estimatedInputTokens: retrieved.estimatedInputTokens, includedFiles: retrieved.includedFiles, omittedFiles: retrieved.omittedFiles,
  };
  await orchestrator.journal.begin(metadata, retrieved);
  const storedContext = JSON.parse(await readFile(path.join(orchestrator.journal.runDirectory(runId), "context.json"), "utf8")) as {
    retrieval_comparison?: { source_revision: string; top_citation_ids: string[]; mandatory_authority_preserved: boolean };
  };
  assert.equal(storedContext.retrieval_comparison?.source_revision, retrievalComparison?.sourceRevision);
  assert.deepEqual(storedContext.retrieval_comparison?.top_citation_ids, retrievalComparison?.topCitationIds);
  assert.equal(storedContext.retrieval_comparison?.mandatory_authority_preserved, true);
  assert.deepEqual(await readdir(retrievalRoot), before);

  const fallbackRoot = await mkdtemp(path.join(os.tmpdir(), "orchbun-context-fallback-"));
  await writeFile(path.join(fallbackRoot, "orchbun.yaml"), "version: [invalid\n");
  await writeFile(path.join(fallbackRoot, "ROADMAP.md"), "# Roadmap\n");
  const fallbackOrchestrator = new Orchestrator(fallbackRoot, DEFAULT_CONFIG);
  const fallbackOptions = {
    agent: "codex", mode: "review", sourcePrompt: "Use fallback.", taskId: null,
    parentRunId: null, depth: 0, contextFiles: [],
  } as const;
  const fallbackMemory = await refreshMemory(fallbackOrchestrator.journal, fallbackRoot, false);
  const fallbackBaseline = await buildContextPacket(fallbackRoot, DEFAULT_CONFIG, {
    memoryPages: fallbackMemory.projection.pages,
    sourcePrompt: fallbackOptions.sourcePrompt,
    taskId: null,
    mode: "review",
    contextFiles: [],
    allowDelegation: false,
    runtimeAvailable: false,
  });
  const fallback = await fallbackOrchestrator.context(fallbackOptions);
  assert.deepEqual(fallback, fallbackBaseline);
  assert.match(fallback.expandedPrompt, /\[WORKING MEMORY:/);
  assert.match(fallback.expandedPrompt, /# Decisions/);
  assert.equal(fallback.retrievalComparison, undefined);
});

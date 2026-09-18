import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type OrchbunConfig } from "../src/config.js";
import {
  buildContextPacket,
  buildRetrievalCandidatePacket,
  compareContextPackets,
  requiredAuthorityMarkers,
} from "../src/context.js";
import { MemoryService } from "../src/memory-service.js";

function configuredMemory(): OrchbunConfig {
  return {
    ...DEFAULT_CONFIG,
    memoryPages: {
      enabled: ["project-state", "decisions"],
      custom: [
        { id: "invoices", title: "Invoices", includeInContext: true },
        { id: "private-process", title: "Private process", includeInContext: false },
      ],
    },
  };
}

test("configured context includes opted-in pages in catalogue order and ignores stale disabled pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configured-context-"));
  await writeFile(path.join(root, "notes.md"), "EXPLICIT-CONTEXT");
  const config = configuredMemory();
  const packet = await buildContextPacket(root, config, {
    sourcePrompt: "Review billing.", taskId: null, mode: "review", contextFiles: ["notes.md"], allowDelegation: false,
    memoryPages: {
      "project-state": "# Project state\n\nCONFIGURED-PROJECT",
      decisions: "# Decisions\n\nCONFIGURED-DECISIONS",
      invoices: "# Invoices\n\nCONFIGURED-INVOICES",
      risks: "# Risks\n\nDISABLED-RISK",
      "private-process": "# Private\n\nNON-CONTEXT-PROCESS",
    },
  });

  const project = packet.expandedPrompt.indexOf("CONFIGURED-PROJECT");
  const decisions = packet.expandedPrompt.indexOf("CONFIGURED-DECISIONS");
  const invoices = packet.expandedPrompt.indexOf("CONFIGURED-INVOICES");
  const explicit = packet.expandedPrompt.indexOf("EXPLICIT-CONTEXT");
  assert.ok(project > 0 && project < decisions && decisions < invoices && invoices < explicit);
  assert.doesNotMatch(packet.expandedPrompt, /DISABLED-RISK|NON-CONTEXT-PROCESS/);
  assert.deepEqual(packet.includedFiles, [
    "memory/agents/working/project-state.md",
    "memory/agents/working/decisions.md",
    "memory/agents/working/invoices.md",
    "notes.md",
  ]);
});

test("retrieval authority and eligible projections follow the configured catalogue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configured-candidate-"));
  const config = configuredMemory();
  const options = {
    sourcePrompt: "Review billing.", taskId: null, mode: "review" as const, contextFiles: [], allowDelegation: false,
    memoryPages: {
      "project-state": "# Project state\n\n## Roadmap\n\nCONFIGURED-PROJECT",
      decisions: "# Decisions\n\nCONFIGURED-DECISIONS",
      invoices: "# Invoices\n\nCONFIGURED-INVOICES",
    },
  };
  const baseline = await buildContextPacket(root, config, options);
  const candidate = await buildRetrievalCandidatePacket(root, config, {
    ...options,
    retrievedMemory: { hits: [
      projectionHit("decisions", "working/decisions.md", "CONFIGURED-DECISIONS"),
      projectionHit("invoices", "working/invoices.md", "CONFIGURED-INVOICES"),
      projectionHit("risks", "working/risks.md", "DISABLED-RISK"),
      projectionHit("private-process", "working/private-process.md", "NON-CONTEXT-PROCESS"),
    ] },
  });

  assert.match(candidate.expandedPrompt, /MANDATORY PROJECT STATE/);
  assert.doesNotMatch(candidate.expandedPrompt, /MANDATORY TASK STATE|MANDATORY OPERATIONAL CONSTRAINTS|MANDATORY UNRESOLVED RISKS/);
  assert.match(candidate.expandedPrompt, /CONFIGURED-DECISIONS/);
  assert.match(candidate.expandedPrompt, /CONFIGURED-INVOICES/);
  assert.doesNotMatch(candidate.expandedPrompt, /DISABLED-RISK|NON-CONTEXT-PROCESS/);
  assert.deepEqual(requiredAuthorityMarkers(config), ["[MANDATORY PROJECT STATE:"]);
  assert.equal(compareContextPackets(baseline, candidate, "a".repeat(64), [], requiredAuthorityMarkers(config)).mandatoryAuthorityPreserved, true);
});

test("search creates projection documents only for enabled context pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configured-search-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryPages:
  enabled: [project-state, decisions]
  custom:
    - id: invoices
      title: Invoices
      includeInContext: true
    - id: private-process
      title: Private process
      includeInContext: false
`);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const manual = path.join(root, "memory", "agents", "manual", "pages");
  await mkdir(manual, { recursive: true });
  await writeFile(path.join(manual, "invoices.md"), "# Invoices\n\nSEARCHABLE-INVOICE-NEEDLE\n");
  await writeFile(path.join(manual, "private-process.md"), "# Private\n\nPRIVATE-PROCESS-NEEDLE\n");

  const service = await MemoryService.open(root);
  const projections = service.documents.filter((document) => document.kind === "projection").map((document) => document.id);
  assert.deepEqual(projections, ["projection:decisions", "projection:invoices", "projection:project-state"]);
  assert.equal(service.retrieve({ text: "SEARCHABLE-INVOICE-NEEDLE" }).hits[0]?.document.id, "projection:invoices");
  assert.equal(service.retrieve({ text: "PRIVATE-PROCESS-NEEDLE" }).hits.length, 0);
});

function projectionHit(id: string, documentPath: string, snippet: string) {
  return {
    document: { path: documentPath, lifecycle: "current" as const },
    citation: { id: `projection:${id}`, path: documentPath, hash: id },
    snippet,
    rankExplanation: { exactTask: false, exactSubjects: [], lexicalScore: 1, matchedTerms: [id] },
  };
}

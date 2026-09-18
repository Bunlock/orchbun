import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { MemoryService, type MemoryQuery } from "../src/memory-service.js";

interface EvaluationDocument {
  id: string;
  task: string;
  outcome: string;
  decisions: string[];
  risks: string[];
  nextActions: string[];
  verification: string[];
  subjects: string[];
  supersedes?: string[];
  status?: "active" | "retired" | "superseded";
  reason?: string;
  archived?: boolean;
}

interface EvaluationFixture {
  documents: EvaluationDocument[];
  compactBaseline: {
    manifestHash: string;
    milestone: string;
    publishedAt: string;
    summary: string;
    contracts: string[];
    pendingWork: string[];
  };
  queries: Array<{
    name: string;
    query: MemoryQuery;
    requiredSources: string[];
    critical: boolean;
  }>;
}

interface QueryEvaluation {
  name: string;
  critical: boolean;
  requiredSources: string[];
  topFive: string[];
  recallAtFive: number;
  reciprocalRank: number;
  ndcgAtFive: number;
  staleDefaultHits: string[];
}

const fixtureFile = new URL("./fixtures/memory-retrieval-evaluation.json", import.meta.url);

test("sanitized deterministic retrieval corpus satisfies promotion gates", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as EvaluationFixture;
  const root = await buildWorkspace(fixture);
  const rebuildStarted = performance.now();
  const memory = await MemoryService.open(root);
  const rebuildLatencyMs = performance.now() - rebuildStarted;
  const queryLatencies: number[] = [];
  const evaluations = fixture.queries.map(({ name, query, requiredSources, critical }): QueryEvaluation => {
    const queryStarted = performance.now();
    const result = memory.retrieve({ ...query, maxResults: 10, maxCharacters: 12_000 });
    queryLatencies.push(performance.now() - queryStarted);
    const ranked = result.hits.map((hit) => hit.citation.id);
    const topFive = ranked.slice(0, 5);
    const relevant = new Set(requiredSources);
    const firstRelevant = ranked.findIndex((id) => relevant.has(id));
    const relevantInTopFive = topFive.filter((id) => relevant.has(id)).length;
    const dcg = topFive.reduce((score, id, index) => score + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const idealDcg = Array.from({ length: Math.min(5, relevant.size) })
      .reduce((score, _, index) => score + 1 / Math.log2(index + 2), 0);
    return {
      name,
      critical,
      requiredSources,
      topFive,
      recallAtFive: relevantInTopFive / relevant.size,
      reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
      ndcgAtFive: idealDcg ? dcg / idealDcg : 0,
      staleDefaultHits: query.includeHistory ? [] : result.hits
        .filter((hit) => hit.document.lifecycle === "superseded"
          || hit.document.lifecycle === "retired"
          || hit.document.archiveStatus === "archived")
        .map((hit) => hit.citation.id),
    };
  });

  for (const evaluation of evaluations.filter((item) => item.critical)) {
    const missing = evaluation.requiredSources.filter((id) => !evaluation.topFive.includes(id));
    assert.deepEqual(missing, [], `${evaluation.name}: required source missing from top five`);
  }
  const staleDefaultHits = evaluations.flatMap((evaluation) => evaluation.staleDefaultHits);
  assert.deepEqual(staleDefaultHits, [], "default retrieval leaked superseded, retired, or archived state");

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const percentile = (values: number[], percentileValue: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
  };
  const metrics = {
    queryCount: evaluations.length,
    recallAtFive: mean(evaluations.map((evaluation) => evaluation.recallAtFive)),
    meanReciprocalRank: mean(evaluations.map((evaluation) => evaluation.reciprocalRank)),
    meanNdcgAtFive: mean(evaluations.map((evaluation) => evaluation.ndcgAtFive)),
    defaultStaleStateLeakage: staleDefaultHits.length,
    rebuildLatencyMs: Number(rebuildLatencyMs.toFixed(3)),
    queryP50Ms: Number(percentile(queryLatencies, 0.5).toFixed(3)),
    queryP95Ms: Number(percentile(queryLatencies, 0.95).toFixed(3)),
  };
  assert.equal(metrics.recallAtFive, 1);
  assert.ok(metrics.meanReciprocalRank > 0 && metrics.meanReciprocalRank <= 1);
  assert.ok(metrics.meanNdcgAtFive > 0 && metrics.meanNdcgAtFive <= 1);
  assert.ok(metrics.rebuildLatencyMs >= 0 && metrics.queryP50Ms >= 0 && metrics.queryP95Ms >= metrics.queryP50Ms);
  context.diagnostic(`retrieval evaluation: ${JSON.stringify(metrics)}`);
});

async function buildWorkspace(fixture: EvaluationFixture): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-retrieval-eval-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Sanitized evaluation contract\n");
  await writeFile(path.join(root, "ROADMAP.md"), `# Roadmap

## Evaluation

- [ ] **EVAL-T1** Evaluate exact task retrieval.
- [ ] **EVAL-R1** Evaluate risk retrieval.
- [ ] **EVAL-L1** Evaluate lifecycle retrieval.
- [ ] **EVAL-P1** Evaluate parallel-head retrieval.
- [ ] **EVAL-H1** Evaluate historical retrieval.
`);
  const memoryRoot = path.join(root, "memory", "agents");
  await new RunJournal(memoryRoot).initialize();

  for (const document of fixture.documents) await writeDirectDocument(memoryRoot, document);
  const baseline = fixture.compactBaseline;
  await writeFile(path.join(memoryRoot, "working", "compact-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    milestone: baseline.milestone,
    scope: "shared",
    publishedAt: baseline.publishedAt,
    manifestPath: `milestones/${baseline.milestone}/approved.yaml`,
    manifestHash: baseline.manifestHash,
    archivePath: `archive/2026/09/20260908T120000Z-${baseline.milestone}`,
    includedManagedRunIds: [],
    includedDirectNoteIds: [],
    baseline: {
      summary: baseline.summary,
      validatedOutcomes: [],
      decisions: [],
      contracts: baseline.contracts,
      risks: [],
      pendingWork: baseline.pendingWork,
      artifacts: [],
    },
  }, null, 2)}\n`);
  return root;
}

async function writeDirectDocument(memoryRoot: string, document: EvaluationDocument): Promise<void> {
  const stamp = document.id.slice(0, 16);
  const base = document.archived ? path.join(memoryRoot, "archive", "direct") : path.join(memoryRoot, "direct");
  const directory = path.join(base, stamp.slice(0, 4), stamp.slice(4, 6));
  await mkdir(directory, { recursive: true });
  const list = (label: string, values: string[]): string => `- **${label}:**${values.length
    ? `\n${values.map((value) => `  - ${value}`).join("\n")}`
    : " None"}`;
  const optionalList = (label: string, values: string[] | undefined): string => values?.length
    ? `\n${list(label, values)}`
    : "";
  await writeFile(path.join(directory, `${document.id}.md`), `# Sanitized retrieval evaluation record

- **Task:** ${document.task}
- **Outcome:** ${document.outcome}
${list("Decisions", document.decisions)}
${list("Risks or blockers", document.risks)}
${list("Next actions", document.nextActions)}
- **Changed files:** None
${list("Verification", document.verification)}
${list("Subjects", document.subjects)}${optionalList("Supersedes", document.supersedes)}
- **Status:** ${document.status ?? "active"}${document.reason ? `\n- **Reason:** ${document.reason}` : ""}
`);
}

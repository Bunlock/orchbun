import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { RunJournal } from "../src/journal.js";
import { compactMemory } from "../src/milestone-memory.js";
import { memoryPageCatalogue } from "../src/memory-pages.js";
import { rebuildMemory, verifyMemory } from "../src/memory.js";
import { sweepMemory } from "../src/memory-sweep.js";

async function configuredWorkspace(): Promise<{ root: string; journal: RunJournal }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configured-lifecycle-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryPages:
  enabled: [project-state]
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
`);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize(memoryPageCatalogue(await loadConfig(root)));
  await writeFile(path.join(journal.memoryRoot, "manual", "pages", "invoices.md"), "# Invoices\n\n- Keep invoice workflow.\n");
  await rebuildMemory(journal, root);
  return { root, journal };
}

test("compaction uses normalized semantics and republishes only configured pages", async () => {
  const { root, journal } = await configuredWorkspace();
  const direct = path.join(journal.memoryRoot, "direct", "2026", "09");
  await mkdir(direct, { recursive: true });
  await writeFile(path.join(direct, "20260918T080000Z-decision.md"), `# Durable decision

- **Task:** Preserve normalized state.
- **Outcome:** The configured lifecycle is exercised.
- **Decisions:** KEEP-NORMALIZED-DECISION
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** Reviewed.
`);
  await rebuildMemory(journal, root);

  const manifest = path.join(journal.memoryRoot, "milestones", "configured", "approved.yaml");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, `schema_version: "1.0"
milestone: configured
scope: shared
review:
  decision: accepted
  accepted_at: "2026-09-18T08:05:00Z"
  accepted_by: test
summary: Configured lifecycle accepted.
validated_outcomes: []
decisions: []
contracts: []
risks: []
pending_work: []
artifacts: []
supersedes: []
`);

  const receipt = await compactMemory(journal, manifest, "configured", "shared", new Date("2026-09-18T08:06:00Z"));
  const files = (await readdir(path.join(journal.memoryRoot, "working"))).sort();
  assert.deepEqual(files, ["compact-state.json", "invoices.md", "project-state.md"]);
  assert.match(await readFile(path.join(journal.memoryRoot, "working", "invoices.md"), "utf8"), /Keep invoice workflow/);
  assert.match(
    await readFile(path.join(journal.memoryRoot, receipt.archivePath, "working", "invoices.md"), "utf8"),
    /Keep invoice workflow/,
  );
  const state = JSON.parse(await readFile(path.join(journal.memoryRoot, "working", "compact-state.json"), "utf8")) as {
    baseline: { decisions: string[] };
  };
  assert.deepEqual(state.baseline.decisions, ["KEEP-NORMALIZED-DECISION"]);
});

test("verification accepts compact archives without a disabled project-state page", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configured-archive-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryPages:
  enabled: [decisions]
  custom: []
`);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize(memoryPageCatalogue(await loadConfig(root)));
  await rebuildMemory(journal, root);

  const manifest = path.join(journal.memoryRoot, "milestones", "no-project-state", "approved.yaml");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, `schema_version: "1.0"
milestone: no-project-state
scope: shared
review:
  decision: accepted
  accepted_at: "2026-09-18T08:05:00Z"
  accepted_by: test
summary: Archive without project state accepted.
validated_outcomes: []
decisions: []
contracts: []
risks: []
pending_work: []
artifacts: []
supersedes: []
`);

  const receipt = await compactMemory(journal, manifest, "no-project-state", "shared", new Date("2026-09-18T08:06:00Z"));
  const archivedWorking = path.join(journal.memoryRoot, receipt.archivePath, "working");
  await assert.rejects(readFile(path.join(archivedWorking, "project-state.md"), "utf8"));
  assert.match(await readFile(path.join(archivedWorking, "decisions.md"), "utf8"), /Decisions/);
  assert.deepEqual((await verifyMemory(journal)).issues, []);

  await rm(path.join(archivedWorking, "decisions.md"));
  assert.deepEqual((await verifyMemory(journal)).issues, [
    "compact no-project-state: archive is missing working/decisions.md",
  ]);
});

test("sweep reports and republishes the configured page catalogue", async () => {
  const { root, journal } = await configuredWorkspace();
  const receipt = await sweepMemory(journal, {
    projectRoot: root,
    executor: "test/configured-sweep",
    now: new Date("2026-09-18T09:00:00Z"),
  });

  assert.deepEqual(Object.keys(receipt.workingLines.before), ["project-state.md", "invoices.md"]);
  assert.deepEqual(Object.keys(receipt.workingLines.after), ["project-state.md", "invoices.md"]);
  assert.equal(receipt.verification.passed, true);
  const files = await readdir(path.join(journal.memoryRoot, "working"));
  assert.ok(files.includes("project-state.md"));
  assert.ok(files.includes("invoices.md"));
  assert.equal(files.includes("decisions.md"), false);
  assert.match(await readFile(path.join(journal.memoryRoot, "working", "invoices.md"), "utf8"), /Keep invoice workflow/);
});

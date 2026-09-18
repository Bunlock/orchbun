import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { saveMemoryOverride } from "../src/memory-overrides.js";
import { rebuildMemory } from "../src/memory.js";
import { loadApprovedMilestoneManifest } from "../src/milestone-memory.js";
import { setRoadmapTaskCompletion } from "../src/roadmap.js";
import { RoadmapConflictError } from "../src/roadmap-store.js";
import {
  approveMilestone,
  loadQualifications,
  qualify,
  readProjectMarkdown,
  saveQualification,
  writeProjectMarkdown,
} from "../src/memory-workspace.js";

async function workspace(): Promise<{ root: string; journal: RunJournal }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-workspace-"));
  await writeFile(path.join(root, "ROADMAP.md"), `# Roadmap

## A — Foundation

- [ ] **APP-A1** First validated step.
- [ ] **APP-A2** Second validated step.

## B — Later

- [ ] **APP-B1** Future work.
`);
  await writeFile(path.join(root, "AGENTS.md"), "# Agents\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize();
  await rebuildMemory(journal, root);
  return { root, journal };
}

test("manual page edits survive generated-memory rebuilds", async () => {
  const { root, journal } = await workspace();
  await saveMemoryOverride(journal.memoryRoot, "decisions", "# Decisions\n\n- Keep the web override.\n");
  await rebuildMemory(journal, root);
  assert.match(await readFile(path.join(journal.memoryRoot, "working", "decisions.md"), "utf8"), /Keep the web override/);
  assert.match(await readFile(path.join(journal.memoryRoot, "manual", "decisions.md"), "utf8"), /Keep the web override/);
});

test("project Markdown CRUD stays inside the project", async () => {
  const { root } = await workspace();
  await writeProjectMarkdown(root, "docs/master.md", "# Master\n");
  assert.equal(await readProjectMarkdown(root, "docs/master.md"), "# Master\n");
  await writeProjectMarkdown(root, "deep/nested/master.md", "# Nested\n");
  assert.equal(await readProjectMarkdown(root, "deep/nested/master.md"), "# Nested\n");
  await assert.rejects(writeProjectMarkdown(root, "../outside.md", "no"), /project-relative|inside the project/);
  await assert.rejects(writeProjectMarkdown(root, "secrets.json", "no"), /\.md/);
});

test("severity and urgency map to the documented P1-P5 matrix", async () => {
  assert.equal(qualify("critical", "high").priority, "P1");
  assert.equal(qualify("critical", "medium").priority, "P2");
  assert.equal(qualify("critical", "low").priority, "P3");
  assert.equal(qualify("major", "high").priority, "P2");
  assert.equal(qualify("major", "medium").priority, "P3");
  assert.equal(qualify("major", "low").priority, "P4");
  assert.equal(qualify("minor", "high").priority, "P3");
  assert.equal(qualify("minor", "medium").priority, "P4");
  assert.equal(qualify("minor", "low").priority, "P5");
  const { journal } = await workspace();
  const saved = await saveQualification(journal.memoryRoot, { kind: "task", id: "APP-A1", severity: "critical", urgency: "high", status: "blocked" });
  assert.equal(saved.priority, "P1");
  assert.equal((await loadQualifications(journal.memoryRoot))["task:APP-A1"]?.status, "blocked");
  await assert.rejects(saveQualification(journal.memoryRoot, { kind: "risk", id: "risk", severity: "minor", urgency: "low", status: "done" }), /risk status/);
});

test("roadmap validation gates schema-valid milestone approval", async () => {
  const { root, journal } = await workspace();
  await assert.rejects(approveMilestone(root, journal, "ROADMAP.md", "A"), /Complete every A step/);
  assert.equal(await setRoadmapTaskCompletion(root, "APP-A1", true), "updated");
  assert.equal(await setRoadmapTaskCompletion(root, "APP-A2", true), "updated");
  const receipt = await approveMilestone(root, journal, "ROADMAP.md", "A", "test-review", new Date("2026-08-12T12:00:00Z"));
  assert.equal(receipt.alreadyApproved, false);
  const manifestFile = path.join(journal.memoryRoot, receipt.manifestPath);
  const { manifest } = await loadApprovedMilestoneManifest(manifestFile);
  assert.equal(manifest.milestone, "a");
  assert.deepEqual(manifest.validated_outcomes.map((item) => item.slice(0, 6)), ["APP-A1", "APP-A2"]);
  assert.ok(manifest.pending_work.some((item) => item.startsWith("APP-B1")));
  assert.deepEqual(manifest.roadmap, {
    provider: "internal",
    identity: "internal:ROADMAP.md",
    artifact: "ROADMAP.md",
    revision: manifest.roadmap?.revision,
  });
  assert.equal((await approveMilestone(root, journal, "ROADMAP.md", "A")).alreadyApproved, true);

  const approved = await readFile(manifestFile, "utf8");
  await writeFile(path.join(root, "ROADMAP.md"), `${await readFile(path.join(root, "ROADMAP.md"), "utf8")}\nApproved under a later source revision.\n`);
  await assert.rejects(
    approveMilestone(root, journal, "ROADMAP.md", "A"),
    (error: unknown) => {
      assert.ok(error instanceof RoadmapConflictError);
      assert.match(error.message, /immutable approval evidence for a different roadmap source or revision/);
      return true;
    },
  );
  assert.equal(await readFile(manifestFile, "utf8"), approved);
});

test("generated milestone manifests are schema-validated before publication", async () => {
  const { root, journal } = await workspace();
  await setRoadmapTaskCompletion(root, "APP-A1", true);
  await setRoadmapTaskCompletion(root, "APP-A2", true);
  await assert.rejects(
    approveMilestone(root, journal, "ROADMAP.md", "A", "x".repeat(201)),
    /Generated milestone manifest failed schema validation.*accepted_by.*200/,
  );
  await assert.rejects(access(path.join(journal.memoryRoot, "milestones", "a", "approved.yaml")));
});

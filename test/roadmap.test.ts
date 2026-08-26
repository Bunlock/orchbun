import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DirectMemoryNote } from "../src/direct-memory.js";
import { completeRoadmapTask, loadRoadmap } from "../src/roadmap.js";
import { syncRoadmapProjection } from "../src/roadmap-projection.js";

test("completeRoadmapTask atomically checks only the matching stable task id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-"));
  await writeFile(path.join(root, "ROADMAP.md"), `# Roadmap

- [ ] **HEX-A3** Golden vector.
- [ ] **HEX-A30** Similar prefix remains open.
`);

  assert.equal(await completeRoadmapTask(root, "HEX-A3"), "updated");
  assert.equal(await completeRoadmapTask(root, "HEX-A3"), "already-complete");
  const roadmap = await readFile(path.join(root, "ROADMAP.md"), "utf8");
  assert.match(roadmap, /- \[x\] \*\*HEX-A3\*\*/);
  assert.match(roadmap, /- \[ \] \*\*HEX-A30\*\*/);
});

test("completeRoadmapTask leaves missing task ids untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n- [ ] **HEX-A1** Existing.\n");
  assert.equal(await completeRoadmapTask(root, "HEX-Z9"), "not-found");
  assert.equal(await completeRoadmapTask(path.join(root, "absent"), "HEX-Z9"), "missing");
});

const projectionRoadmap = `# Roadmap

## A — Foundation

- [ ] **HEX-A1** Hand-written step.

## Phase P — Product work tracked in direct notes

<!-- orchbun:phase-p:start -->
<!-- stale -->
<!-- orchbun:phase-p:end -->
`;

function note(overrides: Partial<DirectMemoryNote> & { id: string; task: string }): DirectMemoryNote {
  return {
    slug: overrides.id.slice(17),
    relativePath: `direct/2026/08/${overrides.id}.md`,
    timestamp: "2026-08-10T12:00:00Z",
    outcome: "Recorded.",
    decisions: [], risks: [], nextActions: [], changedFiles: [], verification: [],
    supersedes: [], subjects: [], status: "active",
    ...overrides,
  };
}

test("roadmap projection rewrites only its own region and never emits parseable tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-projection-"));
  await writeFile(path.join(root, "ROADMAP.md"), projectionRoadmap);

  const notes: DirectMemoryNote[] = [
    note({ id: "20260810T120000Z-ad-hoc-open", task: "**ZZZ-9** Tune the launcher copy", timestamp: "2026-08-10T12:00:00Z" }),
    note({ id: "20260810T120100Z-ad-hoc-done", task: "Fix the recovery code", timestamp: "2026-08-10T12:01:00Z", status: "retired", reason: "Shipped." }),
    note({ id: "20260810T120200Z-roadmapped", task: "HEX-A1 foundation work", timestamp: "2026-08-10T12:02:00Z" }),
  ];

  assert.equal(await syncRoadmapProjection(root, notes), "updated");
  const written = await readFile(path.join(root, "ROADMAP.md"), "utf8");
  assert.match(written, /- \[ \] ZZZ-9 Tune the launcher copy/);
  assert.match(written, /- \[x\] Fix the recovery code/);
  assert.doesNotMatch(written, /stale/);
  assert.doesNotMatch(written, /HEX-A1 foundation work/);
  assert.match(written, /- \[ \] \*\*HEX-A1\*\* Hand-written step\./);

  const parsed = await loadRoadmap(root);
  assert.deepEqual(parsed.tasks.map((task) => task.id), ["HEX-A1"]);
  assert.equal(parsed.tasks[0]?.milestone, "A");

  assert.equal(await syncRoadmapProjection(root, notes), "unchanged");
  assert.equal(await readFile(path.join(root, "ROADMAP.md"), "utf8"), written);
});

test("roadmap projection leaves a roadmap without ad-hoc notes untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-projection-empty-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## A — Foundation\n\n- [ ] **HEX-A1** Step.\n");
  assert.equal(await syncRoadmapProjection(root, []), "absent");
  assert.equal(await readFile(path.join(root, "ROADMAP.md"), "utf8"), "# Roadmap\n\n## A — Foundation\n\n- [ ] **HEX-A1** Step.\n");
});

test("roadmap projection appends its section when the markers are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-projection-append-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## A — Foundation\n\n- [ ] **HEX-A1** Step.\n");
  assert.equal(await syncRoadmapProjection(root, [note({ id: "20260810T120000Z-ad-hoc", task: "Ad-hoc work" })]), "updated");
  const written = await readFile(path.join(root, "ROADMAP.md"), "utf8");
  assert.match(written, /## Phase P — Product work tracked in direct notes\n\n<!-- orchbun:phase-p:start -->/);
  assert.match(written, /- \[ \] Ad-hoc work/);
});

test("milestone headings accept nested and Phase-prefixed forms without swallowing prose headings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-milestones-"));
  await writeFile(path.join(root, "ROADMAP.md"), `# Roadmap

## Invariants

- [x] **HEX-X1** Outside any milestone.

## A — Classic form

- [x] **HEX-A1** Done.

### Phase E0 — Environment contract (gate for everything else)

- [x] **HEX-ENV-0** Done.

#### Factory & Production

- [ ] **HEX-FACTORY-1** Still open under the same phase.

### 🔄 Follow-up Blockers (12 → 8 resolved)

- [ ] **HEX-FOLLOW-1** Emoji heading is not a milestone.
`);

  const parsed = await loadRoadmap(root);
  assert.deepEqual(parsed.tasks.map(({ id, milestone }) => ({ id, milestone })), [
    { id: "HEX-X1", milestone: "unscoped" },
    { id: "HEX-A1", milestone: "A" },
    { id: "HEX-ENV-0", milestone: "E0" },
    { id: "HEX-FACTORY-1", milestone: "E0" },
    { id: "HEX-FOLLOW-1", milestone: "E0" },
  ]);
  assert.equal(parsed.tasks[2]?.milestoneTitle, "Environment contract (gate for everything else)");
  assert.equal(parsed.activeMilestone, "E0");
});

test("roadmap projection keeps delivered entries after their note is archived", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-projection-retain-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## A — Foundation\n\n- [ ] **HEX-A1** Step.\n");
  const shipped = note({ id: "20260810T120000Z-shipped", task: "Ship the launcher", status: "retired", reason: "Delivered." });
  const next = () => note({ id: "20260810T120100Z-next", task: "Start the next thing" });

  assert.equal(await syncRoadmapProjection(root, [shipped]), "updated");
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /- \[x\] Ship the launcher/);

  // A sweep has archived the retired note; it is no longer under direct/.
  assert.equal(await syncRoadmapProjection(root, [next()]), "updated");
  const after = await readFile(path.join(root, "ROADMAP.md"), "utf8");
  assert.match(after, /- \[x\] Ship the launcher/);
  assert.match(after, /- \[ \] Start the next thing/);

  assert.equal(await syncRoadmapProjection(root, [next()]), "unchanged");
});

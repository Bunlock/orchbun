import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { rebuildMemory, verifyMemory } from "../src/memory.js";
import { loadRoadmap } from "../src/roadmap.js";
import { sleepMemory } from "../src/sleep-memory.js";

const roadmap = `# Roadmap

## A — Foundation

- [x] **HEX-A1** Finished foundation work.

## B — Playable

- [ ] **HEX-B1** Make the board usable
      on a phone.
- [ ] **HEX-B2** Add the result screen.

## C — Campaign

- [ ] **HEX-C1** Build the campaign.
`;

async function directNote(
  memoryRoot: string,
  timestamp: string,
  slug: string,
  task: string,
  nextAction: string,
): Promise<void> {
  const directory = path.join(memoryRoot, "direct", timestamp.slice(0, 4), timestamp.slice(4, 6));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${timestamp}-${slug}.md`), `# ${slug}

- **Task:** ${task}
- **Outcome:** Recorded a deterministic memory fixture.
- **Decisions:** None
- **Risks or blockers:** None
- **Next actions:** ${nextAction}
- **Changed files:** None
- **Verification:** Test fixture.
`);
}

test("roadmap parsing preserves order, lifecycle, and multiline task titles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-sleep-roadmap-"));
  await writeFile(path.join(root, "ROADMAP.md"), roadmap);

  const parsed = await loadRoadmap(root);
  assert.equal(parsed.activeMilestone, "B");
  assert.deepEqual(parsed.tasks.map(({ id, completed, milestone }) => ({ id, completed, milestone })), [
    { id: "HEX-A1", completed: true, milestone: "A" },
    { id: "HEX-B1", completed: false, milestone: "B" },
    { id: "HEX-B2", completed: false, milestone: "B" },
    { id: "HEX-C1", completed: false, milestone: "C" },
  ]);
  assert.equal(parsed.tasks[1]?.title, "Make the board usable on a phone.");
});

test("sleep publishes only the first incomplete milestone and rebuild keeps it reconciled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-sleep-"));
  const memoryRoot = path.join(root, "memory", "agents");
  const journal = new RunJournal(memoryRoot);
  await journal.initialize();
  await writeFile(path.join(root, "ROADMAP.md"), roadmap);
  await directNote(memoryRoot, "20260810T120000Z", "old-foundation", "HEX-A1 foundation", "Reopen HEX-A1.");
  await directNote(memoryRoot, "20260810T120100Z", "old-board", "HEX-B1 board", "Use the old HEX-B1 action.");
  await directNote(memoryRoot, "20260810T120200Z", "new-board", "HEX-B1 board", "Use the current HEX-B1 action.");
  await directNote(memoryRoot, "20260810T120300Z", "future-campaign", "HEX-C1 campaign", "Start HEX-C1 now.");
  await directNote(memoryRoot, "20260810T120400Z", "unlinked", "Investigate deployment", "Check the server.");

  const preview = await sleepMemory(root, journal, { publish: false });
  assert.equal(preview.published, false);
  assert.deepEqual(preview.snapshot.activeTasks.map((task) => task.taskId), ["HEX-B1", "HEX-B2"]);
  assert.equal(preview.snapshot.activeTasks[0]?.nextAction, "Use the current HEX-B1 action.");
  assert.equal(preview.snapshot.activeTasks[1]?.nextAction, "Add the result screen.");
  assert.deepEqual(preview.snapshot.scheduledTasks.map((task) => task.taskId), ["HEX-C1"]);
  assert.ok(preview.snapshot.excludedFollowups.some((item) => item.reason === "completed-roadmap-task"));
  assert.ok(preview.snapshot.excludedFollowups.some((item) => item.reason === "scheduled-roadmap-task"));
  assert.ok(preview.snapshot.excludedFollowups.some((item) => item.reason === "unlinked-followup"));

  const published = await sleepMemory(root, journal, { publish: true });
  assert.equal(published.snapshot.snapshotId, preview.snapshot.snapshotId);
  assert.equal(published.snapshotPath, `sleep/snapshots/${preview.snapshot.snapshotId}.json`);
  const active = await readFile(path.join(memoryRoot, "working", "active-tasks.md"), "utf8");
  assert.match(active, /HEX-B1 · Playable/);
  assert.match(active, /HEX-B2 · Playable/);
  assert.doesNotMatch(active, /HEX-A1|HEX-C1|deployment/i);

  await directNote(memoryRoot, "20260810T120500Z", "latest-board", "HEX-B1 board", "Ship the final HEX-B1 change.");
  await rebuildMemory(journal, root);
  const rebuilt = await readFile(path.join(memoryRoot, "working", "active-tasks.md"), "utf8");
  assert.match(rebuilt, /Ship the final HEX-B1 change/);
  assert.doesNotMatch(rebuilt, /HEX-A1|HEX-C1|deployment/i);

  const repeated = await sleepMemory(root, journal, { publish: true });
  assert.notEqual(repeated.snapshot.snapshotId, published.snapshot.snapshotId);
  const idempotent = await sleepMemory(root, journal, { publish: true });
  assert.equal(idempotent.snapshot.snapshotId, repeated.snapshot.snapshotId);
  assert.deepEqual((await verifyMemory(journal)).issues, []);
});

test("memory verification reports a missing sleep snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-sleep-invalid-"));
  const memoryRoot = path.join(root, "memory", "agents");
  const journal = new RunJournal(memoryRoot);
  await journal.initialize();
  await writeFile(path.join(memoryRoot, "sleep", "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    snapshotId: "a".repeat(64),
    roadmapPath: "ROADMAP.md",
  })}\n`);

  assert.ok((await verifyMemory(journal)).issues.some((issue) => issue.includes("sleep: snapshot")));
});

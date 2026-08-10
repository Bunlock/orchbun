import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completeRoadmapTask } from "../src/roadmap.js";

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

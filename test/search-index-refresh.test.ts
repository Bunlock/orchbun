import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { verifyMemory } from "../src/memory.js";
import { refreshMemory } from "../src/memory-refresh.js";

test("publishing refresh maintains the disposable search index and verification detects corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-search-refresh-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n- [ ] **ORCH-M1** Build retrieval.\n");
  const memoryRoot = path.join(root, "memory", "agents");
  const direct = path.join(memoryRoot, "direct", "2026", "09");
  await mkdir(direct, { recursive: true });
  await writeFile(path.join(direct, "20260917T120000Z-retrieval.md"), `# Retrieval

- **Task:** ORCH-M1
- **Outcome:** Published the local aurora index.
- **Decisions:** Keep derived search state disposable.
- **Risks or blockers:** None
- **Next actions:** Verify the index receipt.
- **Changed files:** None
- **Verification:** Focused refresh test.
`);
  const journal = new RunJournal(memoryRoot);

  const before = await refreshMemory(journal, root, false);
  await assert.rejects(readFile(path.join(memoryRoot, "search", "index-v1.json")), { code: "ENOENT" });

  const published = await refreshMemory(journal, root);
  assert.equal(published.projection.sourceRevision, before.projection.sourceRevision);
  const indexPath = path.join(memoryRoot, "search", "index-v1.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as { sourceRevision: string };
  assert.equal(index.sourceRevision, published.projection.sourceRevision);
  assert.deepEqual((await verifyMemory(journal, root)).issues, []);

  await writeFile(indexPath, "{broken");
  assert.ok((await verifyMemory(journal, root)).issues.some((issue) => issue.startsWith("search: search/index-v1.json: invalid JSON")));
  await refreshMemory(journal, root);
  assert.deepEqual((await verifyMemory(journal, root)).issues, []);

  await rm(path.dirname(indexPath), { recursive: true });
  await writeFile(path.dirname(indexPath), "index publication is temporarily unavailable");
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n- [x] **ORCH-M1** Build retrieval.\n");
  const authoritative = await refreshMemory(journal, root);
  assert.match(authoritative.diagnostics?.[0] ?? "", /Search index was not published/);
  assert.match(await readFile(path.join(memoryRoot, "working", "project-state.md"), "utf8"), /1\/1 steps checked/);

  await rm(path.dirname(indexPath));
  const healed = await refreshMemory(journal, root);
  assert.equal(healed.diagnostics, undefined);
  assert.equal(JSON.parse(await readFile(indexPath, "utf8")).sourceRevision, healed.projection.sourceRevision);
});

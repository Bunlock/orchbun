import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { refreshMemory } from "../src/memory-refresh.js";
import {
  MEMORY_PAGE_DEFINITIONS,
  applyMemoryOverrides,
  memoryPageCatalogue,
  readCustomMemoryPages,
  readMemoryAnnotations,
  saveMemoryOverride,
} from "../src/memory-overrides.js";

test("memory page catalogue retains default IDs, titles, filenames, and order", () => {
  const catalogue = memoryPageCatalogue();
  assert.deepEqual(
    catalogue.map(({ id, title, filename }) => [id, title, filename]),
    MEMORY_PAGE_DEFINITIONS,
  );
  assert.ok(catalogue.every((page) => page.kind === "builtin" && page.includeInContext));
});

test("memory page catalogue filters built-ins and appends validated custom pages", () => {
  const catalogue = memoryPageCatalogue({ memoryPages: {
    enabled: ["project-state", "contracts"],
    custom: [{
      id: "invoices",
      title: " Invoices ",
      includeInContext: false,
      starter: "# Invoices\r\n\r\n- [ ] Send September invoice.\r\n",
    }],
  } });

  assert.deepEqual(catalogue.map((page) => page.id), ["project-state", "contracts", "invoices"]);
  assert.deepEqual(catalogue[2], {
    id: "invoices",
    title: "Invoices",
    filename: "invoices.md",
    kind: "custom",
    includeInContext: false,
    starter: "# Invoices\r\n\r\n- [ ] Send September invoice.\r\n",
  });
  assert.throws(() => memoryPageCatalogue({ memoryPages: {
    enabled: [], custom: [{ id: "risks", title: "Wrong", includeInContext: false }],
  } }), /reserved/);
  assert.throws(() => memoryPageCatalogue({ memoryPages: {
    enabled: [], custom: [
      { id: "invoices", title: "Invoices", includeInContext: false },
      { id: "invoices", title: "Duplicate", includeInContext: true },
    ],
  } }), /Duplicate custom memory page id/i);
  assert.throws(() => memoryPageCatalogue({ memoryPages: {
    enabled: [], custom: [{ id: "Invoice Files", title: "Invoices", includeInContext: false }],
  } }), /lowercase slug/);
});

test("memory page catalogue preserves configured built-in order", () => {
  const catalogue = memoryPageCatalogue({ memoryPages: {
    enabled: ["risks", "project-state", "decisions"],
    custom: [],
  } });
  assert.deepEqual(catalogue.map((page) => page.id), ["risks", "project-state", "decisions"]);
});

test("journal initialization creates only configured page placeholders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-pages-init-"));
  const catalogue = memoryPageCatalogue({ memoryPages: {
    enabled: ["project-state"],
    custom: [{ id: "invoices", title: "Invoices", includeInContext: false, starter: "# Invoices\n\n- [ ] First invoice.\n" }],
  } });

  await new RunJournal(root).initialize(catalogue);

  assert.deepEqual((await readdir(path.join(root, "working"))).sort(), ["invoices.md", "project-state.md"]);
  assert.equal(await readFile(path.join(root, "manual", "pages", "invoices.md"), "utf8"), "# Invoices\n\n- [ ] First invoice.\n");
  await assert.rejects(access(path.join(root, "working", "risks.md")), { code: "ENOENT" });
});

test("publishing a manual config addition initializes its custom source after a read-only preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-pages-manual-config-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryPages:
  enabled: []
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
      starter: "# Invoice queue"
roadmap:
  provider: internal
  path: ROADMAP.md
`);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  const manual = path.join(journal.memoryRoot, "manual", "pages", "invoices.md");

  await refreshMemory(journal, root, false);
  await assert.rejects(access(manual), { code: "ENOENT" });
  await refreshMemory(journal, root);
  assert.equal(await readFile(manual, "utf8"), "# Invoice queue\n");
  assert.equal(await readFile(path.join(journal.memoryRoot, "working", "invoices.md"), "utf8"), "# Invoice queue\n");
});

test("disabled built-ins and removed custom pages retain manual content for re-enablement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-pages-retain-"));
  const enabled = memoryPageCatalogue({ memoryPages: {
    enabled: ["project-state", "decisions"],
    custom: [{ id: "invoices", title: "Invoices", includeInContext: false, starter: "# Invoices\n" }],
  } });
  const journal = new RunJournal(root);
  await journal.initialize(enabled);
  await saveMemoryOverride(root, "decisions", "# Decisions\n\n- Keep the durable choice.\n", enabled);
  await saveMemoryOverride(root, "invoices", "# Invoices\n\n- [x] Paid.\n", enabled);
  await applyMemoryOverrides(root, enabled);

  const reduced = memoryPageCatalogue({ memoryPages: { enabled: ["project-state"], custom: [] } });
  await applyMemoryOverrides(root, reduced);
  await assert.rejects(access(path.join(root, "working", "decisions.md")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "working", "invoices.md")), { code: "ENOENT" });
  assert.match(await readFile(path.join(root, "manual", "decisions.md"), "utf8"), /durable choice/);
  assert.match(await readFile(path.join(root, "manual", "pages", "invoices.md"), "utf8"), /Paid/);

  const renamed = memoryPageCatalogue({ memoryPages: {
    enabled: ["project-state", "decisions"],
    custom: [{ id: "invoices", title: "Billing", includeInContext: true }],
  } });
  await journal.initialize(renamed);
  await applyMemoryOverrides(root, renamed);

  assert.match(await readFile(path.join(root, "working", "decisions.md"), "utf8"), /durable choice/);
  assert.equal(await readFile(path.join(root, "working", "invoices.md"), "utf8"), "# Invoices\n\n- [x] Paid.\n");
  assert.equal((await readMemoryAnnotations(root, renamed)).invoices, "");
  assert.equal((await readCustomMemoryPages(root, renamed)).invoices, "# Invoices\n\n- [x] Paid.\n");
  assert.equal(renamed.at(-1)?.title, "Billing");
  assert.equal(renamed.at(-1)?.includeInContext, true);
});

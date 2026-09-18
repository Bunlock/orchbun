import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { RunJournal } from "../src/journal.js";
import { refreshMemory } from "../src/memory-refresh.js";
import { loadApprovedMilestoneManifest } from "../src/milestone-memory.js";
import { memoryPageCatalogue, saveMemoryOverride } from "../src/memory-overrides.js";
import { loadMemorySnapshot, memoryViewerHtml } from "../src/memory-web.js";
import { approveMilestone } from "../src/memory-workspace.js";
import { RoadmapConflictError } from "../src/roadmap-store.js";

async function configurableWorkspace(): Promise<{ root: string; journal: RunJournal }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configurable-web-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryPages:
  enabled: [project-state]
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
      starter: |
        # Invoices

        - [ ] First invoice.
roadmap:
  provider: internal
  path: ROADMAP.md
`);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## A — Foundation\n\n- [x] **APP-A1** Ship the configurable workspace.\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Agents\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize();
  return { root, journal };
}

test("memory web follows the configured page catalogue and exposes custom page metadata", async () => {
  const { root, journal } = await configurableWorkspace();
  const catalogue = memoryPageCatalogue(await loadConfig(root));
  await saveMemoryOverride(journal.memoryRoot, "invoices", "# Invoices\n\n- [x] Paid.\n", catalogue);

  const snapshot = await loadMemorySnapshot(journal.memoryRoot, root);
  assert.deepEqual(snapshot.pages.map(({ id }) => id), ["project-state", "invoices"]);
  assert.deepEqual(snapshot.pages[1], {
    id: "invoices",
    title: "Invoices",
    kind: "custom",
    includeInContext: false,
    markdown: "# Invoices\n\n- [x] Paid.\n",
    annotation: "",
  });
  assert.equal(snapshot.roadmap?.source.label, "ROADMAP.md");
  assert.equal(snapshot.roadmap?.freshness, "fresh");
});

test("milestone approval uses semantic sections when built-in pages are disabled", async () => {
  const { root, journal } = await configurableWorkspace();
  const state = await refreshMemory(journal, root);
  const receipt = await approveMilestone(root, journal, state.projection, "A", "test-review", new Date("2026-09-18T10:00:00Z"));
  const manifest = YAML.parse(await readFile(path.join(journal.memoryRoot, receipt.manifestPath), "utf8")) as {
    artifacts: Array<{ path: string; description: string }>;
    decisions: string[];
  };
  assert.deepEqual(manifest.decisions, []);
  assert.equal(manifest.artifacts[0]?.path, "ROADMAP.md");
  assert.match(manifest.artifacts[0]?.description ?? "", new RegExp(state.projection.roadmap!.revision));
});

test("external milestone approval publishes schema-valid immutable provider evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-external-milestone-"));
  const provider = path.join(root, "provider.mjs");
  const providerState = path.join(root, "provider-state.json");
  await writeFile(providerState, JSON.stringify({ revision: "jira-r1" }));
  await writeFile(provider, `
import { readFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.operation !== "list") process.exit(2);
const state = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({
  schema_version: "1.0",
  revision: state.revision,
  tasks: [{
    id: "JIRA-1",
    title: "Ship external roadmap approval.",
    completed: true,
    milestone_id: "A",
    milestone_title: "External foundation"
  }]
}));
`);
  await writeFile(path.join(root, "orchbun.yaml"), YAML.stringify({
    version: 1,
    roadmap: { provider: "external", name: "Fixture Jira", command: [process.execPath, provider, providerState] },
  }));
  await writeFile(path.join(root, "AGENTS.md"), "# Agents\n");
  const journal = new RunJournal(path.join(root, "memory", "agents"));
  await journal.initialize();

  const initial = await refreshMemory(journal, root);
  const receipt = await approveMilestone(root, journal, initial.projection, "A", "test-review", new Date("2026-09-18T12:00:00Z"));
  const manifestFile = path.join(journal.memoryRoot, receipt.manifestPath);
  const before = await readFile(manifestFile, "utf8");
  const { manifest } = await loadApprovedMilestoneManifest(manifestFile);
  assert.deepEqual(manifest.roadmap, {
    provider: "external",
    identity: initial.projection.roadmap!.source.identity,
    artifact: process.execPath,
    revision: "jira-r1",
  });
  assert.equal((await approveMilestone(root, journal, initial.projection, "A")).alreadyApproved, true);

  await writeFile(providerState, JSON.stringify({ revision: "jira-r2" }));
  const changed = await refreshMemory(journal, root);
  await assert.rejects(
    approveMilestone(root, journal, changed.projection, "A"),
    (error: unknown) => {
      assert.ok(error instanceof RoadmapConflictError);
      assert.equal(error.expectedRevision, "jira-r1");
      assert.equal(error.actualRevision, "jira-r2");
      return true;
    },
  );
  assert.equal(await readFile(manifestFile, "utf8"), before);
});

test("memory web routes roadmap completion separately from task qualifications", () => {
  const html = memoryViewerHtml();
  assert.match(html, /\/api\/roadmap\/tasks/);
  assert.match(html, /custom\?p\.markdown:p\.annotation/);
  assert.match(html, /External roadmap/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  BUILTIN_MEMORY_PAGE_IDS,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfigText,
  setupSpecFromConfig,
  validateMemoryPagesConfig,
  validateRoadmapConfig,
  type SetupSpec,
} from "../src/config.js";
import {
  ConfigurationConflictError,
  configureWorkspace,
  setupSpecForConfigurationRetry,
  updateSetupSections,
} from "../src/configure.js";
import { initializeWorkspace } from "../src/init.js";
import { loadRoadmap, parseRoadmapMarkdown } from "../src/roadmap.js";
import { collectSetupSelection, collectSetupSpec, parseRoadmapCommand } from "../src/setup-wizard.js";

const execute = promisify(execFile);

function setup(overrides: Partial<SetupSpec> = {}): SetupSpec {
  return {
    memoryPages: { enabled: [...BUILTIN_MEMORY_PAGE_IDS], custom: [] },
    roadmap: { provider: "internal", path: "ROADMAP.md" },
    ...overrides,
  };
}

test("setup wizard collects page and custom-process choices before applying", async () => {
  const answers = [
    "", "", // internal provider and ROADMAP.md
    "", "", "", "", "n", // four built-ins enabled, risks disabled
    "y", "invoices", "Invoices", "", "# Invoices", // custom page, context defaults off
    "", // no additional custom page
    "", // apply reviewed choices
  ];
  const output: string[] = [];
  const selected = await collectSetupSpec({
    ask: async () => answers.shift() ?? (() => { throw new Error("Unexpected wizard prompt"); })(),
    write: (message) => output.push(message),
  }, { root: "/tmp/project" });

  assert.deepEqual(selected, setup({
    memoryPages: {
      enabled: ["project-state", "active-tasks", "decisions", "contracts"],
      custom: [{ id: "invoices", title: "Invoices", includeInContext: false, starter: "# Invoices" }],
    },
  }));
  assert.match(output.join(""), /Risks and blockers disabled; existing annotation retained/);
  assert.match(output.join(""), /Invoices added; excluded from agent context/);
  assert.equal(answers.length, 0);
});

test("setup wizard returns from a failed external provider to internal settings", async () => {
  const answers = ["external", ...Array<string>(12).fill("")];
  const output: string[] = [];
  let validations = 0;
  const selected = await collectSetupSpec({
    ask: async () => answers.shift() ?? (() => { throw new Error("Unexpected wizard prompt"); })(),
    write: (message) => output.push(message),
  }, {
    root: "/tmp/project",
    validateExternalRoadmap: async () => {
      validations += 1;
      throw new Error("provider offline");
    },
  });

  assert.deepEqual(selected, setup());
  assert.equal(validations, 1);
  assert.match(output.join(""), /External roadmap validation failed: provider offline/);
  assert.equal(answers.length, 0);
});

test("a no-op wizard keeps the configured built-in page order", async () => {
  const answers = Array<string>(9).fill("");
  const output: string[] = [];
  const current = setup({
    memoryPages: { enabled: ["risks", "project-state"], custom: [] },
  });

  const selected = await collectSetupSpec({
    ask: async () => answers.shift() ?? (() => { throw new Error("Unexpected wizard prompt"); })(),
    write: (message) => output.push(message),
  }, { root: "/tmp/project", current });

  assert.deepEqual(selected, current);
  assert.match(output.join(""), /Built-in memory pages: Risks and blockers, Project state/);
  assert.match(output.join(""), /No setup changes/);
  assert.equal(answers.length, 0);
});

test("configure wizard requires an explicit choice before creating a missing internal roadmap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-create-roadmap-"));
  const answers = [
    "", "docs/PLAN.md", "", // internal provider, missing path, explicitly create it
    "", "", "", "", "", // all built-ins enabled
    "", // no custom process
    "", // apply
  ];
  const output: string[] = [];
  const selected = await collectSetupSelection({
    ask: async () => answers.shift() ?? (() => { throw new Error("Unexpected wizard prompt"); })(),
    write: (message) => output.push(message),
  }, { root, allowCreateInternalRoadmap: true });

  assert.equal(selected?.createInternalRoadmap, true);
  assert.deepEqual(selected?.setup.roadmap, { provider: "internal", path: "docs/PLAN.md" });
  assert.match(output.join(""), /Roadmap file: create docs\/PLAN\.md/);
  await assert.rejects(readFile(path.join(root, "docs", "PLAN.md")), /ENOENT/);
  assert.equal(answers.length, 0);
});

test("config resolves backward defaults and honors the legacy local roadmap selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-config-defaults-"));
  await mkdir(path.join(root, "memory", "agents", "manual"), { recursive: true });
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "memory", "agents", "manual", "web-settings.json"), JSON.stringify({
    roadmapPath: "docs/PLAN.md",
    agentsPath: "AGENTS.md",
  }));

  const config = await loadConfig(root);
  assert.deepEqual(config.memoryPages, DEFAULT_CONFIG.memoryPages);
  assert.deepEqual(config.roadmap, { provider: "internal", path: "docs/PLAN.md" });
  assert.notEqual(config.memoryPages.enabled, DEFAULT_CONFIG.memoryPages.enabled);
});

test("new config sections reject reserved ids, duplicates, oversized text, and unsafe providers", () => {
  assert.throws(() => validateMemoryPagesConfig({
    enabled: ["risks", "risks"],
    custom: [],
  }), /duplicate/i);
  assert.throws(() => validateMemoryPagesConfig({
    enabled: [],
    custom: [{ id: "risks", title: "Mine" }],
  }), /reserved/i);
  assert.throws(() => validateMemoryPagesConfig({
    enabled: [],
    custom: [{ id: "invoices", title: "x", starter: "x".repeat(64_001) }],
  }), /starter/i);
  assert.throws(() => validateRoadmapConfig({ provider: "internal", path: "../ROADMAP.md" }), /inside the project/i);
  assert.throws(() => validateRoadmapConfig({ provider: "external", name: "Jira", command: [] }), /executable/i);
  assert.throws(() => parseRoadmapCommand("node provider.mjs"), /JSON string array/i);
  assert.deepEqual(parseRoadmapCommand('["node","provider.mjs"]'), ["node", "provider.mjs"]);
  assert.throws(() => parseConfigText("version: 2\n"), /version must be 1/i);
});

test("loaded configuration validates every consumed section and memoryDir boundary", async () => {
  assert.throws(() => parseConfigText("budgets:\n  maxInputChars: many\n"), /budgets\.maxInputChars must be an integer/i);
  assert.throws(() => parseConfigText("agents:\n  default: unknown\n"), /agents\.default must be one of/i);
  assert.throws(() => parseConfigText("delegation:\n  defaultMode: deploy\n"), /delegation\.defaultMode must be one of/i);
  assert.throws(() => parseConfigText("images: fast\n"), /images must be a mapping/i);
  assert.throws(() => parseConfigText("hooks:\n  after_memory_rebuild: false\n"), /hooks\.after_memory_rebuild must be a string/i);
  assert.throws(() => parseConfigText("isolation: false\n"), /isolation must be a mapping/i);
  assert.throws(() => parseConfigText("isolation:\n  enabled: yes\n"), /isolation\.enabled must be true or false/i);
  assert.throws(() => parseConfigText("isolation:\n  runtime:\n    frontendPorts: [4300, 4200]\n"), /ascending range/i);
  assert.throws(() => parseConfigText("memoryDir: .\n"), /memoryDir must be an absolute path or a project-relative directory/i);
  assert.throws(() => parseConfigText("memoryDir: ../shared\n"), /memoryDir must be an absolute path or a project-relative directory/i);
  assert.equal(parseConfigText("memoryDir: .local/orchbun\n").memoryDir, ".local/orchbun");
  assert.equal(parseConfigText(`memoryDir: ${JSON.stringify(path.join(os.tmpdir(), "orchbun-absolute-memory"))}\n`).memoryDir, path.join(os.tmpdir(), "orchbun-absolute-memory"));

  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-config-memory-root-"));
  await writeFile(path.join(root, "orchbun.yaml"), YAML.stringify({ version: 1, memoryDir: root }));
  await assert.rejects(loadConfig(root), /memoryDir cannot be the project root/i);
});

test("init persists selected pages, validates external providers, writes starters, and creates no internal roadmap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-setup-"));
  const selected = setup({
    memoryPages: {
      enabled: ["project-state", "decisions"],
      custom: [{ id: "invoices", title: "Invoices", includeInContext: false, starter: "# Invoice queue\n\n- [ ] Review" }],
    },
    roadmap: { provider: "external", name: "Jira", command: ["node", "tools/jira.mjs"] },
  });
  let validated = false;
  const receipt = await initializeWorkspace(root, {
    setup: selected,
    validateExternalRoadmap: async (_root, roadmap) => { validated = roadmap.name === "Jira"; },
    publishMemory: async () => undefined,
  });

  assert.equal(validated, true);
  assert.equal(receipt.memoryRoot, path.join(root, "memory", "agents"));
  assert.equal(await readFile(path.join(root, "memory", "agents", "manual", "pages", "invoices.md"), "utf8"), "# Invoice queue\n\n- [ ] Review\n");
  await assert.rejects(readFile(path.join(root, "ROADMAP.md"), "utf8"), /ENOENT/);
  const config = await loadConfig(root);
  assert.deepEqual(setupSpecFromConfig(config), selected);
});

test("init reuses an existing config memoryDir and remains non-destructive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-effective-dir-"));
  await writeFile(path.join(root, "orchbun.yaml"), `version: 1
memoryDir: .local/orchbun
memoryPages:
  enabled: [project-state]
  custom:
    - id: invoices
      title: Invoices
      includeInContext: false
roadmap:
  provider: internal
  path: docs/PLAN.md
`);
  const receipt = await initializeWorkspace(root, { publishMemory: async () => undefined });
  assert.equal(receipt.memoryRoot, path.join(root, ".local", "orchbun"));
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\.local\/orchbun\/$/m);
  assert.match(await readFile(path.join(root, "docs", "PLAN.md"), "utf8"), /Foundation/);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /\.local\/orchbun\/working/);
  assert.equal((await readFile(path.join(root, "orchbun.yaml"), "utf8")).includes("budgets:"), false);
});

test("init and configure never create an internal roadmap through a symlink outside the project", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orchbun-setup-roadmap-symlink-"));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await symlink(outside, path.join(root, "plans"), "dir");
  const selected = setup({ roadmap: { provider: "internal", path: "plans/ROADMAP.md" } });

  await assert.rejects(initializeWorkspace(root, {
    setup: selected,
    publishMemory: async () => undefined,
  }), /resolving symlinks/);
  await assert.rejects(readFile(path.join(outside, "ROADMAP.md"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(root, "orchbun.yaml"), "utf8"), /ENOENT/);

  const originalConfig = "version: 1\n";
  await writeFile(path.join(root, "orchbun.yaml"), originalConfig);
  await assert.rejects(configureWorkspace(root, {
    setup: selected,
    createInternalRoadmap: true,
    refresh: async () => { throw new Error("refresh must not run"); },
  }), /resolving symlinks/);
  assert.equal(await readFile(path.join(root, "orchbun.yaml"), "utf8"), originalConfig);
  await assert.rejects(readFile(path.join(outside, "ROADMAP.md"), "utf8"), /ENOENT/);
});

test("configure previews and creates a missing internal roadmap through an in-project symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-roadmap-alias-"));
  await mkdir(path.join(root, "docs"));
  await symlink(path.join(root, "docs"), path.join(root, "alias"), "dir");
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  const selected = setup({ roadmap: { provider: "internal", path: "alias/PLAN.md" } });
  let previewed = false;

  const receipt = await configureWorkspace(root, {
    setup: selected,
    createInternalRoadmap: true,
    preview: async ({ config, pendingFiles }) => {
      const pendingRoadmaps = pendingFiles.filter((file) => file.kind === "roadmap");
      assert.equal(pendingRoadmaps.length, 1);
      assert.equal(pendingRoadmaps[0]?.path, path.join(await realpath(path.join(root, "docs")), "PLAN.md"));
      const parsed = parseRoadmapMarkdown(pendingRoadmaps[0]!.content, config.roadmap.provider === "internal" ? config.roadmap.path : "");
      assert.equal(parsed.path, "alias/PLAN.md");
      assert.equal(parsed.tasks.length, 1);
      previewed = true;
    },
    refresh: async ({ config }) => {
      assert.equal(config.roadmap.provider, "internal");
      assert.equal(config.roadmap.path, "alias/PLAN.md");
      assert.equal((await loadRoadmap(root, config.roadmap.path)).tasks.length, 1);
      return { revision: "alias-revision" };
    },
  });

  assert.equal(previewed, true);
  assert.equal(receipt.revision, "alias-revision");
  assert.equal(receipt.created.includes("alias/PLAN.md"), true);
  assert.match(await readFile(path.join(root, "docs", "PLAN.md"), "utf8"), /Foundation/);
  assert.deepEqual(setupSpecFromConfig(await loadConfig(root)).roadmap, { provider: "internal", path: "alias/PLAN.md" });
});

test("init ignores an absolute memoryDir that is located inside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-absolute-dir-"));
  const absoluteMemory = path.join(root, ".local", "orchbun");
  await writeFile(path.join(root, "orchbun.yaml"), YAML.stringify({ version: 1, memoryDir: absoluteMemory }));

  const receipt = await initializeWorkspace(root, { publishMemory: async () => undefined });

  assert.equal(receipt.memoryRoot, absoluteMemory);
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\.local\/orchbun\/$/m);
});

test("failed init removes only its unchanged files and restores the prior memory projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-rollback-"));
  const memoryRoot = path.join(root, "memory", "agents");
  await mkdir(path.join(memoryRoot, "working"), { recursive: true });
  await writeFile(path.join(memoryRoot, "working", "project-state.md"), "existing projection\n");
  const selected = setup({
    memoryPages: {
      enabled: ["project-state"],
      custom: [{ id: "invoices", title: "Invoices", includeInContext: false }],
    },
  });

  await assert.rejects(initializeWorkspace(root, {
    setup: selected,
    publishMemory: async (journal) => {
      await writeFile(path.join(journal.memoryRoot, "working", "project-state.md"), "partial projection\n");
      throw new Error("publication failed");
    },
  }), /publication failed/);

  assert.equal(await readFile(path.join(memoryRoot, "working", "project-state.md"), "utf8"), "existing projection\n");
  for (const relative of ["orchbun.yaml", "ROADMAP.md", "AGENTS.md", ".gitignore", "memory/agents/manual/pages/invoices.md"]) {
    await assert.rejects(readFile(path.join(root, relative), "utf8"), /ENOENT/);
  }
});

test("a losing concurrent init never rolls back the winning initializer's files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-concurrent-"));
  const winningConfig = "version: 1\n# created by the winning initializer\n";
  const winningMemory = path.join(root, "memory", "agents", "working", "project-state.md");
  const selected = setup({
    roadmap: { provider: "external", name: "Jira", command: [process.execPath, "provider.mjs"] },
  });

  await assert.rejects(initializeWorkspace(root, {
    setup: selected,
    validateExternalRoadmap: async () => {
      await writeFile(path.join(root, "orchbun.yaml"), winningConfig, { flag: "wx" });
      await mkdir(path.dirname(winningMemory), { recursive: true });
      await writeFile(winningMemory, "winner projection\n");
    },
    publishMemory: async () => { throw new Error("loser must not publish"); },
  }), /created concurrently/);

  assert.equal(await readFile(path.join(root, "orchbun.yaml"), "utf8"), winningConfig);
  assert.equal(await readFile(winningMemory, "utf8"), "winner projection\n");
});

test("an init waiting on a failed initializer cannot succeed after its observed config is rolled back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-rollback-race-"));
  let publishStarted!: () => void;
  const publishing = new Promise<void>((resolve) => { publishStarted = resolve; });
  let failPublication!: () => void;
  const releasePublication = new Promise<void>((resolve) => { failPublication = resolve; });

  const firstFailure = assert.rejects(initializeWorkspace(root, {
    publishMemory: async () => {
      publishStarted();
      await releasePublication;
      throw new Error("first publication failed");
    },
  }), /first publication failed/);
  await publishing;

  let secondSettled = false;
  const secondFailure = assert.rejects(
    initializeWorkspace(root, { publishMemory: async () => undefined })
      .finally(() => { secondSettled = true; }),
    /orchbun\.yaml was removed while initialization was waiting/,
  );
  // The second initializer must observe the first one's configuration before
  // it blocks on the projection lock. Two lock retry intervals keep this
  // ordering deterministic without exposing a production-only test hook.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondSettled, false);
  failPublication();

  await Promise.all([firstFailure, secondFailure]);
  await assert.rejects(readFile(path.join(root, "orchbun.yaml"), "utf8"), /ENOENT/);
});

test("configure changes only managed YAML sections, keeps comments and unknown keys, and publishes under the new config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## A — Foundation\n\n- [ ] **APP-A1** Step.\n");
  await writeFile(path.join(root, "orchbun.yaml"), `# project config
version: 1 # keep version comment
memoryDir: memory/agents
unknown:
  keep: yes # keep unknown comment
budgets:
  maxInputChars: 7777
`);
  const selected = setup({
    memoryPages: {
      enabled: ["project-state", "active-tasks", "decisions", "contracts"],
      custom: [{ id: "invoices", title: "Invoices", includeInContext: false }],
    },
  });
  let previewed = false;
  const receipt = await configureWorkspace(root, {
    setup: selected,
    preview: async ({ config }) => { previewed = config.budgets.maxInputChars === 7777; },
    refresh: async ({ config }) => {
      assert.deepEqual(config.memoryPages, selected.memoryPages);
      assert.deepEqual(setupSpecFromConfig(await loadConfig(root)), selected);
      return { revision: "candidate-revision" };
    },
  });

  assert.equal(previewed, true);
  assert.equal(receipt.revision, "candidate-revision");
  assert.equal(receipt.created.includes("memory/agents/manual/pages/invoices.md"), true);
  assert.match(receipt.changes.join("\n"), /Risks and blockers disabled/);
  const written = await readFile(path.join(root, "orchbun.yaml"), "utf8");
  assert.match(written, /^# project config$/m);
  assert.match(written, /version: 1 # keep version comment/);
  assert.match(written, /keep: yes # keep unknown comment/);
  assert.equal((YAML.parse(written) as { unknown: { keep: string } }).unknown.keep, "yes");
  assert.equal(await readFile(path.join(root, "memory", "agents", "manual", "pages", "invoices.md"), "utf8"), "# Invoices\n");
});

test("configure rolls back config and newly staged pages when candidate refresh fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-rollback-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const original = "# original\nversion: 1\nunknown: retained\n";
  await writeFile(path.join(root, "orchbun.yaml"), original);
  const memoryRoot = path.join(root, "memory", "agents");
  await mkdir(path.join(memoryRoot, "working"), { recursive: true });
  await mkdir(path.join(memoryRoot, "refresh"), { recursive: true });
  await mkdir(path.join(memoryRoot, "search"), { recursive: true });
  await mkdir(path.join(memoryRoot, "cache", "roadmap"), { recursive: true });
  await writeFile(path.join(memoryRoot, "working", "project-state.md"), "before working\n");
  await writeFile(path.join(memoryRoot, "refresh", "state.json"), "before refresh\n");
  await writeFile(path.join(memoryRoot, "index.md"), "before index\n");
  await writeFile(path.join(memoryRoot, "search", "index.json"), "before search\n");
  await writeFile(path.join(memoryRoot, "cache", "roadmap", "before.json"), "before cache\n");
  const selected = setup({
    memoryPages: {
      enabled: ["project-state"],
      custom: [{ id: "invoices", title: "Invoices", includeInContext: true }],
    },
  });

  await assert.rejects(configureWorkspace(root, {
    setup: selected,
    refresh: async () => {
      await writeFile(path.join(memoryRoot, "working", "project-state.md"), "candidate working\n");
      await writeFile(path.join(memoryRoot, "refresh", "state.json"), "candidate refresh\n");
      await writeFile(path.join(memoryRoot, "index.md"), "candidate index\n");
      await writeFile(path.join(memoryRoot, "search", "index.json"), "candidate search\n");
      await writeFile(path.join(memoryRoot, "cache", "roadmap", "before.json"), "candidate cache\n");
      await writeFile(path.join(memoryRoot, "cache", "roadmap", "candidate.json"), "new cache\n");
      throw new Error("projection rejected");
    },
  }), /projection rejected/);
  assert.equal(await readFile(path.join(root, "orchbun.yaml"), "utf8"), original);
  assert.equal(await readFile(path.join(memoryRoot, "working", "project-state.md"), "utf8"), "before working\n");
  assert.equal(await readFile(path.join(memoryRoot, "refresh", "state.json"), "utf8"), "before refresh\n");
  assert.equal(await readFile(path.join(memoryRoot, "index.md"), "utf8"), "before index\n");
  assert.equal(await readFile(path.join(memoryRoot, "search", "index.json"), "utf8"), "before search\n");
  assert.equal(await readFile(path.join(memoryRoot, "cache", "roadmap", "before.json"), "utf8"), "before cache\n");
  await assert.rejects(readFile(path.join(memoryRoot, "cache", "roadmap", "candidate.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(root, "memory", "agents", "manual", "pages", "invoices.md"), "utf8"), /ENOENT/);
});

test("the next CLI startup rolls back a process loss after config replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-crash-"));
  const original = "# original\nversion: 1\nunknown: retained\n";
  await writeFile(path.join(root, "orchbun.yaml"), original);
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const memoryRoot = path.join(root, "memory", "agents");
  await mkdir(path.join(memoryRoot, "working"), { recursive: true });
  await mkdir(path.join(memoryRoot, "refresh"), { recursive: true });
  await mkdir(path.join(memoryRoot, "search"), { recursive: true });
  await mkdir(path.join(memoryRoot, "cache", "roadmap"), { recursive: true });
  await writeFile(path.join(memoryRoot, "working", "project-state.md"), "before working\n");
  await writeFile(path.join(memoryRoot, "refresh", "state.json"), "before refresh\n");
  await writeFile(path.join(memoryRoot, "index.md"), "before index\n");
  await writeFile(path.join(memoryRoot, "search", "index.json"), "before search\n");
  await writeFile(path.join(memoryRoot, "cache", "roadmap", "before.json"), "before cache\n");

  const configureModule = new URL("../src/configure.ts", import.meta.url).href;
  const childScript = `
    import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { configureWorkspace } from ${JSON.stringify(configureModule)};
    const root = process.argv[1];
    await configureWorkspace(root, {
      setup: {
        memoryPages: {
          enabled: ["project-state"],
          custom: [
            { id: "invoices", title: "Invoices", includeInContext: false },
            { id: "receipts", title: "Receipts", includeInContext: false },
          ],
        },
        roadmap: { provider: "internal", path: "ROADMAP.md" },
      },
      refresh: async ({ journal }) => {
        await writeFile(path.join(journal.memoryRoot, "working", "project-state.md"), "candidate working\\n");
        await writeFile(path.join(journal.memoryRoot, "refresh", "state.json"), "candidate refresh\\n");
        await writeFile(path.join(journal.memoryRoot, "index.md"), "candidate index\\n");
        await writeFile(path.join(journal.memoryRoot, "search", "index.json"), "candidate search\\n");
        await mkdir(path.join(journal.memoryRoot, "cache", "roadmap"), { recursive: true });
        await writeFile(path.join(journal.memoryRoot, "cache", "roadmap", "candidate.json"), "candidate cache\\n");
        process.exit(73);
      },
    });
  `;
  await assert.rejects(
    execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript, root]),
    (error: unknown) => (error as { code?: number }).code === 73,
  );
  assert.notEqual(await readFile(path.join(root, "orchbun.yaml"), "utf8"), original);
  assert.equal(await readFile(path.join(memoryRoot, "working", "project-state.md"), "utf8"), "candidate working\n");
  const manualPages = path.join(memoryRoot, "manual", "pages");
  const invoices = path.join(manualPages, "invoices.md");
  const receipts = path.join(manualPages, "receipts.md");
  assert.equal(await readFile(invoices, "utf8"), "# Invoices\n");
  assert.equal(await readFile(receipts, "utf8"), "# Receipts\n");
  const pending = JSON.parse(await readFile(path.join(memoryRoot, "configure", "pending.json"), "utf8")) as {
    createdFiles: Array<{ scope: string; path: string }>;
  };
  assert.deepEqual(pending.createdFiles.map((file) => [file.scope, file.path]), [
    ["memory", "manual/pages/invoices.md"],
    ["memory", "manual/pages/receipts.md"],
  ]);
  assert.equal((await readdir(manualPages)).filter((entry) => entry.startsWith(".orchbun-configure-")).length, 2);

  // Replace one owned target with a different inode after the crash. Recovery
  // may remove only the file it can still prove belongs to this transaction.
  await rm(receipts);
  await writeFile(receipts, "# Human receipts\n");

  const cli = path.resolve("src/cli.ts");
  await execute(process.execPath, ["--import", "tsx", cli, "memory", "runs", "--root", root]);

  assert.equal(await readFile(path.join(root, "orchbun.yaml"), "utf8"), original);
  assert.equal(await readFile(path.join(memoryRoot, "working", "project-state.md"), "utf8"), "before working\n");
  assert.equal(await readFile(path.join(memoryRoot, "refresh", "state.json"), "utf8"), "before refresh\n");
  assert.equal(await readFile(path.join(memoryRoot, "index.md"), "utf8"), "before index\n");
  assert.equal(await readFile(path.join(memoryRoot, "search", "index.json"), "utf8"), "before search\n");
  assert.equal(await readFile(path.join(memoryRoot, "cache", "roadmap", "before.json"), "utf8"), "before cache\n");
  await assert.rejects(readFile(path.join(memoryRoot, "cache", "roadmap", "candidate.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(invoices, "utf8"), /ENOENT/);
  assert.equal(await readFile(receipts, "utf8"), "# Human receipts\n");
  assert.equal((await readdir(manualPages)).some((entry) => entry.startsWith(".orchbun-configure-")), false);
  await assert.rejects(readFile(path.join(memoryRoot, "configure", "pending.json"), "utf8"), /ENOENT/);
});

test("configuration review detects concurrent YAML edits before applying", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-conflict-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const configPath = path.join(root, "orchbun.yaml");
  await writeFile(configPath, "version: 1\n");
  let conflict: unknown;
  await assert.rejects(configureWorkspace(root, {
    setup: setup(),
    preview: async () => { await writeFile(configPath, `version: 1
memoryPages:
  enabled: [risks]
  custom: []
roadmap:
  provider: internal
  path: ROADMAP.md
# concurrent
`); },
    refresh: async () => undefined,
  }), (error: unknown) => {
    conflict = error;
    return error instanceof ConfigurationConflictError
      && /changed while configuration was being reviewed/.test(error.message);
  });
  assert.deepEqual(await setupSpecForConfigurationRetry(root, setup(), conflict), setup({
    memoryPages: { enabled: ["risks"], custom: [] },
  }));
  const rejectedCandidate = setup({ memoryPages: { enabled: ["decisions"], custom: [] } });
  assert.deepEqual(
    await setupSpecForConfigurationRetry(root, rejectedCandidate, new Error("provider unavailable")),
    rejectedCandidate,
  );
});

test("configuration install preserves an edit made after the projection backup starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-install-conflict-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const configPath = path.join(root, "orchbun.yaml");
  await writeFile(configPath, "version: 1\n");
  const transactionDirectory = path.join(root, "memory", "agents", "configure");
  const humanEdit = "version: 1\n# edit during install\n";
  let editFinished: Promise<void> | undefined;

  await assert.rejects(configureWorkspace(root, {
      setup: setup({
        memoryPages: {
          enabled: ["project-state"],
          custom: [{
            id: "invoices",
            title: "Invoices",
            includeInContext: false,
            starter: "x".repeat(64_000),
          }],
        },
      }),
      preview: async () => {
        await mkdir(transactionDirectory, { recursive: true });
        editFinished = (async () => {
          while (true) {
            try {
              await readFile(path.join(transactionDirectory, "pending.json"), "utf8");
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          await writeFile(configPath, humanEdit);
        })();
      },
      refresh: async () => { throw new Error("refresh must not run after an install conflict"); },
    }), (error: unknown) => {
      const messages = error instanceof AggregateError
        ? error.errors.map((entry) => entry instanceof Error ? entry.message : String(entry)).join("\n")
        : error instanceof Error ? error.message : String(error);
      return /changed while configuration was being installed/.test(messages);
    });
  await editFinished;
  assert.equal(await readFile(configPath, "utf8"), humanEdit);
  await assert.rejects(readFile(path.join(root, "memory", "agents", "manual", "pages", "invoices.md"), "utf8"), /ENOENT/);
});

test("configuration rollback never overwrites a human edit made during publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-configure-publish-conflict-"));
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const configPath = path.join(root, "orchbun.yaml");
  await writeFile(configPath, "version: 1\n");
  const humanEdit = "version: 1\n# human edit during publication\n";

  await assert.rejects(configureWorkspace(root, {
    setup: setup(),
    refresh: async () => { await writeFile(configPath, humanEdit); },
  }), /rollback was incomplete/);
  assert.equal(await readFile(configPath, "utf8"), humanEdit);
});

test("YAML document updates preserve unrelated formatting without mutating the input sections", () => {
  const source = "# heading\nversion: 1\ncustom: { left: alone } # comment\n";
  const updated = updateSetupSections(source, setup());
  assert.match(updated, /^# heading$/m);
  assert.match(updated, /custom: \{ left: alone \} # comment/);
  assert.deepEqual((YAML.parse(updated) as { custom: unknown }).custom, { left: "alone" });
});

test("YAML managed-section updates preserve comments, flow style, and retained custom item nodes", () => {
  const source = `# heading
version: 1
memoryPages: # page catalogue
  enabled: [project-state, risks] # selected pages
  custom: # local processes
    - id: invoices # stable id
      title: Invoice queue # displayed title
      includeInContext: false # prompt policy
      starter: old # optional starter
    - id: shipping
      title: Shipping
      includeInContext: false
roadmap: # task authority
  provider: internal # provider kind
  path: ROADMAP.md # local file
unknown: { left: alone } # untouched
`;
  const updated = updateSetupSections(source, {
    memoryPages: {
      enabled: ["risks", "project-state"],
      custom: [
        { id: "invoices", title: "Invoices", includeInContext: true },
        { id: "receipts", title: "Receipts", includeInContext: false },
      ],
    },
    roadmap: { provider: "external", name: "Jira", command: ["node", "tools/jira.mjs"] },
  });

  assert.match(updated, /# page catalogue/);
  assert.match(updated, /enabled: \[ risks, project-state \] # selected pages/);
  assert.match(updated, /# local processes/);
  assert.match(updated, /id: invoices # stable id/);
  assert.match(updated, /title: Invoices # displayed title/);
  assert.match(updated, /includeInContext: true # prompt policy/);
  assert.doesNotMatch(updated, /starter:/);
  assert.doesNotMatch(updated, /id: shipping/);
  assert.match(updated, /# task authority/);
  assert.match(updated, /provider: external # provider kind/);
  assert.doesNotMatch(updated, /path: ROADMAP\.md/);
  assert.match(updated, /unknown: \{ left: alone \} # untouched/);
  assert.deepEqual((YAML.parse(updated) as { roadmap: unknown }).roadmap, {
    provider: "external",
    name: "Jira",
    command: ["node", "tools/jira.mjs"],
  });
});

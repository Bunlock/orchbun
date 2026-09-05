import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = path.resolve("src/cli.ts");

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, ["--import", "tsx", cli, ...args]);
}

test("init bootstraps a usable ignored local-memory project without overwriting master files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-init-"));
  await writeFile(path.join(root, "AGENTS.md"), "# Existing contract\n");
  const receipt = JSON.parse((await runCli("init", "--root", root, "--json")).stdout) as { root: string; created: string[] };
  assert.equal(receipt.root, root);
  assert.ok(receipt.created.includes("orchbun.yaml"));
  assert.ok(receipt.created.includes("ROADMAP.md"));
  assert.doesNotMatch(await readFile(path.join(root, "AGENTS.md"), "utf8"), /Agent workflow/);
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^memory\/$/m);
  assert.match(await readFile(path.join(root, "memory", "agents", "working", "project-state.md"), "utf8"), /Project state/);

  const second = JSON.parse((await runCli("init", "--root", root, "--json")).stdout) as { created: string[] };
  assert.deepEqual(second.created, []);
});

test("CLI maintenance operations and dry-run agent context have useful outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-audit-"));
  await runCli("init", "--root", root);
  assert.match((await runCli("memory", "show", "--root", root)).stdout, /Project state/);
  assert.equal((await runCli("memory", "runs", "--root", root)).stdout, "");
  assert.equal((await runCli("workspaces", "list", "--root", root)).stdout, "");
  assert.match((await runCli("memory", "rebuild", "--root", root)).stdout, /rebuilt/i);
  assert.deepEqual(JSON.parse((await runCli("memory", "verify", "--root", root)).stdout).issues, []);
  assert.equal(JSON.parse((await runCli("memory", "sleep", "--dry-run", "--json", "--root", root)).stdout).published, false);
  assert.equal(JSON.parse((await runCli("memory", "sweep", "--dry-run", "--json", "--root", root)).stdout).dryRun, true);
  assert.equal(JSON.parse((await runCli("memory", "compact", "--all", "--json", "--root", root)).stdout).requested, 0);
  const context = JSON.parse((await runCli("context", "--prompt", "Review the project", "--json", "--root", root)).stdout) as { expandedPrompt: string };
  assert.match(context.expandedPrompt, /Review the project/);
  const dryRun = JSON.parse((await runCli("run", "--prompt", "Review safely", "--dry-run", "--json", "--root", root)).stdout) as { expandedPrompt: string };
  assert.match(dryRun.expandedPrompt, /Review safely/);
});

test("CLI records an immutable outcome and refreshes its current view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-record-"));
  await runCli("init", "--root", root);
  const file = path.join(root, "outcome.md");
  await writeFile(file, `# Outcome
- **Recorded at:** 2026-09-05T12:00:00Z
- **Task:** Refresh integration
- **Outcome:** Recorded through the CLI.
- **Decisions:** Keep current state local.
- **Risks or blockers:** None
- **Next actions:** None
- **Changed files:** None
- **Verification:** CLI integration test.
- **Work status:** completed
`);
  const first = JSON.parse((await runCli("memory", "record", "--file", "outcome.md", "--json", "--root", root)).stdout);
  assert.equal(first.recorded, true);
  const second = JSON.parse((await runCli("memory", "record", "--file", "outcome.md", "--json", "--root", root)).stdout);
  assert.equal(second.recorded, false);
  const preview = JSON.parse((await runCli("memory", "refresh", "--dry-run", "--json", "--root", root)).stdout);
  assert.equal(preview.revision, first.memory.revision);
  assert.match(preview.projection.pages["project-state"], /Recorded through the CLI/);
  assert.deepEqual(JSON.parse((await runCli("memory", "verify", "--root", root)).stdout).issues, []);
});

test("CLI rejects removed, unknown, missing-value, and command-irrelevant options", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-options-"));
  await runCli("init", "--root", root);
  await assert.rejects(runCli("/compact", "--all", "--root", root), /Unknown command/);
  await assert.rejects(runCli("memory", "verify", "--json", "--root", root), /not supported/);
  await assert.rejects(runCli("memory", "web", "--port", "70000", "--root", root), /between 1 and 65535/);
  await assert.rejects(runCli("memory", "show", "--bogus", "--root", root), /not supported/);
  await assert.rejects(runCli("context", "--prompt", "x", "--model", "--root", root), /--model requires a value/);
  await assert.rejects(runCli("context", "--prompt", "x", "--prompt", "y", "--root", root), /more than once/);
  await assert.rejects(runCli("context", "--prompt-file", "../outside.md", "--root", root), /stay inside the project/);
  await assert.rejects(runCli("delegate", "--prompt", "x", "--root", root), /managed Orchbun run/);
  await assert.rejects(runCli("runtime", "status", "--root", root), /--root is not supported/);
  await assert.rejects(runCli("runtime", "status"), /managed isolated work run/);
  await assert.rejects(runCli("workspaces", "inspect", "--root", root), /--run is required/);
});

test("memory compact publishes an accepted manifest from the manual CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-compact-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  const manifestDirectory = path.join(root, "memory", "agents", "milestones", "manual-test");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(path.join(manifestDirectory, "approved.yaml"), `schema_version: "1.0"
milestone: manual-test
scope: shared
review:
  decision: accepted
  accepted_at: 2026-08-10T15:00:00Z
  accepted_by: cli-test
summary: Manual compaction is accepted.
validated_outcomes: [The CLI command completed.]
decisions: [Keep manual compaction manifest-gated.]
contracts: []
risks: []
pending_work: []
artifacts: []
supersedes: []
`);

  const { stdout } = await execute(process.execPath, [
    "--import", "tsx", cli,
    "memory", "compact",
    "--milestone", "manual-test",
    "--root", root,
    "--json",
  ]);
  const receipt = JSON.parse(stdout) as { milestone: string; scope: string; archivePath: string };
  assert.equal(receipt.milestone, "manual-test");
  assert.equal(receipt.scope, "shared");
  assert.match(receipt.archivePath, /^archive\//);
  assert.match(await readFile(path.join(root, "memory", "agents", "working", "project-state.md"), "utf8"), /Manual compaction is accepted/);
});

test("memory compact --all publishes every unpublished accepted manifest once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-compact-all-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  for (const [milestone, acceptedAt, outcome] of [
    ["first", "2026-08-10T15:00:00Z", "First durable outcome."],
    ["second", "2026-08-10T15:01:00Z", "Second durable outcome."],
  ]) {
    const directory = path.join(root, "memory", "agents", "milestones", milestone!);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "approved.yaml"), `schema_version: "1.0"
milestone: ${milestone}
scope: shared
review:
  decision: accepted
  accepted_at: ${acceptedAt}
  accepted_by: cli-test
summary: ${milestone} accepted.
validated_outcomes: [${outcome}]
decisions: []
contracts: []
risks: []
pending_work: []
artifacts:
  - path: ${milestone}.md
    description: ${milestone} artifact.
supersedes: []
`);
  }

  const args = ["--import", "tsx", cli, "memory", "compact", "--all", "--root", root, "--json"];
  const first = JSON.parse((await execute(process.execPath, args)).stdout) as { requested: number; compacted: unknown[]; skipped: number };
  assert.equal(first.requested, 2);
  assert.equal(first.compacted.length, 2);
  assert.equal(first.skipped, 0);
  const state = await readFile(path.join(root, "memory", "agents", "working", "project-state.md"), "utf8");
  assert.match(state, /First durable outcome/);
  assert.match(state, /Second durable outcome/);
  assert.match(state, /`first\.md`/);
  assert.match(state, /`second\.md`/);

  const second = JSON.parse((await execute(process.execPath, args)).stdout) as { compacted: unknown[]; skipped: number };
  assert.equal(second.compacted.length, 0);
  assert.equal(second.skipped, 2);
});

test("memory sleep previews and publishes roadmap-reconciled active tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-cli-sleep-"));
  await writeFile(path.join(root, "orchbun.yaml"), "version: 1\n");
  await writeFile(path.join(root, "ROADMAP.md"), `# Roadmap

## A — Foundation

- [x] **HEX-A1** Finished work.

## B — Playable

- [ ] **HEX-B1** Finish mobile play.

## C — Campaign

- [ ] **HEX-C1** Build the campaign.
`);
  const direct = path.join(root, "memory", "agents", "direct", "2026", "08");
  await mkdir(direct, { recursive: true });
  await writeFile(path.join(direct, "20260810T160000Z-finish-mobile.md"), `# Finish mobile

- **Task:** HEX-B1 mobile play
- **Outcome:** Recorded the remaining work.
- **Decisions:** None
- **Risks or blockers:** None
- **Next actions:** Complete HEX-B1 interaction coverage.
- **Changed files:** None
- **Verification:** Reviewed roadmap state.
`);

  const base = ["--import", "tsx", cli, "memory", "sleep", "--root", root, "--json"];
  const preview = JSON.parse((await execute(process.execPath, [...base, "--dry-run"])).stdout) as {
    published: boolean;
    snapshot: { activeTasks: Array<{ taskId: string }> };
  };
  assert.equal(preview.published, false);
  assert.deepEqual(preview.snapshot.activeTasks.map((task) => task.taskId), ["HEX-B1"]);
  await assert.rejects(readFile(path.join(root, "memory", "agents", "sleep", "state.json")));

  const published = JSON.parse((await execute(process.execPath, base)).stdout) as { published: boolean; snapshotPath: string };
  assert.equal(published.published, true);
  assert.match(published.snapshotPath, /^sleep\/snapshots\/[a-f0-9]{64}\.json$/);
  assert.match(
    await readFile(path.join(root, "memory", "agents", "working", "active-tasks.md"), "utf8"),
    /HEX-B1 · Playable.*Complete HEX-B1 interaction coverage/s,
  );
});

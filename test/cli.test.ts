import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

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

  const cli = path.resolve("src/cli.ts");
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

  const cli = path.resolve("src/cli.ts");
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

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicReplaceFileIfUnchanged } from "../src/atomic-file.js";

test("conditional atomic replacement publishes complete content and preserves mode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "orchbun.yaml");
  await writeFile(target, "version: old\n", "utf8");
  if (process.platform !== "win32") await chmod(target, 0o640);
  const beforeMode = (await stat(target)).mode & 0o7777;

  assert.equal(await atomicReplaceFileIfUnchanged(target, "version: old\n", "version: new\n"), true);
  assert.equal(await readFile(target, "utf8"), "version: new\n");
  assert.equal((await stat(target)).mode & 0o7777, beforeMode);
  assert.deepEqual(await readdir(root), ["orchbun.yaml"]);
});

test("conditional atomic replacement preserves a conflicting edit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "ROADMAP.md");
  await writeFile(target, "human edit\n", "utf8");
  const before = await stat(target, { bigint: true });

  assert.equal(await atomicReplaceFileIfUnchanged(target, "reviewed version\n", "agent edit\n"), false);
  assert.equal(await readFile(target, "utf8"), "human edit\n");
  const after = await stat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await readdir(root), ["ROADMAP.md"]);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournal } from "../src/journal.js";
import { loadMemorySnapshot, memoryViewerHtml, renderMemoryMarkdown, runMemoryAction } from "../src/memory-web.js";

test("memory web loads only generated working-memory pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-web-"));
  await mkdir(path.join(root, "working"), { recursive: true });
  await writeFile(path.join(root, "working", "project-state.md"), "# Project state\n\n- **Safe** status\n");
  const snapshot = await loadMemorySnapshot(root);
  assert.equal(snapshot.pages.length, 5);
  assert.match(snapshot.pages[0]!.markdown, /Safe/);
  assert.equal(snapshot.pages[1]!.markdown, "No memory has been generated yet.");
});

test("memory web escapes memory text before rendering", () => {
  const html = renderMemoryMarkdown("# <script>alert(1)</script>\n\n- **Trusted** `content`");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /<strong>Trusted<\/strong>/);
  assert.match(html, /<code>content<\/code>/);
});

test("memory web page contains accessible sections and maintenance controls", () => {
  const page = memoryViewerHtml();
  assert.match(page, /Project memory/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /Refresh/);
  assert.match(page, /Preview sleep/);
  assert.match(page, /Publish sweep/);
  assert.match(page, /Compact accepted/);
  assert.match(page, /\/api\/memory/);
});

test("memory web runs the same verification action as the CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-memory-web-action-"));
  const memoryRoot = path.join(root, "memory", "agents");
  const journal = new RunJournal(memoryRoot);
  await journal.initialize();
  assert.match(await runMemoryAction("verify", journal, root), /Verification passed/);
});

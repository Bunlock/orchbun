import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RunJournal } from "./journal.js";
import { loadRuns, rebuildMemory, verifyMemory } from "./memory.js";
import { compactAllApprovedMilestones } from "./milestone-memory.js";
import { sweepMemory } from "./memory-sweep.js";
import { sleepMemory } from "./sleep-memory.js";

const MEMORY_FILES = [
  ["project-state", "Project state", "project-state.md"],
  ["active-tasks", "Active tasks", "active-tasks.md"],
  ["decisions", "Decisions", "decisions.md"],
  ["contracts", "APIs and contracts", "contracts.md"],
  ["risks", "Risks and blockers", "risks.md"],
] as const;

export interface MemoryPage {
  id: string;
  title: string;
  markdown: string;
}

export interface MemorySnapshot {
  updatedAt: string;
  pages: MemoryPage[];
}

export type MemoryAction = "rebuild" | "verify" | "sleep-preview" | "sleep-publish" | "sweep-preview" | "sweep-publish" | "compact-all";

interface MemoryActionRequest {
  action?: unknown;
}

export interface MemoryViewerOptions {
  /** The workspace owning the memory. Required for actions that inspect ROADMAP.md. */
  projectRoot?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

/** Render the deliberately small Markdown subset used by generated working memory. */
export function renderMemoryMarkdown(markdown: string): string {
  const inline = (value: string) => escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const blocks: string[] = [];
  let items: string[] = [];
  const flushList = () => {
    if (items.length) blocks.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    items = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("- ")) {
      items.push(line.slice(2));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else blocks.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return blocks.join("");
}

export async function loadMemorySnapshot(memoryRoot: string): Promise<MemorySnapshot> {
  const pages = await Promise.all(MEMORY_FILES.map(async ([id, title, filename]) => {
    try {
      return { id, title, markdown: await readFile(path.join(memoryRoot, "working", filename), "utf8") };
    } catch {
      return { id, title, markdown: "No memory has been generated yet." };
    }
  }));
  return { updatedAt: new Date().toISOString(), pages };
}

export function memoryViewerHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchbun memory</title><style>
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #101522; color: #eef2ff; }
* { box-sizing: border-box; } body { margin: 0; } main { max-width: 900px; margin: auto; padding: 28px 18px 48px; }
header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; } h1 { font-size:1.45rem; margin:0; } .subtle { color:#aeb9d5; font-size:.9rem; }
nav, .actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; } button { min-height:42px; border:1px solid #3b496d; border-radius:10px; background:#192238; color:#dce6ff; padding:8px 12px; font:inherit; cursor:pointer; }
button[aria-selected="true"] { background:#3957a4; border-color:#7190e3; color:#fff; } button.publish { border-color:#a36c45; } button:disabled { cursor:wait; opacity:.65; } article, #result { border:1px solid #2d3a5a; border-radius:14px; background:#151d2f; padding:20px; box-shadow:0 12px 30px #0002; }
article h1 { font-size:1.25rem; } article h2 { font-size:1.08rem; margin-top:1.5rem; } article h3 { font-size:1rem; } article p, li { line-height:1.55; } article ul { padding-left:1.25rem; } code, pre { color:#c8d8ff; font-family:ui-monospace, monospace; } .error { color:#ffb8b8; } #result { margin:0 0 16px; white-space:pre-wrap; display:none; }
</style></head><body><main><header><div><h1>Project memory</h1><div id="updated" class="subtle">Loading…</div></div><button id="refresh" type="button">Refresh</button></header><section class="actions" aria-label="Memory maintenance"><button data-action="rebuild" type="button">Rebuild</button><button data-action="verify" type="button">Verify</button><button data-action="sleep-preview" type="button">Preview sleep</button><button data-action="sweep-preview" type="button">Preview sweep</button><button class="publish" data-action="sleep-publish" type="button">Publish sleep</button><button class="publish" data-action="sweep-publish" type="button">Publish sweep</button><button class="publish" data-action="compact-all" type="button">Compact accepted</button></section><pre id="result" aria-live="polite"></pre><nav id="tabs" aria-label="Memory sections"></nav><article id="content" aria-live="polite"></article></main>
<script>
let snapshot, selected = 0;
const tabs = document.querySelector('#tabs'), content = document.querySelector('#content'), updated = document.querySelector('#updated'), result = document.querySelector('#result');
function render() { const page = snapshot.pages[selected]; tabs.replaceChildren(...snapshot.pages.map((item, index) => { const button = document.createElement('button'); button.textContent = item.title; button.setAttribute('aria-selected', String(index === selected)); button.onclick = () => { selected = index; render(); }; return button; })); content.innerHTML = page.html; updated.textContent = 'Updated ' + new Date(snapshot.updatedAt).toLocaleString(); }
async function load() { try { const response = await fetch('/api/memory', { cache: 'no-store' }); if (!response.ok) throw new Error('Unable to load memory'); snapshot = await response.json(); selected = Math.min(selected, snapshot.pages.length - 1); render(); } catch (error) { content.innerHTML = '<p class="error">' + error.message + '</p>'; } }
async function action(event) { const button = event.currentTarget, name = button.dataset.action; const publishing = name === 'sleep-publish' || name === 'sweep-publish' || name === 'compact-all'; if (publishing && !window.confirm('This publishes changes to local memory. Continue?')) return; button.disabled = true; result.style.display = 'block'; result.textContent = 'Working…'; try { const response = await fetch('/api/memory/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Memory action failed'); result.textContent = body.message; await load(); } catch (error) { result.textContent = error.message; result.className = 'error'; } finally { button.disabled = false; } }
document.querySelector('#refresh').onclick = load; load();
document.querySelectorAll('[data-action]').forEach((button) => { button.onclick = action; });
</script></body></html>`;
}

export async function runMemoryAction(action: MemoryAction, journal: RunJournal, projectRoot: string): Promise<string> {
  if (action === "rebuild") {
    await rebuildMemory(journal, projectRoot);
    return "Working memory rebuilt.";
  }
  if (action === "verify") {
    const report = await verifyMemory(journal);
    return report.issues.length ? `Verification found ${report.issues.length} issue(s):\n${report.issues.map((issue) => `- ${issue}`).join("\n")}` : "Verification passed.";
  }
  if (action === "sleep-preview" || action === "sleep-publish") {
    const receipt = await sleepMemory(projectRoot, journal, { publish: action === "sleep-publish" });
    return `${receipt.published ? "Sleep snapshot published." : "Sleep preview; no files changed."}\n${receipt.snapshot.activeTasks.length} active · ${receipt.snapshot.scheduledTasks.length} scheduled · ${receipt.snapshot.excludedFollowups.length} excluded follow-up(s)`;
  }
  if (action === "sweep-preview" || action === "sweep-publish") {
    const receipt = await sweepMemory(journal, { dryRun: action === "sweep-preview", projectRoot });
    return receipt.report.trimEnd();
  }
  if (action === "compact-all") {
    const receipt = await compactAllApprovedMilestones(journal, "shared");
    return `Compacted ${receipt.compacted.length} milestone(s); skipped ${receipt.skipped} already published.`;
  }
  throw new Error("Unknown memory action");
}

async function readAction(request: import("node:http").IncomingMessage): Promise<MemoryActionRequest> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 4_096) throw new Error("Request body is too large");
  }
  try {
    return JSON.parse(body) as MemoryActionRequest;
  } catch {
    throw new Error("Invalid JSON request");
  }
}

export function createMemoryServer(memoryRoot: string, options: MemoryViewerOptions = {}): Server {
  const journal = new RunJournal(memoryRoot);
  const projectRoot = options.projectRoot;
  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/memory/actions" && request.method === "POST") {
      try {
        if (!projectRoot) throw new Error("Memory actions require the owning project root");
        const { action } = await readAction(request);
        if (!isMemoryAction(action)) throw new Error("Unknown memory action");
        const message = await runMemoryAction(action, journal, projectRoot);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ message }));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Memory action failed" }));
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET, POST" }).end();
      return;
    }
    if (pathname === "/api/memory") {
      const snapshot = await loadMemorySnapshot(memoryRoot);
      const payload = {
        ...snapshot,
        pages: snapshot.pages.map((page) => ({ id: page.id, title: page.title, html: renderMemoryMarkdown(page.markdown) })),
      };
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(payload));
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(memoryViewerHtml());
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  });
}

function isMemoryAction(value: unknown): value is MemoryAction {
  return typeof value === "string" && ["rebuild", "verify", "sleep-preview", "sleep-publish", "sweep-preview", "sweep-publish", "compact-all"].includes(value);
}

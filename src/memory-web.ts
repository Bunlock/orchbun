import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RunJournal } from "./journal.js";
import { MEMORY_PAGE_DEFINITIONS, readMemoryPage, renderMemoryMarkdown, saveMemoryOverride } from "./memory-web-rendering.js";
import { loadRuns, rebuildMemory, verifyMemory } from "./memory.js";
import { compactAllApprovedMilestones } from "./milestone-memory.js";
import { sweepMemory } from "./memory-sweep.js";
import { sleepMemory } from "./sleep-memory.js";
import { setRoadmapTaskCompletion } from "./roadmap.js";
import {
  approveMilestone,
  deriveProjectName,
  loadQualifications,
  loadRoadmapSafely,
  loadWebSettings,
  parseRiskItems,
  readProjectMarkdown,
  saveQualification,
  saveWebSettings,
  writeProjectMarkdown,
  type Qualification,
  type Severity,
  type Urgency,
  type WebSettings,
  type WorkStatus,
} from "./memory-workspace.js";
import { memoryViewerHtml } from "./memory-web-ui.js";

export { memoryViewerHtml, renderMemoryMarkdown } from "./memory-web-ui.js";

export interface MemoryPage {
  id: string;
  title: string;
  markdown: string;
}

export interface MemorySnapshot {
  projectName: string;
  updatedAt: string;
  pages: MemoryPage[];
  settings: WebSettings;
  roadmap: Awaited<ReturnType<typeof loadRoadmapSafely>>;
  qualifications: Record<string, Qualification>;
  risks: ReturnType<typeof parseRiskItems>;
}

export type MemoryAction = "rebuild" | "verify" | "sleep-preview" | "sleep-publish" | "sweep-preview" | "sweep-publish" | "compact-all";

export interface MemoryViewerOptions {
  projectRoot?: string;
}

export async function loadMemorySnapshot(memoryRoot: string, projectRoot = memoryRoot): Promise<MemorySnapshot> {
  const settings = await loadWebSettings(memoryRoot);
  const pages = await Promise.all(MEMORY_PAGE_DEFINITIONS.map(async ([id, title]) => ({
    id,
    title,
    markdown: await readMemoryPage(memoryRoot, id),
  })));
  return {
    projectName: await deriveProjectName(projectRoot),
    updatedAt: new Date().toISOString(),
    pages,
    settings,
    roadmap: await loadRoadmapSafely(projectRoot, settings.roadmapPath),
    qualifications: await loadQualifications(memoryRoot),
    risks: parseRiskItems(pages.find((page) => page.id === "risks")?.markdown ?? ""),
  };
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
    return `${receipt.published ? "Sleep snapshot published." : "Sleep preview; no files changed."}\n${receipt.snapshot.activeTasks.length} active · ${receipt.snapshot.scheduledTasks.length} scheduled · ${receipt.snapshot.subjects.length} subjects · ${receipt.snapshot.excludedFollowups.length} excluded follow-up(s)`;
  }
  if (action === "sweep-preview" || action === "sweep-publish") {
    const receipt = await sweepMemory(journal, { dryRun: action === "sweep-preview", projectRoot });
    return receipt.report.trimEnd();
  }
  if (action === "compact-all") {
    const receipt = await compactAllApprovedMilestones(journal, "shared");
    await rebuildMemory(journal, projectRoot);
    return `Compacted ${receipt.compacted.length} milestone(s); skipped ${receipt.skipped} already published.`;
  }
  throw new Error("Unknown memory action");
}

export function createMemoryServer(memoryRoot: string, options: MemoryViewerOptions = {}): Server {
  const journal = new RunJournal(memoryRoot);
  const projectRoot = options.projectRoot;
  return createServer(async (request, response) => {
    if (!isLocalRequest(request)) {
      return json(response, 403, { error: "Memory web accepts only loopback requests" });
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/memory") {
        requireProjectRoot(projectRoot);
        return json(response, 200, await loadMemorySnapshot(memoryRoot, projectRoot));
      }
      if (request.method === "GET" && url.pathname === "/api/project-file") {
        requireProjectRoot(projectRoot);
        const relativePath = url.searchParams.get("path") ?? "";
        return json(response, 200, { path: relativePath, markdown: await readProjectMarkdown(projectRoot, relativePath) });
      }
      if (request.method === "POST" && url.pathname === "/api/memory/actions") {
        requireProjectRoot(projectRoot);
        const body = await readJson(request);
        if (!isMemoryAction(body.action)) throw new Error("Unknown memory action");
        return json(response, 200, { message: await runMemoryAction(body.action, journal, projectRoot) });
      }
      if (request.method === "POST" && url.pathname === "/api/memory/pages") {
        const body = await readJson(request);
        if (typeof body.id !== "string" || typeof body.markdown !== "string") throw new Error("Memory page id and Markdown are required");
        await saveMemoryOverride(memoryRoot, body.id, body.markdown);
        return json(response, 200, { message: "Memory page saved as a persistent local override." });
      }
      if (request.method === "POST" && url.pathname === "/api/project-file") {
        requireProjectRoot(projectRoot);
        const body = await readJson(request);
        if (typeof body.path !== "string" || typeof body.markdown !== "string") throw new Error("Project-relative path and Markdown are required");
        await writeProjectMarkdown(projectRoot, body.path, body.markdown);
        if (body.kind === "roadmap" || body.kind === "agents") {
          const settings = await loadWebSettings(memoryRoot);
          await saveWebSettings(memoryRoot, { ...settings, [body.kind === "roadmap" ? "roadmapPath" : "agentsPath"]: body.path });
        }
        return json(response, 200, { message: `${body.path} saved.` });
      }
      if (request.method === "POST" && url.pathname === "/api/qualifications") {
        const body = await readJson(request);
        const qualification = await saveQualification(memoryRoot, {
          kind: stringValue(body.kind) as "task" | "risk",
          id: stringValue(body.id),
          severity: stringValue(body.severity) as Severity,
          urgency: stringValue(body.urgency) as Urgency,
          status: stringValue(body.status) as WorkStatus,
        });
        return json(response, 200, { qualification });
      }
      if (request.method === "POST" && url.pathname === "/api/roadmap/tasks") {
        requireProjectRoot(projectRoot);
        const body = await readJson(request);
        const settings = await loadWebSettings(memoryRoot);
        const update = await setRoadmapTaskCompletion(projectRoot, stringValue(body.taskId), Boolean(body.completed), settings.roadmapPath);
        if (update === "not-found" || update === "missing") throw new Error("Roadmap task was not found");
        return json(response, 200, { message: update === "updated" ? "Roadmap step updated." : "Roadmap step already matched." });
      }
      if (request.method === "POST" && url.pathname === "/api/milestones/approve") {
        requireProjectRoot(projectRoot);
        const body = await readJson(request);
        const settings = await loadWebSettings(memoryRoot);
        const receipt = await approveMilestone(projectRoot, journal, settings.roadmapPath, stringValue(body.milestone));
        return json(response, 200, {
          message: receipt.alreadyApproved ? `Milestone already approved at ${receipt.manifestPath}.` : `Milestone approved at ${receipt.manifestPath}.`,
        });
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, securityHeaders({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })).end(memoryViewerHtml());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/FAVICON.png" || url.pathname === "/ORCHBUN-logo.png")) {
        const asset = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", url.pathname.slice(1));
        response.writeHead(200, securityHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" })).end(await readFile(asset));
        return;
      }
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" });
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  });
}

function requireProjectRoot(projectRoot: string | undefined): asserts projectRoot is string {
  if (!projectRoot) throw new Error("Memory web requires the owning project root");
}

function isMemoryAction(value: unknown): value is MemoryAction {
  return typeof value === "string" && ["rebuild", "verify", "sleep-preview", "sleep-publish", "sweep-preview", "sweep-publish", "compact-all"].includes(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new Error("POST requests require application/json");
  }
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_100_000) throw new Error("Request body is too large");
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON request");
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Request contains a missing string value");
  return value;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })).end(JSON.stringify(payload));
}

function isLocalRequest(request: IncomingMessage): boolean {
  return isAllowedLocalRequest(request.headers.host ?? "", request.headers.origin);
}

export function isAllowedLocalRequest(host: string, origin?: string): boolean {
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  if (!isLoopbackHost(hostname)) return false;
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function securityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

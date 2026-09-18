import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RunJournal } from "./journal.js";
import { renderMemoryMarkdown } from "./memory-web-rendering.js";
import { DEFAULT_MEMORY_PAGE_CATALOGUE, readMemoryPage, saveMemoryOverride } from "./memory-overrides.js";
import { loadRuns, rebuildMemory, verifyMemory } from "./memory.js";
import { compactAllApprovedMilestones } from "./milestone-memory.js";
import { sweepMemory } from "./memory-sweep.js";
import { sleepMemory } from "./sleep-memory.js";
import {
  approveMilestone,
  createWorkspaceRoadmapStore,
  deriveProjectName,
  loadQualifications,
  loadWebSettings,
  parseRiskItems,
  readProjectMarkdown,
  saveQualification,
  validateQualification,
  saveWebSettings,
  writeProjectMarkdown,
  type Qualification,
  type Severity,
  type Urgency,
  type WebSettings,
  type WorkStatus,
} from "./memory-workspace.js";
import { MemoryConflict, readRefreshedMemory, refreshMemory, updateMemory, type RefreshedMemory } from "./memory-refresh.js";
import { RoadmapConflictError } from "./roadmap-store.js";
import type { RoadmapSnapshot } from "./roadmap-store.js";
import { memoryViewerHtml } from "./memory-web-ui.js";
import { CONFIG_FILE, loadConfig, pathExists } from "./config.js";

export { memoryViewerHtml, renderMemoryMarkdown } from "./memory-web-ui.js";

export interface MemoryPage {
  id: string;
  title: string;
  kind: "builtin" | "custom";
  includeInContext: boolean;
  markdown: string;
  annotation: string;
}

export interface MemorySnapshot {
  projectName: string;
  updatedAt: string | null;
  revision: string | null;
  freshness: { status: "current" | "updates-pending" | "refresh-failed"; error?: string; changedPages: string[] };
  lastVerification: RefreshedMemory["projection"]["lastVerification"];
  pages: MemoryPage[];
  settings: WebSettings;
  roadmap: RoadmapSnapshot | null;
  qualifications: Record<string, Qualification>;
  risks: ReturnType<typeof parseRiskItems>;
}

export type MemoryAction = "rebuild" | "verify" | "sleep-preview" | "sleep-publish" | "sweep-preview" | "sweep-publish" | "compact-all";

export interface MemoryViewerOptions {
  projectRoot?: string;
}

export async function loadMemorySnapshot(memoryRoot: string, projectRoot?: string): Promise<MemorySnapshot> {
  if (!projectRoot) {
    const settings = await loadWebSettings(memoryRoot);
    const pages = await Promise.all(DEFAULT_MEMORY_PAGE_CATALOGUE.map(async (page) => ({
      id: page.id,
      title: page.title,
      kind: page.kind,
      includeInContext: page.includeInContext,
      markdown: await readMemoryPage(memoryRoot, page.id),
      annotation: "",
    })));
    return { projectName: await deriveProjectName(memoryRoot), updatedAt: null, revision: null,
      freshness: { status: "updates-pending", changedPages: [] }, lastVerification: null,
      pages, settings, roadmap: null, qualifications: await loadQualifications(memoryRoot), risks: parseRiskItems(pages.find(page => page.id === "risks")?.markdown ?? "") };
  }
  let state: RefreshedMemory;
  let error: string | undefined;
  try { state = await refreshMemory(new RunJournal(memoryRoot), projectRoot); }
  catch (failure) {
    const previous = await readRefreshedMemory(memoryRoot);
    if (!previous) throw failure;
    state = previous;
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const { projection } = state;
  return {
    projectName: await deriveProjectName(projectRoot), updatedAt: state.refreshedAt, revision: state.revision,
    freshness: { status: error ? "refresh-failed" : "current", changedPages: state.changedPages, ...(error ? { error } : {}) },
    lastVerification: projection.lastVerification,
    pages: projection.pageDefinitions.map(page => ({
      id: page.id,
      title: page.title,
      kind: page.kind,
      includeInContext: page.includeInContext,
      markdown: projection.pages[page.id] ?? "",
      annotation: projection.annotations[page.id] ?? "",
    })),
    settings: projection.settings, roadmap: projection.roadmap, qualifications: projection.qualifications, risks: projection.risks,
  };
}

export async function runMemoryAction(action: MemoryAction, journal: RunJournal, projectRoot: string): Promise<string> {
  // The web process can outlive a manual config edit. Validate the current
  // document before any maintenance action is allowed to mutate memory.
  if (await pathExists(path.join(projectRoot, CONFIG_FILE))) await loadConfig(projectRoot);
  if (action === "rebuild") {
    await rebuildMemory(journal, projectRoot);
    return "Working memory rebuilt.";
  }
  if (action === "verify") {
    const report = await verifyMemory(journal, projectRoot);
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
    await refreshMemory(journal, projectRoot);
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
      if (request.method === "POST" && ["/api/memory/pages", "/api/project-file", "/api/qualifications", "/api/roadmap/tasks", "/api/milestones/approve"].includes(url.pathname)) {
        requireProjectRoot(projectRoot);
        const body = await readJson(request);
        const result = await updateMemory(journal, projectRoot, stringValue(body.revision), async projection => {
          if (url.pathname === "/api/memory/pages") {
            if (typeof body.id !== "string" || typeof body.markdown !== "string") throw new Error("Memory page id and Markdown are required");
            const page = projection.pageDefinitions.find(candidate => candidate.id === body.id);
            if (!page) throw new Error("Memory page is not enabled");
            await saveMemoryOverride(memoryRoot, body.id, body.markdown, projection.pageDefinitions);
            return { message: page.kind === "custom" ? "Process page saved." : "Human annotations saved; generated project state refreshed." };
          }
          if (url.pathname === "/api/project-file") {
            if (typeof body.path !== "string" || typeof body.markdown !== "string") throw new Error("Project-relative path and Markdown are required");
            if (body.kind === "roadmap") {
              if (projection.roadmap?.source.provider !== "internal") throw new Error("External roadmaps are edited in their provider");
              if (body.path !== projection.roadmap.source.artifact) throw new Error("Change the configured roadmap path with orchbun configure");
            }
            await writeProjectMarkdown(projectRoot, body.path, body.markdown);
            if (body.kind === "agents") {
              await saveWebSettings(memoryRoot, { ...projection.settings, agentsPath: body.path });
            }
            return { message: `${body.path} saved; project state refreshed.` };
          }
          if (url.pathname === "/api/qualifications") {
            const value = validateQualification({ kind: stringValue(body.kind) as "task" | "risk", id: stringValue(body.id), severity: stringValue(body.severity) as Severity, urgency: stringValue(body.urgency) as Urgency, status: stringValue(body.status) as WorkStatus });
            if (value.kind === "task") {
              if (!projection.roadmap?.tasks.some(task => task.id === value.id)) throw new Error("Roadmap task was not found");
              // Legacy clients used status=done to check an internal Markdown
              // roadmap. External providers accept completion only through the
              // explicit roadmap checkbox endpoint; qualification state never
              // acts as remote completion authority.
              if (value.status === "done") {
                if (projection.roadmap.source.provider === "external") {
                  throw new Error("Complete external roadmap tasks with the roadmap checkbox");
                }
                await setConfiguredRoadmapCompletion(projectRoot, journal, projection, value.id, true);
              }
              const prior = projection.qualifications[`task:${value.id}`];
              await saveQualification(memoryRoot, value.status === "done"
                ? { ...value, status: prior?.status === "blocked" ? "blocked" : "active" }
                : value);
            } else {
              if (!projection.risks.some(risk => risk.id === value.id)) throw new Error("Risk was not found");
              await saveQualification(memoryRoot, value);
            }
            return { message: "Status and priority saved; project state refreshed." };
          }
          if (url.pathname === "/api/roadmap/tasks") {
            if (typeof body.completed !== "boolean") throw new Error("completed must be a boolean");
            await setConfiguredRoadmapCompletion(projectRoot, journal, projection, stringValue(body.taskId), body.completed);
            return { message: "Roadmap step updated; project state refreshed." };
          }
          const receipt = await approveMilestone(projectRoot, journal, projection, stringValue(body.milestone));
          return { message: receipt.alreadyApproved ? `Milestone already approved at ${receipt.manifestPath}.` : `Milestone approved at ${receipt.manifestPath}.` };
        });
        return json(response, 200, { ...result.value, revision: result.memory.revision });
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
      json(response, error instanceof MemoryConflict || error instanceof RoadmapConflictError ? 409 : 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  });
}

async function setConfiguredRoadmapCompletion(
  projectRoot: string,
  journal: RunJournal,
  projection: RefreshedMemory["projection"],
  taskId: string,
  completed: boolean,
): Promise<void> {
  const roadmap = projection.roadmap;
  if (!roadmap?.tasks.some(task => task.id === taskId)) throw new Error("Roadmap task was not found");
  if (roadmap.freshness !== "fresh") throw new Error("A stale external roadmap is read-only until its provider is available");
  try {
    await (await createWorkspaceRoadmapStore(projectRoot, journal, projection)).setCompletion({
      taskId,
      completed,
      expectedRevision: roadmap.revision,
    });
  } catch (error) {
    if (error instanceof RoadmapConflictError) throw new MemoryConflict();
    throw error;
  }
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

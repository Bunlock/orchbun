import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentKind, RunMode } from "./types.js";

export const BUILTIN_MEMORY_PAGES = [
  { id: "project-state", title: "Project state", filename: "project-state.md" },
  { id: "active-tasks", title: "Tasks", filename: "active-tasks.md" },
  { id: "decisions", title: "Decisions", filename: "decisions.md" },
  { id: "contracts", title: "Operational constraints", filename: "contracts.md" },
  { id: "risks", title: "Risks and blockers", filename: "risks.md" },
] as const;

export type BuiltinMemoryPageId = typeof BUILTIN_MEMORY_PAGES[number]["id"];

export const BUILTIN_MEMORY_PAGE_IDS = BUILTIN_MEMORY_PAGES.map(({ id }) => id) as BuiltinMemoryPageId[];
export const MAX_CUSTOM_MEMORY_PAGES = 50;
export const MAX_MEMORY_PAGE_ID_CHARS = 64;
export const MAX_MEMORY_PAGE_TITLE_CHARS = 120;
export const MAX_MEMORY_PAGE_STARTER_CHARS = 64_000;
export const MAX_ROADMAP_PROVIDER_NAME_CHARS = 120;
export const MAX_ROADMAP_COMMAND_ARGUMENTS = 64;
export const MAX_ROADMAP_COMMAND_ARGUMENT_CHARS = 4_096;

export interface CustomMemoryPageConfig {
  id: string;
  title: string;
  includeInContext: boolean;
  starter?: string;
}

export interface MemoryPagesConfig {
  enabled: BuiltinMemoryPageId[];
  custom: CustomMemoryPageConfig[];
}

export interface InternalRoadmapConfig {
  provider: "internal";
  path: string;
}

export interface ExternalRoadmapConfig {
  provider: "external";
  name: string;
  command: string[];
}

export type RoadmapConfig = InternalRoadmapConfig | ExternalRoadmapConfig;

export interface SetupSpec {
  memoryPages: MemoryPagesConfig;
  roadmap: RoadmapConfig;
}

export interface OrchbunConfig {
  version: 1;
  memoryDir: string;
  memoryPages: MemoryPagesConfig;
  roadmap: RoadmapConfig;
  budgets: {
    maxInputChars: number;
    maxFileChars: number;
    maxOutputTokens: number;
    recentRuns: number;
  };
  agents: {
    default: AgentKind;
    openrouterModel: string;
  };
  delegation: {
    maxDepth: number;
    defaultMode: RunMode;
  };
  images: {
    pollIntervalMs: number;
    timeoutMs: number;
  };
  hooks: {
    after_memory_rebuild?: string;
  };
  isolation: {
    enabled: boolean;
    branchPrefix: string;
    worktreeDir: string;
    runtime: {
      driver: "none" | "compose";
      composeFiles: string[];
      services: string[];
      projectPrefix: string;
      frontendPorts: [number, number];
      backendPorts: [number, number];
      databasePorts: [number, number];
      backendPortEnv: string;
      databasePortEnv: string;
      frontendUrlEnv: string;
      healthUrl?: string;
      healthTimeoutMs: number;
    };
  };
}

export const CONFIG_FILE = "orchbun.yaml";

export const DEFAULT_CONFIG: OrchbunConfig = {
  version: 1,
  memoryDir: "memory/agents",
  memoryPages: {
    enabled: [...BUILTIN_MEMORY_PAGE_IDS],
    custom: [],
  },
  roadmap: {
    provider: "internal",
    path: "ROADMAP.md",
  },
  budgets: {
    maxInputChars: 12_000,
    maxFileChars: 3_500,
    maxOutputTokens: 1_200,
    recentRuns: 6,
  },
  agents: {
    default: "codex",
    openrouterModel: "anthropic/claude-sonnet-4.5",
  },
  delegation: {
    maxDepth: 2,
    defaultMode: "review",
  },
  images: {
    pollIntervalMs: 2_000,
    timeoutMs: 120_000,
  },
  hooks: {},
  isolation: {
    enabled: false,
    branchPrefix: "orchbun/",
    worktreeDir: "memory/agents/worktrees",
    runtime: {
      driver: "none",
      composeFiles: ["docker-compose.yml"],
      services: [],
      projectPrefix: "orchbun",
      frontendPorts: [4201, 4299],
      backendPorts: [3201, 3299],
      databasePorts: [5501, 5599],
      backendPortEnv: "BACKEND_PORT",
      databasePortEnv: "POSTGRES_PORT",
      frontendUrlEnv: "FRONTEND_URL",
      healthTimeoutMs: 120_000,
    },
  },
};

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findWorkspaceRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find ${CONFIG_FILE} from ${start}`);
    current = parent;
  }
}

export async function loadConfig(root: string): Promise<OrchbunConfig> {
  const parsed = parseConfigDocument(await readFile(path.join(root, CONFIG_FILE), "utf8"));
  const memoryDir = parsed.memoryDir === undefined ? DEFAULT_CONFIG.memoryDir : validateMemoryDir(parsed.memoryDir);
  validateMemoryDirForRoot(root, memoryDir);
  const legacyRoadmapPath = parsed.roadmap === undefined
    ? await readLegacyRoadmapPath(root, memoryDir)
    : undefined;
  return resolveConfig(parsed, legacyRoadmapPath);
}

/** Parses and resolves config text without reading or changing workspace state. */
export function parseConfigText(source: string, legacyRoadmapPath?: string): OrchbunConfig {
  return resolveConfig(parseConfigDocument(source), legacyRoadmapPath);
}

/** Applies the init-managed setup sections to a complete config value. */
export function configWithSetup(base: OrchbunConfig, setup: SetupSpec): OrchbunConfig {
  const normalized = validateSetupSpec(setup);
  return {
    ...base,
    memoryPages: normalized.memoryPages,
    roadmap: normalized.roadmap,
  };
}

export function setupSpecFromConfig(config: OrchbunConfig): SetupSpec {
  return cloneSetupSpec({ memoryPages: config.memoryPages, roadmap: config.roadmap });
}

export function validateSetupSpec(value: unknown): SetupSpec {
  const mapping = requiredMapping(value, "Setup choices");
  return {
    memoryPages: validateMemoryPagesConfig(mapping.memoryPages),
    roadmap: validateRoadmapConfig(mapping.roadmap),
  };
}

export function validateMemoryPagesConfig(value: unknown): MemoryPagesConfig {
  const mapping = requiredMapping(value, "memoryPages");
  if (!Array.isArray(mapping.enabled)) throw new Error("memoryPages.enabled must be an array");
  const enabled = mapping.enabled.map((entry) => {
    if (typeof entry !== "string" || !isBuiltinMemoryPageId(entry)) {
      throw new Error(`Unknown built-in memory page: ${String(entry)}`);
    }
    return entry;
  });
  if (new Set(enabled).size !== enabled.length) throw new Error("memoryPages.enabled contains duplicate page ids");
  if (!Array.isArray(mapping.custom)) throw new Error("memoryPages.custom must be an array");
  if (mapping.custom.length > MAX_CUSTOM_MEMORY_PAGES) {
    throw new Error(`memoryPages.custom cannot contain more than ${MAX_CUSTOM_MEMORY_PAGES} pages`);
  }
  const custom = mapping.custom.map((entry, index) => validateCustomMemoryPage(entry, index));
  const customIds = new Set<string>();
  for (const page of custom) {
    if (customIds.has(page.id)) throw new Error(`Duplicate custom memory page id: ${page.id}`);
    customIds.add(page.id);
  }
  return { enabled: [...enabled], custom };
}

export function validateRoadmapConfig(value: unknown): RoadmapConfig {
  const mapping = requiredMapping(value, "roadmap");
  if (mapping.provider === "internal") {
    if (typeof mapping.path !== "string") throw new Error("Internal roadmap path must be a string");
    return { provider: "internal", path: normalizeProjectMarkdownPath(mapping.path, "Internal roadmap path") };
  }
  if (mapping.provider === "external") {
    if (typeof mapping.name !== "string" || !mapping.name.trim()) throw new Error("External roadmap name is required");
    const name = mapping.name.trim();
    if (name.length > MAX_ROADMAP_PROVIDER_NAME_CHARS) {
      throw new Error(`External roadmap name cannot exceed ${MAX_ROADMAP_PROVIDER_NAME_CHARS} characters`);
    }
    if (!Array.isArray(mapping.command) || mapping.command.length === 0) {
      throw new Error("External roadmap command must contain an executable");
    }
    if (mapping.command.length > MAX_ROADMAP_COMMAND_ARGUMENTS) {
      throw new Error(`External roadmap command cannot contain more than ${MAX_ROADMAP_COMMAND_ARGUMENTS} arguments`);
    }
    const command = mapping.command.map((argument, index) => {
      if (typeof argument !== "string") throw new Error(`External roadmap command argument ${index + 1} must be a string`);
      if (index === 0 && !argument.trim()) throw new Error("External roadmap command executable cannot be empty");
      if (argument.includes("\0")) throw new Error("External roadmap command arguments cannot contain NUL bytes");
      if (argument.length > MAX_ROADMAP_COMMAND_ARGUMENT_CHARS) {
        throw new Error(`External roadmap command arguments cannot exceed ${MAX_ROADMAP_COMMAND_ARGUMENT_CHARS} characters`);
      }
      return argument;
    });
    return { provider: "external", name, command };
  }
  throw new Error("roadmap.provider must be internal or external");
}

function resolveConfig(parsed: Record<string, unknown>, legacyRoadmapPath?: string): OrchbunConfig {
  if (parsed.version !== undefined && parsed.version !== 1) throw new Error("orchbun.yaml version must be 1");
  const partial = parsed as Partial<OrchbunConfig>;
  const memoryDir = parsed.memoryDir === undefined ? DEFAULT_CONFIG.memoryDir : validateMemoryDir(parsed.memoryDir);
  const memoryPages = parsed.memoryPages === undefined
    ? cloneMemoryPages(DEFAULT_CONFIG.memoryPages)
    : validateMemoryPagesConfig(parsed.memoryPages);
  const roadmap = parsed.roadmap === undefined
    ? { provider: "internal" as const, path: normalizeProjectMarkdownPath(legacyRoadmapPath ?? "ROADMAP.md", "Internal roadmap path") }
    : validateRoadmapConfig(parsed.roadmap);
  const budgets = optionalMapping(parsed.budgets, "budgets");
  const agents = optionalMapping(parsed.agents, "agents");
  const delegation = optionalMapping(parsed.delegation, "delegation");
  const images = optionalMapping(parsed.images, "images");
  const hooks = optionalMapping(parsed.hooks, "hooks");
  const isolation = optionalMapping(parsed.isolation, "isolation");
  const runtime = optionalMapping(isolation.runtime, "isolation.runtime");
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    memoryDir,
    memoryPages,
    roadmap,
    budgets: {
      ...DEFAULT_CONFIG.budgets,
      ...budgets,
      maxInputChars: integerSetting(budgets, "maxInputChars", "budgets.maxInputChars", DEFAULT_CONFIG.budgets.maxInputChars, 1),
      maxFileChars: integerSetting(budgets, "maxFileChars", "budgets.maxFileChars", DEFAULT_CONFIG.budgets.maxFileChars, 1),
      maxOutputTokens: integerSetting(budgets, "maxOutputTokens", "budgets.maxOutputTokens", DEFAULT_CONFIG.budgets.maxOutputTokens, 1),
      recentRuns: integerSetting(budgets, "recentRuns", "budgets.recentRuns", DEFAULT_CONFIG.budgets.recentRuns, 0),
    },
    agents: {
      ...DEFAULT_CONFIG.agents,
      ...agents,
      default: enumSetting(agents, "default", "agents.default", DEFAULT_CONFIG.agents.default, ["codex", "claude", "openrouter"] as const),
      openrouterModel: nonEmptyStringSetting(agents, "openrouterModel", "agents.openrouterModel", DEFAULT_CONFIG.agents.openrouterModel),
    },
    delegation: {
      ...DEFAULT_CONFIG.delegation,
      ...delegation,
      maxDepth: integerSetting(delegation, "maxDepth", "delegation.maxDepth", DEFAULT_CONFIG.delegation.maxDepth, 0),
      defaultMode: enumSetting(delegation, "defaultMode", "delegation.defaultMode", DEFAULT_CONFIG.delegation.defaultMode, ["review", "work"] as const),
    },
    images: {
      ...DEFAULT_CONFIG.images,
      ...images,
      pollIntervalMs: integerSetting(images, "pollIntervalMs", "images.pollIntervalMs", DEFAULT_CONFIG.images.pollIntervalMs, 1),
      timeoutMs: integerSetting(images, "timeoutMs", "images.timeoutMs", DEFAULT_CONFIG.images.timeoutMs, 1),
    },
    hooks: {
      ...DEFAULT_CONFIG.hooks,
      ...hooks,
      ...optionalStringSetting(hooks, "after_memory_rebuild", "hooks.after_memory_rebuild"),
    },
    isolation: {
      ...DEFAULT_CONFIG.isolation,
      ...isolation,
      enabled: booleanSetting(isolation, "enabled", "isolation.enabled", DEFAULT_CONFIG.isolation.enabled),
      branchPrefix: nonEmptyStringSetting(isolation, "branchPrefix", "isolation.branchPrefix", DEFAULT_CONFIG.isolation.branchPrefix),
      worktreeDir: projectRelativeDirectorySetting(isolation, "worktreeDir", "isolation.worktreeDir", DEFAULT_CONFIG.isolation.worktreeDir),
      runtime: {
        ...DEFAULT_CONFIG.isolation.runtime,
        ...runtime,
        driver: enumSetting(runtime, "driver", "isolation.runtime.driver", DEFAULT_CONFIG.isolation.runtime.driver, ["none", "compose"] as const),
        composeFiles: stringArraySetting(runtime, "composeFiles", "isolation.runtime.composeFiles", DEFAULT_CONFIG.isolation.runtime.composeFiles, { projectRelative: true }),
        services: stringArraySetting(runtime, "services", "isolation.runtime.services", DEFAULT_CONFIG.isolation.runtime.services),
        projectPrefix: composeProjectPrefixSetting(runtime, DEFAULT_CONFIG.isolation.runtime.projectPrefix),
        frontendPorts: portRangeSetting(runtime, "frontendPorts", "isolation.runtime.frontendPorts", DEFAULT_CONFIG.isolation.runtime.frontendPorts),
        backendPorts: portRangeSetting(runtime, "backendPorts", "isolation.runtime.backendPorts", DEFAULT_CONFIG.isolation.runtime.backendPorts),
        databasePorts: portRangeSetting(runtime, "databasePorts", "isolation.runtime.databasePorts", DEFAULT_CONFIG.isolation.runtime.databasePorts),
        backendPortEnv: environmentNameSetting(runtime, "backendPortEnv", "isolation.runtime.backendPortEnv", DEFAULT_CONFIG.isolation.runtime.backendPortEnv),
        databasePortEnv: environmentNameSetting(runtime, "databasePortEnv", "isolation.runtime.databasePortEnv", DEFAULT_CONFIG.isolation.runtime.databasePortEnv),
        frontendUrlEnv: environmentNameSetting(runtime, "frontendUrlEnv", "isolation.runtime.frontendUrlEnv", DEFAULT_CONFIG.isolation.runtime.frontendUrlEnv),
        ...optionalStringSetting(runtime, "healthUrl", "isolation.runtime.healthUrl"),
        healthTimeoutMs: integerSetting(runtime, "healthTimeoutMs", "isolation.runtime.healthTimeoutMs", DEFAULT_CONFIG.isolation.runtime.healthTimeoutMs, 1),
      },
    },
  };
}

export function memoryRoot(root: string, config: OrchbunConfig): string {
  return path.resolve(root, config.memoryDir);
}

function parseConfigDocument(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = YAML.parse(source);
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return requiredMapping(value, CONFIG_FILE);
}

function validateCustomMemoryPage(value: unknown, index: number): CustomMemoryPageConfig {
  const mapping = requiredMapping(value, `memoryPages.custom[${index}]`);
  if (typeof mapping.id !== "string") throw new Error(`memoryPages.custom[${index}].id must be a string`);
  const id = mapping.id.trim();
  if (!id || id.length > MAX_MEMORY_PAGE_ID_CHARS || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Custom memory page id must be a lowercase slug of at most ${MAX_MEMORY_PAGE_ID_CHARS} characters`);
  }
  if (isBuiltinMemoryPageId(id)) throw new Error(`Custom memory page id is reserved: ${id}`);
  if (typeof mapping.title !== "string" || !mapping.title.trim()) throw new Error(`Custom memory page ${id} requires a title`);
  const title = mapping.title.trim();
  if (title.length > MAX_MEMORY_PAGE_TITLE_CHARS) {
    throw new Error(`Custom memory page title cannot exceed ${MAX_MEMORY_PAGE_TITLE_CHARS} characters`);
  }
  if (mapping.includeInContext !== undefined && typeof mapping.includeInContext !== "boolean") {
    throw new Error(`Custom memory page ${id} includeInContext must be true or false`);
  }
  if (mapping.starter !== undefined && typeof mapping.starter !== "string") {
    throw new Error(`Custom memory page ${id} starter must be Markdown text`);
  }
  if (typeof mapping.starter === "string" && mapping.starter.length > MAX_MEMORY_PAGE_STARTER_CHARS) {
    throw new Error(`Custom memory page starter cannot exceed ${MAX_MEMORY_PAGE_STARTER_CHARS} characters`);
  }
  return {
    id,
    title,
    includeInContext: mapping.includeInContext ?? false,
    ...(typeof mapping.starter === "string" ? { starter: mapping.starter } : {}),
  };
}

function normalizeProjectMarkdownPath(value: string, label: string): string {
  const candidate = value.trim().replace(/\\/g, "/");
  if (!candidate || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error(`${label} must be a project-relative .md file`);
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.extname(normalized).toLowerCase() !== ".md") {
    throw new Error(`${label} must be a project-relative .md file inside the project`);
  }
  return normalized.replace(/^\.\//, "");
}

function validateMemoryDir(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("memoryDir must be a non-empty path without NUL bytes");
  }
  const candidate = value.trim();
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    const implementation = path.win32.isAbsolute(candidate) ? path.win32 : path;
    const normalized = implementation.normalize(candidate);
    if (normalized === implementation.parse(normalized).root) {
      throw new Error("memoryDir cannot be a filesystem root");
    }
    return candidate;
  }
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("memoryDir must be an absolute path or a project-relative directory inside the project");
  }
  return normalized.replace(/^\.\//, "");
}

function validateMemoryDirForRoot(root: string, memoryDir: string): void {
  if (path.resolve(root, memoryDir) === path.resolve(root)) {
    throw new Error("memoryDir cannot be the project root");
  }
}

function isBuiltinMemoryPageId(value: string): value is BuiltinMemoryPageId {
  return BUILTIN_MEMORY_PAGE_IDS.includes(value as BuiltinMemoryPageId);
}

function requiredMapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function optionalMapping(value: unknown, label: string): Record<string, unknown> {
  return value === undefined ? {} : requiredMapping(value, label);
}

function integerSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
  minimum: number,
): number {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function booleanSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: boolean,
): boolean {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function nonEmptyStringSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string,
): string {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value.trim();
}

function optionalStringSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, string> {
  const value = mapping[key];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} must be a string without NUL bytes`);
  }
  return { [key]: value };
}

function enumSetting<const T extends string>(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: T,
  values: readonly T[],
): T {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function projectRelativeDirectorySetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string,
): string {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a project-relative directory`);
  }
  const candidate = value.trim().replace(/\\/g, "/");
  const normalized = path.posix.normalize(candidate);
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be a project-relative directory inside the project`);
  }
  return normalized.replace(/^\.\//, "");
}

function stringArraySetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: readonly string[],
  options: { projectRelative?: boolean } = {},
): string[] {
  const value = mapping[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.includes("\0")) {
      throw new Error(`${label}[${index}] must be a non-empty string without NUL bytes`);
    }
    if (!options.projectRelative) return entry;
    const candidate = entry.trim().replace(/\\/g, "/");
    const normalized = path.posix.normalize(candidate);
    if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`${label}[${index}] must stay inside the project`);
    }
    return normalized.replace(/^\.\//, "");
  });
}

function portRangeSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: readonly [number, number],
): [number, number] {
  const value = mapping[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => Number.isSafeInteger(entry))) {
    throw new Error(`${label} must contain exactly two integer ports`);
  }
  const start = value[0] as number;
  const end = value[1] as number;
  if (start < 1 || end > 65_535 || start > end) {
    throw new Error(`${label} must be an ascending range between 1 and 65535`);
  }
  return [start, end];
}

function environmentNameSetting(
  mapping: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string,
): string {
  const value = nonEmptyStringSetting(mapping, key, label, fallback);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} must be an environment variable name`);
  return value;
}

function composeProjectPrefixSetting(mapping: Record<string, unknown>, fallback: string): string {
  const value = nonEmptyStringSetting(mapping, "projectPrefix", "isolation.runtime.projectPrefix", fallback);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
    throw new Error("isolation.runtime.projectPrefix must contain only letters, digits, underscores, or hyphens");
  }
  return value;
}

function cloneMemoryPages(value: MemoryPagesConfig): MemoryPagesConfig {
  return {
    enabled: [...value.enabled],
    custom: value.custom.map((page) => ({ ...page })),
  };
}

function cloneSetupSpec(value: SetupSpec): SetupSpec {
  return {
    memoryPages: cloneMemoryPages(value.memoryPages),
    roadmap: value.roadmap.provider === "internal"
      ? { ...value.roadmap }
      : { ...value.roadmap, command: [...value.roadmap.command] },
  };
}

async function readLegacyRoadmapPath(root: string, memoryDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.resolve(root, memoryDir, "manual", "web-settings.json"), "utf8");
    const settings = JSON.parse(raw) as { roadmapPath?: unknown };
    if (typeof settings.roadmapPath !== "string") return undefined;
    return normalizeProjectMarkdownPath(settings.roadmapPath, "Legacy roadmap path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    if (error instanceof Error && error.message.startsWith("Legacy roadmap path")) return undefined;
    throw error;
  }
}

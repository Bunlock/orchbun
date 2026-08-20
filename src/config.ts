import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentKind, RunMode } from "./types.js";

export interface OrchbunConfig {
  version: 1;
  memoryDir: string;
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
  const parsed = YAML.parse(await readFile(path.join(root, CONFIG_FILE), "utf8")) as Partial<OrchbunConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    budgets: { ...DEFAULT_CONFIG.budgets, ...parsed.budgets },
    agents: { ...DEFAULT_CONFIG.agents, ...parsed.agents },
    delegation: { ...DEFAULT_CONFIG.delegation, ...parsed.delegation },
    images: { ...DEFAULT_CONFIG.images, ...parsed.images },
    hooks: { ...DEFAULT_CONFIG.hooks, ...parsed.hooks },
    isolation: {
      ...DEFAULT_CONFIG.isolation,
      ...parsed.isolation,
      runtime: {
        ...DEFAULT_CONFIG.isolation.runtime,
        ...parsed.isolation?.runtime,
      },
    },
  };
}

export function memoryRoot(root: string, config: OrchbunConfig): string {
  return path.resolve(root, config.memoryDir);
}

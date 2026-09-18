import {
  BUILTIN_MEMORY_PAGES,
  validateMemoryPagesConfig,
  type BuiltinMemoryPageId,
  type CustomMemoryPageConfig as ConfigCustomMemoryPageConfig,
  type MemoryPagesConfig,
} from "./config.js";

/** Stable tuple form retained for existing memory projection callers. */
export const MEMORY_PAGE_DEFINITIONS = BUILTIN_MEMORY_PAGES.map(
  ({ id, title, filename }) => [id, title, filename] as const,
);

export type BuiltInMemoryPageId = BuiltinMemoryPageId;

/** Legacy name retained for callers that operate on the five generated pages. */
export type MemoryPageId = BuiltInMemoryPageId;

export type CustomMemoryPageConfig = ConfigCustomMemoryPageConfig;
export type MemoryPagesConfigInput = MemoryPagesConfig;

export interface MemoryPageDefinition {
  id: string;
  title: string;
  filename: string;
  kind: "builtin" | "custom";
  includeInContext: boolean;
  /** Used only when a new custom page has no persisted manual source yet. */
  starter?: string;
}

const BUILT_IN_IDS = new Set<string>(MEMORY_PAGE_DEFINITIONS.map(([id]) => id));
export const MAX_MEMORY_PAGE_BYTES = 250_000;

export const DEFAULT_MEMORY_PAGE_CATALOGUE: readonly MemoryPageDefinition[] = Object.freeze(
  MEMORY_PAGE_DEFINITIONS.map(([id, title, filename]) => Object.freeze({
    id,
    title,
    filename,
    kind: "builtin" as const,
    includeInContext: true,
  })),
);

/**
 * Resolve the effective ordered page catalogue from an OrchBun-shaped config.
 * The shared config validator also protects callers that construct the
 * structural input directly.
 */
export function memoryPageCatalogue(
  config?: { memoryPages?: MemoryPagesConfigInput },
): MemoryPageDefinition[] {
  if (!config?.memoryPages) return DEFAULT_MEMORY_PAGE_CATALOGUE.map((page) => ({ ...page }));

  const selected = validateMemoryPagesConfig(config.memoryPages);
  const definitions = new Map(DEFAULT_MEMORY_PAGE_CATALOGUE.map((page) => [page.id, page]));
  const catalogue: MemoryPageDefinition[] = selected.enabled.map((id) => ({ ...definitions.get(id)! }));
  for (const custom of selected.custom) {
    catalogue.push({
      id: custom.id,
      title: custom.title.trim(),
      filename: `${custom.id}.md`,
      kind: "custom",
      includeInContext: custom.includeInContext,
      ...(custom.starter === undefined ? {} : { starter: custom.starter }),
    });
  }
  return catalogue;
}

export function isBuiltInMemoryPageId(id: string): id is BuiltInMemoryPageId {
  return BUILT_IN_IDS.has(id);
}

export function initialMemoryPageMarkdown(page: MemoryPageDefinition): string {
  if (page.kind === "custom") return normalize(page.starter ?? `# ${page.title}`);
  switch (page.id as BuiltInMemoryPageId) {
    case "project-state": return "# Project state\n\nNo managed runs recorded.\n";
    case "active-tasks": return "# Active tasks\n\nNo active tasks recorded.\n";
    case "decisions": return "# Decisions\n\nNo decisions recorded.\n";
    case "contracts": return "# Operational constraints\n\nNo operational constraints recorded.\n";
    case "risks": return "# Risks and blockers\n\nNo risks recorded.\n";
    default: throw new Error(`Unknown built-in memory page ${page.id}`);
  }
}

function normalize(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

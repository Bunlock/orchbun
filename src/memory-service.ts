import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, memoryRoot, pathExists } from "./config.js";
import {
  assertValidDirectMemory,
  loadDirectMemory,
  recordDirectMemoryUnlocked,
  resolveDirectMemory,
  type DirectMemoryNote,
} from "./direct-memory.js";
import { RunJournal } from "./journal.js";
import { buildMemoryProjection, loadRuns, type MemoryProjection, type RecordedRun } from "./memory.js";
import { memoryPageCatalogue, type MemoryPageDefinition } from "./memory-pages.js";
import { loadCompactArchives, readCompactState, type CompactState } from "./milestone-memory.js";
import { compactTimestamp, contentHash, slug } from "./utils.js";

export type MemoryDocumentKind = "direct-note" | "managed-run" | "compact-baseline" | "projection";
export type MemoryLifecycle = "current" | "compacted" | "superseded" | "retired";
export type MemoryArchiveStatus = "live" | "archived";

export interface MemorySections {
  outcomes: string[];
  decisions: string[];
  contracts: string[];
  risks: string[];
  nextActions: string[];
  verification: string[];
}

export interface MemoryDocument {
  id: string;
  path: string;
  hash: string;
  sourceRevision: string;
  timestamp: string;
  kind: MemoryDocumentKind;
  taskIds: string[];
  subjects: string[];
  lifecycle: MemoryLifecycle;
  archiveStatus: MemoryArchiveStatus;
  lineage: string[];
  sections: MemorySections;
}

export interface MemoryQuery {
  text: string;
  taskId?: string;
  subjects?: string[];
  includeHistory?: boolean;
  maxResults?: number;
  maxCharacters?: number;
}

export interface MemoryCitation {
  id: string;
  path: string;
  hash: string;
}

export interface MemoryRankExplanation {
  exactTask: boolean;
  exactSubjects: string[];
  lexicalScore: number;
  matchedTerms: string[];
}

export type MemoryDocumentMetadata = Omit<MemoryDocument, "sections">;

export interface MemoryHit {
  document: MemoryDocumentMetadata;
  citation: MemoryCitation;
  snippet: string;
  rankExplanation: MemoryRankExplanation;
}

export interface MemorySearchResult {
  sourceRevision: string;
  query: MemoryQuery;
  totalCandidates: number;
  characters: number;
  hits: MemoryHit[];
}

export type DreamScope =
  | { taskId: string; subject?: never; all?: never }
  | { subject: string; taskId?: never; all?: never }
  | { all: true; taskId?: never; subject?: never };

export interface CitedStatement {
  text: string;
  citations: string[];
}

export interface DreamSections {
  outcomes: CitedStatement[];
  decisions: CitedStatement[];
  contracts: CitedStatement[];
  risks: CitedStatement[];
  nextActions: CitedStatement[];
  verification: CitedStatement[];
}

export interface DreamProposal {
  schemaVersion: 1;
  sourceRevision: string;
  scope: DreamScope;
  sections: DreamSections;
  proposedSupersedes: string[];
  archiveCandidates: { id: string; reason: string }[];
  retirementCandidates: { id: string; reason: string }[];
  parallelHeadConflicts: { subject: string; headIds: string[] }[];
  completenessWarnings: string[];
  citations: MemoryCitation[];
  draftMarkdown: string;
}

export interface MemoryIndex {
  schemaVersion: 1;
  sourceRevision: string;
  documentHashes: Record<string, string>;
  documentLengths: Record<string, number>;
  averageDocumentLength: number;
  postings: Record<string, Array<[documentId: string, frequency: number]>>;
}

interface DirectSource {
  note: DirectMemoryNote;
  archived: boolean;
}

interface RankedDocument {
  document: MemoryDocument;
  exactTask: boolean;
  exactSubjects: string[];
  lexicalScore: number;
  matchedTerms: string[];
}

const INDEX_RELATIVE_PATH = "search/index-v1.json";
const STOP_WORDS = new Set([
  // Small, fixed lists keep full-prompt lexical retrieval from being dominated
  // by function words while remaining deterministic across hosts.
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with",
  "au", "aux", "avec", "ce", "ces", "dans", "de", "des", "du", "en", "est", "et", "il", "la", "le", "les", "ou", "par", "pour", "que", "qui", "sur", "un", "une",
]);
const EMPTY_SECTIONS = (): MemorySections => ({
  outcomes: [], decisions: [], contracts: [], risks: [], nextActions: [], verification: [],
});

/**
 * Read-only by default. Authoritative Markdown/JSON remains outside this service;
 * only refreshIndex() publishes a disposable derivative.
 */
export class MemoryService {
  private constructor(
    readonly projectRoot: string,
    readonly memoryRoot: string,
    readonly sourceRevision: string,
    readonly documents: readonly MemoryDocument[],
    private readonly journal: RunJournal,
    private readonly directSources: readonly DirectSource[],
    private readonly index: MemoryIndex,
    private readonly defaultCharacterBudget: number,
  ) {}

  static async open(projectRoot: string): Promise<MemoryService> {
    const resolvedRoot = path.resolve(projectRoot);
    const config = await pathExists(path.join(resolvedRoot, CONFIG_FILE)) ? await loadConfig(resolvedRoot) : DEFAULT_CONFIG;
    const localMemoryRoot = memoryRoot(resolvedRoot, config);
    const journal = new RunJournal(localMemoryRoot);
    const [projection, direct, archivedDirect, runs, archivedRuns, compact, compactArchives] = await Promise.all([
      buildMemoryProjection(journal, resolvedRoot, { cacheWrites: false }),
      loadDirectMemory(localMemoryRoot),
      loadDirectMemory(path.join(localMemoryRoot, "archive")),
      loadRuns(journal),
      loadRuns(new RunJournal(path.join(localMemoryRoot, "archive"))),
      readCompactState(localMemoryRoot),
      loadCompactArchives(localMemoryRoot),
    ]);
    assertValidDirectMemory(direct);
    assertValidDirectMemory(archivedDirect);

    const directSources: DirectSource[] = [
      ...direct.notes.map((note) => ({ note, archived: false })),
      ...archivedDirect.notes.map((note) => ({ note, archived: true })),
    ];
    const documents = normalizeDocuments(
      projection,
      memoryPageCatalogue(config),
      directSources,
      runs,
      archivedRuns,
      compact,
      compactArchives.map((archive) => ({ path: archive.relativePath, state: archive.state })),
    );
    const expectedIndex = buildMemoryIndex(documents, projection.sourceRevision);
    const publishedIndex = await readValidIndex(path.join(localMemoryRoot, INDEX_RELATIVE_PATH), expectedIndex);
    return new MemoryService(
      resolvedRoot,
      localMemoryRoot,
      projection.sourceRevision,
      documents,
      journal,
      directSources,
      publishedIndex ?? expectedIndex,
      config.budgets.maxInputChars,
    );
  }

  getIndex(): MemoryIndex {
    return structuredClone(this.index);
  }

  /** Public publication revalidates this snapshot while holding the projection lock. */
  async refreshIndex(): Promise<void> {
    return this.journal.withProjectionLock(async () => {
      const current = await MemoryService.open(this.projectRoot);
      if (current.sourceRevision !== this.sourceRevision) {
        throw new Error("Memory changed after this search index was built. Open MemoryService again before publishing it.");
      }
      await current.refreshIndexUnlocked(this.sourceRevision);
    });
  }

  /** Caller already holds the projection lock. Intended for refresh publication. */
  async refreshIndexUnlocked(expectedSourceRevision: string): Promise<void> {
    if (this.sourceRevision !== expectedSourceRevision) {
      throw new Error("Search index source revision does not match the published memory projection");
    }
    const directory = path.join(this.memoryRoot, "search");
    const target = path.join(this.memoryRoot, INDEX_RELATIVE_PATH);
    const serialized = `${JSON.stringify(this.index, null, 2)}\n`;
    try {
      if (await readFile(target, "utf8") === serialized) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async verifyIndex(): Promise<string[]> {
    const target = path.join(this.memoryRoot, INDEX_RELATIVE_PATH);
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [`${INDEX_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return sameIndex(parsed, this.index) ? [] : [`${INDEX_RELATIVE_PATH}: index does not match authoritative sources`];
    } catch (error) {
      return [`${INDEX_RELATIVE_PATH}: invalid JSON (${error instanceof Error ? error.message : String(error)})`];
    }
  }

  retrieve(query: MemoryQuery): MemorySearchResult {
    validateQuery(query);
    const includeHistory = query.includeHistory ?? false;
    const eligible = this.documents.filter((document) => includeHistory || (
      document.lifecycle === "current" && document.archiveStatus === "live"
    ));
    const terms = unique(tokenize(query.text));
    const subjects = unique((query.subjects ?? []).map((subject) => subject.trim()).filter(Boolean));
    const lengths = eligible.map((document) => this.index.documentLengths[document.id] ?? 0);
    const averageLength = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
    const eligibleIds = new Set(eligible.map((document) => document.id));
    const hasTextQuery = Boolean(query.text.trim());
    const ranked = eligible.flatMap((document): RankedDocument[] => {
      const exactTask = Boolean(query.taskId && document.taskIds.includes(query.taskId));
      const exactSubjects = subjects.filter((subject) => document.subjects.includes(subject));
      const { score, matchedTerms } = bm25(document.id, terms, this.index, eligibleIds, eligible.length, averageLength);
      if ((hasTextQuery || query.taskId || subjects.length) && !exactTask && !exactSubjects.length && score === 0) return [];
      return [{ document, exactTask, exactSubjects, lexicalScore: score, matchedTerms }];
    }).sort(compareRankedDocuments);

    const maxResults = query.maxResults ?? 10;
    const maxCharacters = query.maxCharacters ?? this.defaultCharacterBudget;
    const hits: MemoryHit[] = [];
    let characters = 0;
    for (const rankedDocument of ranked) {
      if (hits.length >= maxResults || characters >= maxCharacters) break;
      const remaining = maxCharacters - characters;
      const snippet = renderSnippet(rankedDocument.document, unique([
        ...terms,
        ...tokenize(query.taskId ?? ""),
        ...subjects.flatMap(tokenize),
      ]), remaining);
      if (!snippet) continue;
      hits.push({
        document: documentMetadata(rankedDocument.document),
        citation: citation(rankedDocument.document),
        snippet,
        rankExplanation: {
          exactTask: rankedDocument.exactTask,
          exactSubjects: rankedDocument.exactSubjects,
          lexicalScore: Number(rankedDocument.lexicalScore.toFixed(6)),
          matchedTerms: rankedDocument.matchedTerms,
        },
      });
      characters += snippet.length;
    }
    return {
      sourceRevision: this.sourceRevision,
      query: { ...query, ...(query.subjects ? { subjects: [...query.subjects] } : {}) },
      totalCandidates: ranked.length,
      characters,
      hits,
    };
  }

  proposeDream(scope: DreamScope): DreamProposal {
    validateScope(scope);
    const selected = this.documents.filter((document) => document.lifecycle === "current"
      && document.archiveStatus === "live" && matchesScope(document, scope));
    const sections: DreamSections = {
      outcomes: collectStatements(selected, "outcomes"),
      decisions: collectStatements(selected, "decisions"),
      contracts: collectStatements(selected, "contracts"),
      risks: collectStatements(selected, "risks"),
      nextActions: collectStatements(selected, "nextActions"),
      verification: collectStatements(selected, "verification"),
    };
    const sectionLists: CitedStatement[][] = [
      sections.outcomes, sections.decisions, sections.contracts,
      sections.risks, sections.nextActions, sections.verification,
    ];
    const citedIds = unique(sectionLists.flatMap((items) => items.flatMap((item) => item.citations))).sort();
    const byId = new Map(this.documents.map((document) => [document.id, document]));
    const citations = citedIds.map((id) => citation(byId.get(id)!));
    const parallelHeadConflicts = directConflicts(this.directSources, scope);
    const conflictedHeadIds = new Set(parallelHeadConflicts.flatMap((conflict) => conflict.headIds));
    const directResolution = resolveDirectMemory(this.directSources.map((source) => source.note));
    const proposedSupersedes = "all" in scope
      ? []
      : this.directSources.filter(({ note, archived }) => !archived && note.status === "active")
        .map(({ note }) => note)
        .filter((note) => !directResolution.inactiveNoteIds.has(note.id))
        .filter((note) => matchesDirectScope(note, scope))
        .filter((note) => byId.get(`direct:${note.id}`)?.lifecycle === "current")
        .filter((note) => !conflictedHeadIds.has(note.id))
        .map((note) => note.id)
        .sort();
    const inactiveNoteIds = directResolution.inactiveNoteIds;
    const archiveCandidates = this.directSources
      .filter(({ note, archived }) => !archived && inactiveNoteIds.has(note.id))
      .filter(({ note }) => matchesDirectScope(note, scope))
      .map(({ note }) => ({ id: note.id, reason: note.reason ?? (note.status === "active" ? "A newer direct note supersedes this lifecycle record." : `Lifecycle is ${note.status}.`) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const retirementCandidates = compactedRetirementCandidates(this.directSources, this.documents, scope);
    const completenessWarnings = dreamWarnings(selected, sections, parallelHeadConflicts, scope);
    const proposal: DreamProposal = {
      schemaVersion: 1,
      sourceRevision: this.sourceRevision,
      scope,
      sections,
      proposedSupersedes,
      archiveCandidates,
      retirementCandidates,
      parallelHeadConflicts,
      completenessWarnings,
      citations,
      draftMarkdown: "",
    };
    proposal.draftMarkdown = renderDreamDraft(proposal, selected);
    return proposal;
  }

  async acceptDream(proposal: DreamProposal, reviewedMarkdown: string, agent = "codex") {
    validateProposal(proposal);
    return this.journal.withProjectionLock(async () => {
      const current = await MemoryService.open(this.projectRoot);
      if (current.sourceRevision !== proposal.sourceRevision) {
        validateReviewedDream(proposal, reviewedMarkdown);
        const prepared = prepareAcceptedMarkdown(proposal, reviewedMarkdown, agent, this.documents);
        const id = directNoteId(prepared.markdown, prepared.timestamp);
        if (current.documents.some((document) => document.id === `direct:${id}`)) {
          return recordDirectMemoryUnlocked(current.journal, current.projectRoot, prepared.markdown, agent);
        }
        throw new Error("Dream proposal is stale. Re-run memory dream and review the newer sources before accepting.");
      }
      const canonical = current.proposeDream(proposal.scope);
      validateProposalIntegrity(proposal, canonical);
      validateReviewedDream(canonical, reviewedMarkdown);
      validateProposalCitations(canonical, current.documents);
      const prepared = prepareAcceptedMarkdown(canonical, reviewedMarkdown, agent, current.documents);
      validateSupersessionTargets(reviewedMarkdown, current.directSources, prepared.timestamp);
      return recordDirectMemoryUnlocked(current.journal, current.projectRoot, prepared.markdown, agent);
    });
  }
}

export function buildMemoryIndex(documents: readonly MemoryDocument[], sourceRevision: string): MemoryIndex {
  const documentHashes: Record<string, string> = {};
  const documentLengths: Record<string, number> = {};
  const terms = new Map<string, Map<string, number>>();
  for (const document of [...documents].sort((a, b) => a.id.localeCompare(b.id))) {
    documentHashes[document.id] = document.hash;
    const tokens = tokenize(documentText(document));
    documentLengths[document.id] = tokens.length;
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) {
      const posting = terms.get(term) ?? new Map<string, number>();
      posting.set(document.id, frequency);
      terms.set(term, posting);
    }
  }
  const lengths = Object.values(documentLengths);
  return {
    schemaVersion: 1,
    sourceRevision,
    documentHashes,
    documentLengths,
    averageDocumentLength: lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0,
    postings: Object.fromEntries([...terms.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([term, posting]) => [
      term,
      [...posting.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ])),
  };
}

function normalizeDocuments(
  projection: MemoryProjection,
  catalogue: readonly MemoryPageDefinition[],
  directSources: readonly DirectSource[],
  runs: readonly RecordedRun[],
  archivedRuns: readonly RecordedRun[],
  compact: CompactState | undefined,
  compactArchives: readonly { path: string; state: CompactState }[],
): MemoryDocument[] {
  const revision = projection.sourceRevision;
  const resolved = resolveDirectMemory(directSources.map(({ note }) => note));
  const archivedDirectIds = new Set(directSources.filter((source) => source.archived).map((source) => source.note.id));
  const includedDirectIds = new Set(compact?.includedDirectNoteIds ?? []);
  const direct = directSources.map(({ note }): MemoryDocument => {
    const inactive = resolved.inactiveNoteIds.has(note.id);
    const lifecycle: MemoryLifecycle = note.status === "retired"
      ? "retired"
      : inactive ? "superseded" : includedDirectIds.has(note.id) ? "compacted" : "current";
    const sections: MemorySections = {
      outcomes: [note.outcome], decisions: note.decisions, contracts: [], risks: note.risks,
      nextActions: note.nextActions, verification: note.verification,
    };
    const normalized = {
      id: note.id, timestamp: note.timestamp, task: note.task, subjects: note.subjects,
      status: note.status, workStatus: note.workStatus, reason: note.reason, supersedes: note.supersedes,
      sources: note.sources, basedOnRevision: note.basedOnRevision, sections,
    };
    const archived = archivedDirectIds.has(note.id);
    return {
      id: `direct:${note.id}`,
      path: archived ? `archive/${note.relativePath}` : note.relativePath,
      hash: contentHash(JSON.stringify(normalized)),
      sourceRevision: revision,
      timestamp: note.timestamp,
      kind: "direct-note",
      taskIds: taskIdentifiers(note.task),
      subjects: [...note.subjects],
      lifecycle,
      archiveStatus: archived ? "archived" : "live",
      lineage: resolved.lineages.get(note.id) ?? [note.id],
      sections,
    };
  });
  const includedRunIds = new Set(compact?.includedManagedRunIds ?? []);
  const managedRuns = [
    ...runs.map((run) => ({ run, archived: false })),
    ...archivedRuns.map((run) => ({ run, archived: true })),
  ].flatMap(({ run, archived }): MemoryDocument[] => {
    if (!run.result) return [];
    const runId = run.metadata.runId;
    const sections: MemorySections = {
      outcomes: [run.result.summary],
      decisions: run.result.decisions,
      contracts: [],
      risks: [...run.result.risks, ...run.result.blockers],
      nextActions: run.result.next_actions,
      verification: run.result.verification.map((item) => `${item.check}: ${item.result}. ${item.evidence}`),
    };
    const taskIds = unique([run.metadata.taskId, run.result.task_id].filter((item): item is string => Boolean(item))
      .flatMap(taskIdentifiers));
    const normalized = { runId, timestamp: run.metadata.finishedAt ?? run.metadata.startedAt, taskIds, outcome: run.result.outcome, sections };
    return [{
      id: `run:${runId}`,
      path: `${archived ? "archive/" : ""}runs/${runId.slice(0, 4)}/${runId.slice(4, 6)}/${runId}/result.json`,
      hash: contentHash(JSON.stringify(normalized)),
      sourceRevision: revision,
      timestamp: run.metadata.finishedAt ?? run.metadata.startedAt,
      kind: "managed-run",
      taskIds,
      subjects: [],
      lifecycle: includedRunIds.has(runId) ? "compacted" : "current",
      archiveStatus: archived ? "archived" : "live",
      lineage: [runId],
      sections,
    }];
  });
  const compactDocuments: MemoryDocument[] = [];
  const directById = new Map(directSources.map(({ note }) => [note.id, note]));
  const runById = new Map([...runs, ...archivedRuns].map((run) => [run.metadata.runId, run]));
  if (compact) compactDocuments.push(compactDocument(
    compact, "working/compact-state.json", "live", revision, compactIdentity(compact, directById, runById),
  ));
  for (const archive of compactArchives) {
    if (compact?.archivePath === archive.path) continue;
    compactDocuments.push(compactDocument(
      archive.state, `${archive.path}/publication.json`, "archived", revision,
      compactIdentity(archive.state, directById, runById),
    ));
  }
  const sourceTimestamps = [...direct, ...managedRuns, ...compactDocuments].map((document) => document.timestamp);
  const projectionTimestamp = sourceTimestamps.sort().at(-1) ?? "1970-01-01T00:00:00Z";
  const projectedPages = projection.pages as Record<string, string>;
  const projectionDocuments = catalogue
    .filter((page) => page.includeInContext)
    .flatMap((page) => {
      const markdown = projectedPages[page.id];
      return typeof markdown === "string"
        ? [projectionDocument(page, markdown, revision, projectionTimestamp)]
        : [];
    });
  return [...direct, ...managedRuns, ...compactDocuments, ...projectionDocuments]
    .sort((a, b) => a.id.localeCompare(b.id));
}

function compactDocument(
  state: CompactState,
  documentPath: string,
  archiveStatus: MemoryArchiveStatus,
  sourceRevision: string,
  identity: { taskIds: string[]; subjects: string[] },
): MemoryDocument {
  const sections: MemorySections = {
    outcomes: [state.baseline.summary, ...state.baseline.validatedOutcomes],
    decisions: state.baseline.decisions,
    contracts: state.baseline.contracts,
    risks: state.baseline.risks,
    nextActions: state.baseline.pendingWork,
    verification: [],
  };
  return {
    id: `compact:${state.manifestHash}`,
    path: documentPath,
    hash: contentHash(JSON.stringify({ milestone: state.milestone, publishedAt: state.publishedAt, manifestHash: state.manifestHash, sections })),
    sourceRevision,
    timestamp: state.publishedAt,
    kind: "compact-baseline",
    taskIds: identity.taskIds,
    subjects: unique([`milestone/${state.milestone}`, ...identity.subjects]),
    lifecycle: archiveStatus === "live" ? "current" : "compacted",
    archiveStatus,
    lineage: [state.manifestHash],
    sections,
  };
}

function compactIdentity(
  state: CompactState,
  directById: ReadonlyMap<string, DirectMemoryNote>,
  runById: ReadonlyMap<string, RecordedRun>,
): { taskIds: string[]; subjects: string[] } {
  const includedDirect = state.includedDirectNoteIds.flatMap((id) => {
    const note = directById.get(id);
    return note ? [note] : [];
  });
  const taskIds = unique([
    ...includedDirect.flatMap((note) => taskIdentifiers(note.task)),
    ...state.includedManagedRunIds.flatMap((id) => {
      const run = runById.get(id);
      return run ? [run.metadata.taskId, run.result?.task_id].filter((item): item is string => Boolean(item)).flatMap(taskIdentifiers) : [];
    }),
  ]).sort();
  return { taskIds, subjects: unique(includedDirect.flatMap((note) => note.subjects)).sort() };
}

function projectionDocument(
  page: MemoryPageDefinition,
  markdown: string,
  sourceRevision: string,
  timestamp: string,
): MemoryDocument {
  const lines = markdownLines(markdown);
  const sections = EMPTY_SECTIONS();
  if (page.id === "active-tasks") sections.nextActions = lines;
  else if (page.id === "decisions") sections.decisions = lines;
  else if (page.id === "contracts") sections.contracts = lines;
  else if (page.id === "risks") sections.risks = lines;
  else sections.outcomes = lines;
  return {
    id: `projection:${page.id}`,
    path: `working/${page.filename}`,
    hash: contentHash(markdown),
    sourceRevision,
    timestamp,
    kind: "projection",
    taskIds: [],
    subjects: [`projection/${page.id}`],
    lifecycle: "current",
    archiveStatus: "live",
    lineage: [`projection:${page.id}`],
    sections,
  };
}

function markdownLines(markdown: string): string[] {
  return unique(markdown.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("<!--"))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line && !/^No .+ recorded\.?$/i.test(line)
      && line !== "These notes are preserved as written. Current task and risk status comes from the generated sections above."
      && line !== "Refreshing memory does not rerun these checks."));
}

async function readValidIndex(file: string, expected: MemoryIndex): Promise<MemoryIndex | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return sameIndex(parsed, expected) ? parsed as MemoryIndex : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function sameIndex(candidate: unknown, expected: MemoryIndex): boolean {
  return typeof candidate === "object" && candidate !== null
    && contentHash(JSON.stringify(candidate)) === contentHash(JSON.stringify(expected));
}

function documentText(document: MemoryDocument): string {
  return [
    ...document.taskIds,
    ...document.subjects,
    ...Object.values(document.sections).flat(),
  ].join("\n");
}

function tokenize(text: string): string[] {
  return (text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}](?:[\p{L}\p{N}/_-]*[\p{L}\p{N}])?/gu) ?? [])
    .filter((token) => !STOP_WORDS.has(token));
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}

function taskIdentifiers(task: string): string[] {
  return unique([task, ...(task.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) ?? [])]);
}

function validateQuery(query: MemoryQuery): void {
  if (typeof query.text !== "string") throw new Error("Memory query text must be a string");
  if (query.taskId !== undefined && !query.taskId.trim()) throw new Error("Memory query taskId must not be empty");
  if (query.subjects?.some((subject) => !subject.trim())) throw new Error("Memory query subjects must not contain empty values");
  if (query.maxResults !== undefined && (!Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 100)) {
    throw new Error("Memory query maxResults must be an integer from 1 to 100");
  }
  if (query.maxCharacters !== undefined && (!Number.isInteger(query.maxCharacters) || query.maxCharacters < 1 || query.maxCharacters > 250_000)) {
    throw new Error("Memory query maxCharacters must be an integer from 1 to 250000");
  }
}

function bm25(
  documentId: string,
  terms: readonly string[],
  index: MemoryIndex,
  eligibleIds: ReadonlySet<string>,
  documentCount: number,
  averageLength: number,
): { score: number; matchedTerms: string[] } {
  if (!terms.length || !documentCount) return { score: 0, matchedTerms: [] };
  const k1 = 1.2;
  const b = 0.75;
  const length = index.documentLengths[documentId] ?? 0;
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    const posting = index.postings[term] ?? [];
    const frequency = posting.find(([id]) => id === documentId)?.[1] ?? 0;
    if (!frequency) continue;
    matchedTerms.push(term);
    const documentFrequency = posting.filter(([id]) => eligibleIds.has(id)).length;
    const inverseFrequency = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const normalization = frequency + k1 * (1 - b + b * (averageLength ? length / averageLength : 0));
    score += inverseFrequency * (frequency * (k1 + 1)) / normalization;
  }
  return { score, matchedTerms };
}

function compareRankedDocuments(a: RankedDocument, b: RankedDocument): number {
  if (a.exactTask !== b.exactTask) return a.exactTask ? -1 : 1;
  if (a.exactSubjects.length !== b.exactSubjects.length) return b.exactSubjects.length - a.exactSubjects.length;
  if (a.lexicalScore !== b.lexicalScore) return b.lexicalScore - a.lexicalScore;
  return b.document.timestamp.localeCompare(a.document.timestamp) || a.document.id.localeCompare(b.document.id);
}

function renderSnippet(document: MemoryDocument, queryTerms: readonly string[], maximum: number): string {
  if (maximum < 1) return "";
  const lines = (Object.entries(document.sections) as Array<[keyof MemorySections, string[]]>).flatMap(([section, values]) =>
    values.map((value) => ({ text: `${section}: ${value}`, matches: queryTerms.some((term) => tokenize(value).includes(term)) })),
  );
  lines.sort((a, b) => Number(b.matches) - Number(a.matches));
  const output: string[] = [];
  let length = 0;
  for (const line of lines) {
    const separator = output.length ? "\n" : "";
    if (length + separator.length + line.text.length <= maximum) {
      output.push(line.text);
      length += separator.length + line.text.length;
      continue;
    }
    if (!output.length) output.push(line.text.slice(0, maximum));
    break;
  }
  return output.join("\n");
}

function citation(document: MemoryDocument): MemoryCitation {
  return { id: document.id, path: document.path, hash: document.hash };
}

function documentMetadata(document: MemoryDocument): MemoryDocumentMetadata {
  return {
    id: document.id,
    path: document.path,
    hash: document.hash,
    sourceRevision: document.sourceRevision,
    timestamp: document.timestamp,
    kind: document.kind,
    taskIds: [...document.taskIds],
    subjects: [...document.subjects],
    lifecycle: document.lifecycle,
    archiveStatus: document.archiveStatus,
    lineage: [...document.lineage],
  };
}

function validateScope(scope: DreamScope): void {
  if (!scope || typeof scope !== "object") throw new Error("Dream scope is required");
  const values = ["taskId" in scope && Boolean(scope.taskId?.trim()), "subject" in scope && Boolean(scope.subject?.trim()), "all" in scope && scope.all === true];
  if (values.filter(Boolean).length !== 1) throw new Error("Dream scope must specify exactly one taskId, subject, or all=true");
}

function matchesScope(document: MemoryDocument, scope: DreamScope): boolean {
  if ("all" in scope) return true;
  if ("taskId" in scope) return document.taskIds.includes(scope.taskId);
  return document.subjects.includes(scope.subject);
}

function matchesDirectScope(note: DirectMemoryNote, scope: DreamScope): boolean {
  if ("all" in scope) return true;
  if ("taskId" in scope) return taskIdentifiers(note.task).includes(scope.taskId);
  return note.subjects.includes(scope.subject);
}

function collectStatements(documents: readonly MemoryDocument[], section: keyof MemorySections): CitedStatement[] {
  const statements = new Map<string, { text: string; citations: Set<string> }>();
  for (const document of documents) {
    for (const raw of document.sections[section]) {
      const text = raw.trim();
      if (!text || ["none", "n/a", "not applicable"].includes(text.toLowerCase())) continue;
      const key = text.replace(/\s+/g, " ").toLocaleLowerCase("en-US");
      const statement = statements.get(key) ?? { text, citations: new Set<string>() };
      statement.citations.add(document.id);
      statements.set(key, statement);
    }
  }
  return [...statements.values()].map((statement) => ({
    text: statement.text,
    citations: [...statement.citations].sort(),
  })).sort((a, b) => a.text.localeCompare(b.text));
}

function compactedRetirementCandidates(
  directSources: readonly DirectSource[],
  documents: readonly MemoryDocument[],
  scope: DreamScope,
): { id: string; reason: string }[] {
  const resolution = resolveDirectMemory(directSources.map(({ note }) => note));
  const acceptedAt = documents.filter((document) => document.kind === "compact-baseline" && document.archiveStatus === "live")
    .map((document) => document.timestamp).sort().at(-1);
  if (!acceptedAt) return [];
  return directSources.filter(({ note, archived }) => !archived && note.status === "active"
    && !resolution.inactiveNoteIds.has(note.id) && matchesDirectScope(note, scope))
    .filter(({ note }) => note.timestamp <= acceptedAt)
    .map(({ note }) => ({ id: note.id, reason: "Current active head predates the accepted compact baseline; retirement requires review." }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function directConflicts(directSources: readonly DirectSource[], scope: DreamScope): { subject: string; headIds: string[] }[] {
  const notes = directSources.map((source) => source.note);
  const archivedIds = new Set(directSources.filter((source) => source.archived).map((source) => source.note.id));
  const current = resolveDirectMemory(notes).currentNotes
    .filter((note) => !archivedIds.has(note.id) && matchesDirectScope(note, scope));
  const heads = new Map<string, string[]>();
  for (const note of current) for (const subject of note.subjects) {
    const ids = heads.get(subject) ?? [];
    ids.push(note.id);
    heads.set(subject, ids);
  }
  return [...heads.entries()].filter(([, ids]) => ids.length > 1)
    .map(([subject, ids]) => ({ subject, headIds: ids.sort() }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function dreamWarnings(
  documents: readonly MemoryDocument[],
  sections: DreamSections,
  conflicts: readonly { subject: string; headIds: string[] }[],
  scope: DreamScope,
): string[] {
  const warnings: string[] = [];
  if (!documents.length) warnings.push("No current authoritative sources match this scope.");
  if (!sections.outcomes.length) warnings.push("No current outcome is recorded for this scope.");
  if (!sections.nextActions.length) warnings.push("No next action is recorded for this scope.");
  if (!sections.verification.length) warnings.push("No verification evidence is recorded for this scope.");
  if (sections.risks.length) warnings.push(`${sections.risks.length} unresolved risk or blocker statement(s) require review.`);
  if (conflicts.length) warnings.push(`${conflicts.length} subject(s) have parallel current heads; accepting the draft must be an explicit merge decision.`);
  if ("all" in scope) warnings.push("An all-memory dream never proposes automatic supersession; choose explicit targets during review.");
  const latestSource = documents.map((document) => document.timestamp).sort().at(-1);
  const latestVerification = documents.filter((document) => document.sections.verification.length)
    .map((document) => document.timestamp).sort().at(-1);
  if (latestSource && latestVerification && latestVerification < latestSource) {
    warnings.push("The latest recorded verification predates newer source material.");
  }
  return warnings;
}

function renderDreamDraft(proposal: DreamProposal, selected: readonly MemoryDocument[]): string {
  const scopeLabel = "taskId" in proposal.scope ? proposal.scope.taskId
    : "subject" in proposal.scope ? `Memory dream for ${proposal.scope.subject}` : "Memory-wide reviewed dream";
  const subjects = "subject" in proposal.scope
    ? [proposal.scope.subject]
    : unique(selected.filter((document) => document.kind === "direct-note").flatMap((document) => document.subjects)).sort();
  const field = (label: string, statements: readonly CitedStatement[]): string => statements.length
    ? `- **${label}:**\n${statements.map((statement) => `  - ${statement.text} ${statement.citations.map((id) => `[source:${id}]`).join(" ")}`).join("\n")}`
    : `- **${label}:** None`;
  const outcomes = proposal.sections.outcomes.length
    ? proposal.sections.outcomes.map((statement) => `${statement.text} ${statement.citations.map((id) => `[source:${id}]`).join(" ")}`).join(" ")
    : "No current outcome is recorded.";
  const conflictWarnings = proposal.parallelHeadConflicts.flatMap((conflict) => [
    `Parallel heads for ${conflict.subject}: ${conflict.headIds.join(", ")}. None are proposed for supersession by default.`,
    `To supersede a conflicted head, add the intended IDs under Supersedes and add "${conflict.subject}: ${conflict.headIds.join(", ")}" under Conflict resolutions.`,
  ]);
  const warnings = unique([...conflictWarnings, ...proposal.completenessWarnings]);
  const warningBlock = warnings.length ? `\n## Review warnings\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n` : "";
  const conflictResolutionField = proposal.parallelHeadConflicts.length
    ? "- **Conflict resolutions:** None\n"
    : "";
  return `# Reviewed memory dream

- **Task:** ${scopeLabel}
- **Outcome:** ${outcomes}
${field("Decisions", [
    ...proposal.sections.decisions,
    ...proposal.sections.contracts.map((statement) => ({ ...statement, text: `Contract: ${statement.text}` })),
  ])}
${field("Risks or blockers", proposal.sections.risks)}
${field("Next actions", proposal.sections.nextActions)}
- **Changed files:** None
${field("Verification", proposal.sections.verification)}
- **Status:** active
${subjects.length ? `- **Subjects:**\n${subjects.map((subject) => `  - ${subject}`).join("\n")}\n` : ""}${proposal.proposedSupersedes.length ? `- **Supersedes:**\n${proposal.proposedSupersedes.map((id) => `  - ${id}`).join("\n")}\n` : ""}${conflictResolutionField}- **Sources:**
${proposal.citations.map((item) => `  - ${item.id}`).join("\n") || "  - None"}
- **Based on revision:** ${proposal.sourceRevision}
${warningBlock}
`;
}

function validateProposal(proposal: DreamProposal): void {
  if (proposal.schemaVersion !== 1) throw new Error("Unsupported dream proposal schema version");
  if (!/^[a-f0-9]{64}$/.test(proposal.sourceRevision)) throw new Error("Dream proposal has an invalid source revision");
  validateScope(proposal.scope);
  if (!Array.isArray(proposal.citations) || !Array.isArray(proposal.proposedSupersedes)) throw new Error("Dream proposal is malformed");
}

function validateProposalIntegrity(proposal: DreamProposal, canonical: DreamProposal): void {
  const { draftMarkdown: _proposalDraft, ...proposalMetadata } = proposal;
  const { draftMarkdown: _canonicalDraft, ...canonicalMetadata } = canonical;
  if (stableJson(proposalMetadata) !== stableJson(canonicalMetadata)) {
    throw new Error("Dream proposal metadata changed. Create a new proposal and edit only its reviewed Markdown body.");
  }
}

function validateProposalCitations(proposal: DreamProposal, documents: readonly MemoryDocument[]): void {
  const byId = new Map(documents.map((document) => [document.id, document]));
  for (const item of proposal.citations) {
    const document = byId.get(item.id);
    if (!document || document.path !== item.path || document.hash !== item.hash) {
      throw new Error(`Dream citation ${item.id} no longer matches its authoritative source`);
    }
  }
}

function validateReviewedDream(proposal: DreamProposal, markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > 250_000) throw new Error("Reviewed dream is larger than 250 KB");
  if (fieldValues(markdown, "Agent").length || fieldValues(markdown, "Recorded at").length) {
    throw new Error("Reviewed dream must not set Agent or Recorded at; acceptance records deterministic provenance");
  }
  const statuses = fieldValues(markdown, "Status");
  if (statuses.length !== 1 || statuses[0]!.toLowerCase() !== "active") {
    throw new Error("Reviewed dream Status must be active");
  }
  const revision = singleField(markdown, "Based on revision");
  if (revision !== proposal.sourceRevision) throw new Error("Reviewed dream Based on revision does not match the proposal");
  const allowed = new Set(proposal.citations.map((item) => item.id));
  const inline = new Set([...markdown.matchAll(/\[source:([^\]]+)\]/g)].map((match) => match[1]!.trim()));
  if (!inline.size) throw new Error("Reviewed dream must retain at least one inline source citation");
  for (const id of inline) if (!allowed.has(id)) throw new Error(`Reviewed dream cites source outside the proposal: ${id}`);
  const sources = new Set(fieldValues(markdown, "Sources").filter((value) => value.toLowerCase() !== "none"));
  if (sources.size !== inline.size || [...sources].some((id) => !inline.has(id))) {
    throw new Error("Reviewed dream Sources must exactly match its inline source citations");
  }
  for (const label of ["Outcome", "Decisions", "Risks or blockers", "Next actions", "Verification"]) {
    for (const value of fieldValues(markdown, label)) {
      if (["none", "n/a", "not applicable"].includes(value.toLowerCase())) continue;
      if (!/\[source:[^\]]+\]/.test(value)) throw new Error(`Reviewed dream ${label} statement is missing an inline source citation`);
    }
  }
  const conflictsBySubject = new Map(proposal.parallelHeadConflicts.map((conflict) => [conflict.subject, conflict]));
  const conflictsByHead = new Map<string, typeof proposal.parallelHeadConflicts>();
  for (const conflict of proposal.parallelHeadConflicts) for (const headId of conflict.headIds) {
    const conflicts = conflictsByHead.get(headId) ?? [];
    conflicts.push(conflict);
    conflictsByHead.set(headId, conflicts);
  }
  const resolutions = parseConflictResolutions(markdown, conflictsBySubject);
  const allowedSupersedes = new Set([
    ...proposal.proposedSupersedes,
    ...proposal.parallelHeadConflicts.flatMap((conflict) => conflict.headIds),
    ...("all" in proposal.scope
      ? proposal.citations.flatMap((item) => item.id.startsWith("direct:") ? [item.id.slice("direct:".length)] : [])
      : []),
  ]);
  for (const target of fieldValues(markdown, "Supersedes")) {
    if (!allowedSupersedes.has(target)) throw new Error(`Reviewed dream supersedes unreviewed target ${target}`);
    for (const conflict of conflictsByHead.get(target) ?? []) {
      if (!resolutions.has(conflict.subject)) {
        throw new Error(`Reviewed dream must resolve parallel subject ${conflict.subject} before superseding ${target}`);
      }
    }
  }
}

function parseConflictResolutions(
  markdown: string,
  conflicts: ReadonlyMap<string, { subject: string; headIds: string[] }>,
): Set<string> {
  const resolved = new Set<string>();
  for (const value of fieldValues(markdown, "Conflict resolutions")) {
    if (["none", "n/a", "not applicable"].includes(value.toLowerCase())) continue;
    const match = /^([a-z0-9][a-z0-9/_-]*):\s*(.+)$/.exec(value);
    if (!match) throw new Error("Conflict resolutions must use 'subject: head-id, head-id'");
    const subject = match[1]!;
    const conflict = conflicts.get(subject);
    if (!conflict) throw new Error(`Conflict resolution names unknown parallel subject ${subject}`);
    const headIds = unique(match[2]!.split(",").map((id) => id.trim()).filter(Boolean)).sort();
    if (headIds.length !== conflict.headIds.length || headIds.some((id, index) => id !== [...conflict.headIds].sort()[index])) {
      throw new Error(`Conflict resolution for ${subject} must reference every head: ${conflict.headIds.join(", ")}`);
    }
    if (resolved.has(subject)) throw new Error(`Conflict resolution for ${subject} is duplicated`);
    resolved.add(subject);
  }
  return resolved;
}

function validateSupersessionTargets(markdown: string, directSources: readonly DirectSource[], recordedAt: string): void {
  const byId = new Map(directSources.map((source) => [source.note.id, source]));
  const resolution = resolveDirectMemory(directSources.map((source) => source.note));
  for (const target of fieldValues(markdown, "Supersedes")) {
    const source = byId.get(target);
    if (!source || source.archived || source.note.status !== "active" || resolution.inactiveNoteIds.has(target)) {
      throw new Error(`Reviewed dream may supersede only a current, unarchived head: ${target}`);
    }
    if (source.note.timestamp >= recordedAt) {
      throw new Error(`Reviewed dream supersession target ${target} must be older than Recorded at ${recordedAt}`);
    }
  }
}

function fieldValues(markdown: string, wanted: string): string[] {
  const output: string[] = [];
  let active = false;
  for (const line of markdown.split(/\r?\n/)) {
    const field = /^-\s+\*\*([^:]+):\*\*\s*(.*)$/.exec(line);
    if (field) {
      active = field[1]!.trim().toLowerCase() === wanted.toLowerCase();
      if (active && field[2]!.trim()) output.push(field[2]!.trim());
      continue;
    }
    const nested = /^\s{2,}-\s+(.+)$/.exec(line);
    if (active && nested) output.push(nested[1]!.trim());
  }
  return output;
}

function singleField(markdown: string, label: string): string | undefined {
  const values = fieldValues(markdown, label);
  return values.length === 1 ? values[0] : undefined;
}

function prepareAcceptedMarkdown(
  proposal: DreamProposal,
  reviewedMarkdown: string,
  agent: string,
  documents: readonly MemoryDocument[],
): { markdown: string; timestamp: string } {
  const cited = new Set(proposal.citations.map((item) => item.id));
  const timestamps = documents.filter((document) => cited.has(document.id)).map((document) => Date.parse(document.timestamp))
    .filter(Number.isFinite);
  if (!timestamps.length) throw new Error("Dream proposal has no timestamped authoritative citation");
  const timestamp = new Date(Math.floor(Math.max(...timestamps) / 1000) * 1000 + 1000).toISOString().replace(".000Z", "Z");
  let markdown = reviewedMarkdown.trimEnd();
  if (!fieldValues(markdown, "Agent").length) markdown += `\n- **Agent:** ${agent}`;
  if (!fieldValues(markdown, "Recorded at").length) markdown += `\n- **Recorded at:** ${timestamp}`;
  return { markdown: `${markdown}\n`, timestamp: singleField(markdown, "Recorded at") ?? timestamp };
}

function directNoteId(markdown: string, timestamp: string): string {
  const task = singleField(markdown, "Task") ?? "note";
  return `${compactTimestamp(new Date(timestamp))}-${slug(task).slice(0, 80).replace(/-$/, "")}-${contentHash(markdown).slice(0, 8)}`;
}

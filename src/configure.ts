import { randomUUID } from "node:crypto";
import { cp, link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML, { isMap, isNode, isScalar, isSeq, type Document, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import { atomicReplaceFile, atomicReplaceFileIfUnchanged } from "./atomic-file.js";
import {
  CONFIG_FILE,
  loadConfig,
  memoryRoot,
  parseConfigText,
  setupSpecFromConfig,
  validateSetupSpec,
  type ExternalRoadmapConfig,
  type OrchbunConfig,
  type SetupSpec,
} from "./config.js";
import { customPageStarter, defaultRoadmapMarkdown } from "./init.js";
import { RunJournal } from "./journal.js";
import { loadRoadmap, resolveProjectMarkdownPath } from "./roadmap.js";
import { describeSetupChanges } from "./setup-wizard.js";
import { contentHash } from "./utils.js";

export interface PendingSetupFile {
  kind: "roadmap" | "custom";
  path: string;
  content: string;
}

export interface ConfigureCandidateContext {
  root: string;
  journal: RunJournal;
  previousConfig: OrchbunConfig;
  config: OrchbunConfig;
  previousSetup: SetupSpec;
  setup: SetupSpec;
  pendingFiles: PendingSetupFile[];
  externalValidation?: unknown;
}

export interface ConfigureWorkspaceOptions {
  setup: SetupSpec;
  createInternalRoadmap?: boolean;
  validateExternalRoadmap?: (root: string, roadmap: ExternalRoadmapConfig) => Promise<unknown>;
  preview?: (candidate: ConfigureCandidateContext) => Promise<unknown>;
  /** Called with the projection lock held, after the candidate config and starter files are installed. */
  refresh: (candidate: ConfigureCandidateContext) => Promise<unknown>;
}

export interface ConfigureReceipt {
  root: string;
  previousSetup: SetupSpec;
  setup: SetupSpec;
  changes: string[];
  created: string[];
  previousRoadmapProvider: SetupSpec["roadmap"]["provider"];
  roadmapProvider: SetupSpec["roadmap"]["provider"];
  revision?: string;
}

export interface ConfigureRecoveryReceipt {
  recovered: boolean;
  concurrentConfigPreserved: boolean;
}

export class ConfigurationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationConflictError";
  }
}

/** Reload a concurrently edited config; retain reviewed answers for ordinary validation failures. */
export async function setupSpecForConfigurationRetry(
  root: string,
  reviewed: SetupSpec,
  error: unknown,
): Promise<SetupSpec> {
  return error instanceof ConfigurationConflictError
    ? setupSpecFromConfig(await loadConfig(path.resolve(root)))
    : validateSetupSpec(reviewed);
}

interface PendingConfigureTransaction {
  schemaVersion: 1;
  token: string;
  projectRoot: string;
  phase: "prepared" | "committed";
  originalConfig: string;
  candidateConfig: string;
  backupPresent: string[];
  createdFiles: OwnedSetupFile[];
}

interface OwnedSetupFile {
  scope: "project" | "memory";
  path: string;
  content: string;
}

/**
 * Replaces only memoryPages and roadmap in orchbun.yaml. The refresh callback must use an
 * unlocked publication primitive because this function owns the projection lock.
 */
export async function configureWorkspace(root: string, options: ConfigureWorkspaceOptions): Promise<ConfigureReceipt> {
  const resolved = path.resolve(root);
  const canonicalRoot = await realpath(resolved);
  await recoverPendingConfiguration(resolved);
  const configPath = path.join(resolved, CONFIG_FILE);
  const original = await readFile(configPath, "utf8");
  const previousConfig = await loadConfig(resolved);
  const previousSetup = setupSpecFromConfig(previousConfig);
  const setup = validateSetupSpec(options.setup);
  const candidateSource = updateSetupSections(original, setup);
  const config = parseConfigText(candidateSource);
  const pendingFiles = await validateAndPrepareFiles(resolved, previousConfig, config, options.createInternalRoadmap ?? false);
  let externalValidation: unknown;
  if (setup.roadmap.provider === "external") {
    if (!options.validateExternalRoadmap) {
      throw new Error("External roadmap configuration requires a successful read-only provider validation");
    }
    externalValidation = await options.validateExternalRoadmap(resolved, setup.roadmap);
  }
  const journal = new RunJournal(memoryRoot(resolved, config));
  const context: ConfigureCandidateContext = {
    root: resolved,
    journal,
    previousConfig,
    config,
    previousSetup,
    setup,
    pendingFiles,
    ...(externalValidation !== undefined ? { externalValidation } : {}),
  };
  await options.preview?.(context);

  return journal.withProjectionLock(async () => {
    const current = await readFile(configPath, "utf8");
    if (current !== original) {
      throw new ConfigurationConflictError(`${CONFIG_FILE} changed while configuration was being reviewed; no changes were applied`);
    }
    const token = randomUUID();
    const projectionBackup = await backupProjectionState(journal.memoryRoot, token);
    const transaction: PendingConfigureTransaction = {
      schemaVersion: 1,
      token,
      projectRoot: canonicalRoot,
      phase: "prepared",
      originalConfig: original,
      candidateConfig: candidateSource,
      backupPresent: [...projectionBackup.present],
      createdFiles: [],
    };
    await writePendingTransaction(journal.memoryRoot, transaction);
    const created: PendingSetupFile[] = [];
    try {
      for (const file of pendingFiles) {
        const owned = ownedSetupFile(canonicalRoot, journal.memoryRoot, file);
        transaction.createdFiles.push(owned);
        await writePendingTransaction(journal.memoryRoot, transaction);
        if (await installPendingFile(file, transaction.token)) {
          created.push(file);
        } else {
          transaction.createdFiles.pop();
          await writePendingTransaction(journal.memoryRoot, transaction);
        }
      }
      if (!await atomicReplaceFileIfUnchanged(configPath, original, candidateSource)) {
        throw new ConfigurationConflictError(`${CONFIG_FILE} changed while configuration was being installed; the concurrent edit was preserved`);
      }
      const refreshed = await options.refresh(context);
      if (await readFile(configPath, "utf8") !== candidateSource) {
        throw new Error(`${CONFIG_FILE} changed while the new projection was being published`);
      }
      const receipt: ConfigureReceipt = {
        root: resolved,
        previousSetup,
        setup,
        changes: describeSetupChanges(previousSetup, setup),
        created: created.map((file) => file.kind === "roadmap" && setup.roadmap.provider === "internal"
          ? setup.roadmap.path
          : path.relative(resolved, file.path).replace(/\\/g, "/")),
        previousRoadmapProvider: previousSetup.roadmap.provider,
        roadmapProvider: setup.roadmap.provider,
        ...revisionFrom(refreshed),
      };
      transaction.phase = "committed";
      await writePendingTransaction(journal.memoryRoot, transaction);
      // The committed receipt is itself sufficient for startup to finish cleanup after a
      // process loss, so cleanup errors do not turn a published configuration into a failure.
      await finishCommittedTransaction(canonicalRoot, journal.memoryRoot, projectionBackup, transaction).catch(() => undefined);
      return receipt;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        const recovery = await recoverPendingConfigurationUnlocked(canonicalRoot, journal.memoryRoot);
        if (recovery.concurrentConfigPreserved) {
          rollbackErrors.push(new Error(`${CONFIG_FILE} changed while the failed configuration was being rolled back; the concurrent edit was preserved`));
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], "Configuration failed and rollback was incomplete");
      }
      throw error;
    }
  });
}

interface ProjectionBackup {
  root: string;
  present: string[];
}

const PROJECTION_STATE_PATHS = ["working", "refresh", "index.md", "search", "cache/roadmap"] as const;
const CONFIGURE_DIRECTORY = "configure";
const CONFIGURE_PENDING_FILE = "pending.json";

async function backupProjectionState(memoryRoot: string, token: string): Promise<ProjectionBackup> {
  const backupRoot = configureBackupRoot(memoryRoot, token);
  await mkdir(backupRoot, { recursive: true });
  const present: string[] = [];
  try {
    for (const relative of PROJECTION_STATE_PATHS) {
      const source = path.join(memoryRoot, relative);
      try {
        await cp(source, path.join(backupRoot, relative), { recursive: true });
        present.push(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { root: backupRoot, present };
  } catch (error) {
    await rm(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

async function restoreProjectionState(memoryRoot: string, backup: ProjectionBackup): Promise<void> {
  const present = new Set(backup.present);
  for (const relative of PROJECTION_STATE_PATHS) {
    const target = path.join(memoryRoot, relative);
    await rm(target, { recursive: true, force: true });
    if (present.has(relative)) {
      await cp(path.join(backup.root, relative), target, { recursive: true });
    }
  }
}

/**
 * Recovers an interrupted configure transaction before any command consumes project state.
 * A prepared transaction is rolled back; a committed transaction only needs cleanup.
 */
export async function recoverPendingConfiguration(root: string): Promise<ConfigureRecoveryReceipt> {
  const resolved = path.resolve(root);
  const [config, canonicalRoot] = await Promise.all([loadConfig(resolved), realpath(resolved)]);
  const journal = new RunJournal(memoryRoot(resolved, config));
  return journal.withProjectionLock(() => recoverPendingConfigurationUnlocked(canonicalRoot, journal.memoryRoot));
}

async function recoverPendingConfigurationUnlocked(
  root: string,
  configuredMemoryRoot: string,
): Promise<ConfigureRecoveryReceipt> {
  const transaction = await readPendingTransaction(configuredMemoryRoot);
  if (!transaction) return { recovered: false, concurrentConfigPreserved: false };
  if (transaction.projectRoot !== root) throw new Error("Configuration recovery receipt belongs to a different project");
  const backup: ProjectionBackup = {
    root: configureBackupRoot(configuredMemoryRoot, transaction.token),
    present: [...transaction.backupPresent],
  };
  if (transaction.phase === "committed") {
    await finishCommittedTransaction(root, configuredMemoryRoot, backup, transaction);
    return { recovered: true, concurrentConfigPreserved: false };
  }

  const configPath = path.join(root, CONFIG_FILE);
  const current = await readFile(configPath, "utf8");
  let concurrentConfigPreserved = false;
  if (current === transaction.candidateConfig) {
    if (!await atomicReplaceFileIfUnchanged(configPath, transaction.candidateConfig, transaction.originalConfig)) {
      concurrentConfigPreserved = true;
    }
  } else if (current !== transaction.originalConfig) {
    concurrentConfigPreserved = true;
  }

  await restoreProjectionState(configuredMemoryRoot, backup);
  for (const file of [...transaction.createdFiles].reverse()) {
    await removeOwnedFileIfUnchanged(root, configuredMemoryRoot, file, transaction.token);
  }
  // Removing the receipt first makes any process loss from here an inert orphaned backup,
  // rather than a receipt which refers to state that has already been deleted.
  await rm(configurePendingPath(configuredMemoryRoot));
  await rm(backup.root, { recursive: true, force: true });
  return { recovered: true, concurrentConfigPreserved };
}

async function finishCommittedTransaction(
  root: string,
  memoryRoot: string,
  backup: ProjectionBackup,
  transaction: PendingConfigureTransaction,
): Promise<void> {
  for (const file of transaction.createdFiles) {
    await rm(setupStagePath(ownedSetupFilePath(root, memoryRoot, file), transaction.token), { force: true });
  }
  await rm(configurePendingPath(memoryRoot), { force: true });
  await rm(backup.root, { recursive: true, force: true });
}

function configurePendingPath(memoryRoot: string): string {
  return path.join(memoryRoot, CONFIGURE_DIRECTORY, CONFIGURE_PENDING_FILE);
}

function configureBackupRoot(memoryRoot: string, token: string): string {
  return path.join(memoryRoot, CONFIGURE_DIRECTORY, `backup-${token}`);
}

async function readPendingTransaction(memoryRoot: string): Promise<PendingConfigureTransaction | null> {
  let source: string;
  try { source = await readFile(configurePendingPath(memoryRoot), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("Invalid configuration recovery receipt"); }
  return validatePendingTransaction(value);
}

function validatePendingTransaction(value: unknown): PendingConfigureTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration recovery receipt");
  const input = value as Partial<PendingConfigureTransaction>;
  if (input.schemaVersion !== 1 || typeof input.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.token)
    || typeof input.projectRoot !== "string" || path.resolve(input.projectRoot) !== input.projectRoot
    || !["prepared", "committed"].includes(input.phase ?? "")
    || typeof input.originalConfig !== "string" || typeof input.candidateConfig !== "string"
    || !Array.isArray(input.backupPresent)
    || input.backupPresent.some((entry) => typeof entry !== "string" || !(PROJECTION_STATE_PATHS as readonly string[]).includes(entry))
    || new Set(input.backupPresent).size !== input.backupPresent.length
    || !Array.isArray(input.createdFiles)) {
    throw new Error("Invalid configuration recovery receipt");
  }
  const createdFiles = input.createdFiles.map((file) => validateOwnedSetupFile(file));
  return {
    schemaVersion: 1,
    token: input.token,
    projectRoot: input.projectRoot,
    phase: input.phase as PendingConfigureTransaction["phase"],
    originalConfig: input.originalConfig,
    candidateConfig: input.candidateConfig,
    backupPresent: [...input.backupPresent] as string[],
    createdFiles,
  };
}

function validateOwnedSetupFile(value: unknown): OwnedSetupFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration recovery receipt");
  const file = value as Partial<OwnedSetupFile>;
  if ((file.scope !== "project" && file.scope !== "memory") || typeof file.path !== "string"
    || !safeRelativePath(file.path) || typeof file.content !== "string") {
    throw new Error("Invalid configuration recovery receipt");
  }
  return { scope: file.scope, path: file.path, content: file.content };
}

async function writePendingTransaction(memoryRoot: string, transaction: PendingConfigureTransaction): Promise<void> {
  const target = configurePendingPath(memoryRoot);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicReplaceFile(target, `${JSON.stringify(transaction, null, 2)}\n`);
}

function ownedSetupFile(root: string, configuredMemoryRoot: string, file: PendingSetupFile): OwnedSetupFile {
  const absolute = path.resolve(file.path);
  const memoryRelative = relativeInside(configuredMemoryRoot, absolute);
  if (memoryRelative !== null) return { scope: "memory", path: memoryRelative, content: file.content };
  const projectRelative = relativeInside(root, absolute);
  if (projectRelative !== null) return { scope: "project", path: projectRelative, content: file.content };
  throw new Error(`Configuration starter path is outside the project and memory roots: ${file.path}`);
}

async function removeOwnedFileIfUnchanged(
  root: string,
  configuredMemoryRoot: string,
  file: OwnedSetupFile,
  token: string,
): Promise<void> {
  const target = ownedSetupFilePath(root, configuredMemoryRoot, file);
  const staged = setupStagePath(target, token);
  try {
    const [targetIdentity, stagedIdentity] = await Promise.all([stat(target), stat(staged)]);
    if (targetIdentity.dev === stagedIdentity.dev && targetIdentity.ino === stagedIdentity.ino
      && await readFile(target, "utf8") === file.content) {
      await rm(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await rm(staged, { force: true });
  }
}

function ownedSetupFilePath(root: string, configuredMemoryRoot: string, file: OwnedSetupFile): string {
  const base = file.scope === "memory" ? configuredMemoryRoot : root;
  const target = path.resolve(base, file.path);
  if (relativeInside(base, target) === null) throw new Error("Invalid configuration recovery receipt");
  return target;
}

function relativeInside(base: string, target: string): string | null {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return safeRelativePath(relative) ? relative.replace(/\\/g, "/") : null;
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`) && !value.includes("\0");
}

export function updateSetupSections(source: string, setup: SetupSpec): string {
  const value = validateSetupSpec(setup);
  const document = YAML.parseDocument(source);
  if (document.errors.length) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const parsed = document.toJS() as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${CONFIG_FILE} must be a mapping`);
  const memoryPages = mapAt(document, "memoryPages", value.memoryPages);
  updateScalarSequence(document, memoryPages, "enabled", value.memoryPages.enabled);
  updateCustomPages(document, memoryPages, value.memoryPages.custom);

  const roadmap = mapAt(document, "roadmap", value.roadmap);
  updateScalar(document, roadmap, "provider", value.roadmap.provider);
  if (value.roadmap.provider === "internal") {
    updateScalar(document, roadmap, "path", value.roadmap.path);
    roadmap.delete("name");
    roadmap.delete("command");
  } else {
    updateScalar(document, roadmap, "name", value.roadmap.name);
    updateScalarSequence(document, roadmap, "command", value.roadmap.command);
    roadmap.delete("path");
  }
  return document.toString({ lineWidth: 0 });
}

type ConfigDocument = Document<Node, true>;
type ConfigMap = YAMLMap<unknown, unknown>;
type ConfigSequence = YAMLSeq<unknown>;

function mapAt(document: ConfigDocument, key: string, fallback: object): ConfigMap {
  const existing = document.get(key, true);
  if (isMap(existing)) return existing;
  const replacement = document.createNode(fallback) as ConfigMap;
  copyNodePresentation(existing, replacement);
  document.set(key, replacement);
  return replacement;
}

function updateCustomPages(
  document: ConfigDocument,
  parent: ConfigMap,
  pages: SetupSpec["memoryPages"]["custom"],
): void {
  const existing = parent.get("custom", true);
  const sequence = isSeq(existing) ? existing : document.createNode([]) as ConfigSequence;
  if (!isSeq(existing)) {
    copyNodePresentation(existing, sequence);
    parent.set("custom", sequence);
  }
  const byId = new Map<string, ConfigMap>();
  for (const item of sequence.items) {
    if (!isMap(item)) continue;
    const id = item.get("id");
    if (typeof id === "string" && !byId.has(id)) byId.set(id, item);
  }
  sequence.items = pages.map((page) => {
    const item = byId.get(page.id) ?? document.createNode({}) as ConfigMap;
    updateScalar(document, item, "id", page.id);
    updateScalar(document, item, "title", page.title);
    updateScalar(document, item, "includeInContext", page.includeInContext);
    if (page.starter === undefined) item.delete("starter");
    else updateScalar(document, item, "starter", page.starter);
    return item;
  });
}

function updateScalarSequence(
  document: ConfigDocument,
  parent: ConfigMap,
  key: string,
  values: readonly string[],
): void {
  const existing = parent.get(key, true);
  const sequence = isSeq(existing) ? existing : document.createNode([]) as ConfigSequence;
  if (!isSeq(existing)) {
    copyNodePresentation(existing, sequence);
    parent.set(key, sequence);
  }
  const reusable = new Map<string, Node[]>();
  for (const item of sequence.items) {
    if (!isScalar(item) || typeof item.value !== "string") continue;
    const candidates = reusable.get(item.value) ?? [];
    candidates.push(item);
    reusable.set(item.value, candidates);
  }
  sequence.items = values.map((value) => reusable.get(value)?.shift() ?? document.createNode(value));
}

function updateScalar(
  document: ConfigDocument,
  parent: ConfigMap,
  key: string,
  value: string | boolean,
): void {
  const existing = parent.get(key, true);
  if (isScalar(existing)) {
    existing.value = value;
    return;
  }
  const replacement = document.createNode(value);
  copyNodePresentation(existing, replacement);
  parent.set(key, replacement);
}

function copyNodePresentation(source: unknown, target: Node): void {
  if (!isNode(source)) return;
  if (source.commentBefore !== undefined) target.commentBefore = source.commentBefore;
  if (source.comment !== undefined) target.comment = source.comment;
  if (source.spaceBefore !== undefined) target.spaceBefore = source.spaceBefore;
}

async function validateAndPrepareFiles(
  root: string,
  previousConfig: OrchbunConfig,
  config: OrchbunConfig,
  createInternalRoadmap: boolean,
): Promise<PendingSetupFile[]> {
  const pending: PendingSetupFile[] = [];
  if (config.roadmap.provider === "internal") {
    try {
      await loadRoadmap(root, config.roadmap.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createInternalRoadmap) {
        throw new Error(`Internal roadmap does not exist: ${config.roadmap.path}`);
      }
      pending.push({
        kind: "roadmap",
        path: await resolveProjectMarkdownPath(root, config.roadmap.path, { allowMissing: true }),
        content: defaultRoadmapMarkdown(path.basename(root)),
      });
    }
  }
  const pagesRoot = path.join(memoryRoot(root, previousConfig), "manual", "pages");
  for (const page of config.memoryPages.custom) {
    pending.push({
      kind: "custom",
      path: path.join(pagesRoot, `${page.id}.md`),
      content: customPageStarter(page.title, page.starter),
    });
  }
  return uniquePendingFiles(pending);
}

function uniquePendingFiles(files: PendingSetupFile[]): PendingSetupFile[] {
  const byPath = new Map<string, PendingSetupFile>();
  for (const file of files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return [...byPath.values()];
}

async function installPendingFile(file: PendingSetupFile, token: string): Promise<boolean> {
  await mkdir(path.dirname(file.path), { recursive: true });
  const staged = setupStagePath(file.path, token);
  try {
    await writeFile(staged, file.content, { encoding: "utf8", flag: "wx" });
    await link(staged, file.path);
    return true;
  } catch (error) {
    await rm(staged, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function setupStagePath(target: string, token: string): string {
  return path.join(path.dirname(target), `.orchbun-configure-${token}-${contentHash(path.resolve(target)).slice(0, 12)}.tmp`);
}

function revisionFrom(value: unknown): { revision?: string } {
  if (!value || typeof value !== "object" || !("revision" in value)) return {};
  const revision = (value as { revision?: unknown }).revision;
  return typeof revision === "string" ? { revision } : {};
}

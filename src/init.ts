import { appendFile, cp, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  configWithSetup,
  loadConfig,
  memoryRoot as resolveMemoryRoot,
  pathExists,
  setupSpecFromConfig,
  validateSetupSpec,
  type ExternalRoadmapConfig,
  type OrchbunConfig,
  type SetupSpec,
} from "./config.js";
import { RunJournal } from "./journal.js";
import { refreshMemoryUnlocked } from "./memory-refresh.js";
import { memoryPageCatalogue } from "./memory-pages.js";
import { resolveProjectMarkdownPath } from "./roadmap.js";

export interface InitReceipt {
  root: string;
  created: string[];
  memoryRoot: string;
}

export interface InitializeWorkspaceOptions {
  setup?: SetupSpec;
  validateExternalRoadmap?: (root: string, roadmap: ExternalRoadmapConfig) => Promise<unknown>;
  publishMemory?: (journal: RunJournal, root: string, config: OrchbunConfig) => Promise<unknown>;
}

export const DEFAULT_SETUP_SPEC: SetupSpec = setupSpecFromConfig(DEFAULT_CONFIG);

export async function initializeWorkspace(root: string, options: InitializeWorkspaceOptions = {}): Promise<InitReceipt> {
  const resolved = path.resolve(root);
  if (!(await pathExists(resolved))) throw new Error(`Project root does not exist: ${resolved}`);
  const configPath = path.join(resolved, CONFIG_FILE);
  const existingConfig = await pathExists(configPath);
  const existingConfigSource = existingConfig ? await readFile(configPath, "utf8") : null;
  const config = existingConfig
    ? await loadConfig(resolved)
    : configWithSetup(DEFAULT_CONFIG, validateSetupSpec(options.setup ?? DEFAULT_SETUP_SPEC));
  if (!existingConfig && config.roadmap.provider === "external") {
    if (!options.validateExternalRoadmap) {
      throw new Error("External roadmap setup requires a successful read-only provider validation");
    }
    await options.validateExternalRoadmap(resolved, config.roadmap);
  }
  const memoryRoot = resolveMemoryRoot(resolved, config);
  const journal = new RunJournal(memoryRoot);
  return journal.withProjectionLock(async () => {
    const created: string[] = [];
    const createdFiles: CreatedInitFile[] = [];
    let memoryBackup: InitMemoryBackup | undefined;
    try {
    if (existingConfig) {
      let currentConfigSource: string;
      try {
        currentConfigSource = await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`${CONFIG_FILE} was removed while initialization was waiting; no initialization changes were applied`);
        }
        throw error;
      }
      if (currentConfigSource !== existingConfigSource) {
        throw new Error(`${CONFIG_FILE} changed while initialization was waiting; no initialization changes were applied`);
      }
    }
    if (!existingConfig) {
      const configCreated = await writeMissing(configPath, YAML.stringify(config), created, createdFiles, CONFIG_FILE);
      if (!configCreated) {
        throw new Error(`${CONFIG_FILE} was created concurrently; no initialization changes were applied`);
      }
    }
    // Establish ownership of a new configuration before snapshotting memory. A
    // losing concurrent initializer must not roll back the winner's projection.
    memoryBackup = await backupInitMemoryState(memoryRoot);
    const projectName = path.basename(resolved);
    if (config.roadmap.provider === "internal") {
      await writeMissing(
        await resolveProjectMarkdownPath(resolved, config.roadmap.path, { allowMissing: true }),
        defaultRoadmapMarkdown(projectName),
        created,
        createdFiles,
        config.roadmap.path,
      );
    }
    const displayedMemoryDir = path.isAbsolute(config.memoryDir)
      ? config.memoryDir
      : config.memoryDir.replace(/\\/g, "/").replace(/\/+$/, "");
    await writeMissing(path.join(resolved, "AGENTS.md"), `# Agent workflow

- Read the generated working memory under \`${displayedMemoryDir}/working/\` before project work.
- Record durable direct-agent outcomes under \`${displayedMemoryDir}/direct/YYYY/MM/\`.
- Keep \`${displayedMemoryDir}/\` local and ignored by Git; keep the configured roadmap and this file versioned.
- Do not edit generated working files directly from the filesystem. Use OrchBun memory web for persistent human annotations.
- Use \`orchbun memory record --file outcome.md\` to validate, record, and refresh a direct outcome. Use \`orchbun memory refresh --dry-run\` for a read-only current view.
- Run \`orchbun memory verify\` after recording memory. Explicit \`memory rebuild\` additionally maintains the roadmap projection and runs its configured hook.
- Mark only completed, verified roadmap steps as done. Approve a milestone manifest only after every step passes.
`, created, createdFiles, "AGENTS.md");
    for (const page of config.memoryPages.custom) {
      const target = path.join(memoryRoot, "manual", "pages", `${page.id}.md`);
      const relative = path.relative(resolved, target).replace(/\\/g, "/");
      await writeMissing(
        target,
        customPageStarter(page.title, page.starter),
        created,
        createdFiles,
        relative,
      );
    }
      await journal.initialize(memoryPageCatalogue(config));
      if (options.publishMemory) await options.publishMemory(journal, resolved, config);
      else await refreshMemoryUnlocked(journal, resolved);

    // The ignore rule is the final mutation. Appending avoids replacing concurrent
    // human edits, and there is no later initialization step that can fail.
    await ensureIgnored(path.join(resolved, ".gitignore"), memoryIgnoreRule(resolved, config), created, createdFiles);
    await rm(memoryBackup.root, { recursive: true, force: true }).catch(() => undefined);
      return { root: resolved, created, memoryRoot };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (memoryBackup) {
        try { await restoreInitMemoryState(memoryRoot, memoryBackup); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      for (const file of createdFiles.reverse()) {
        try { await removeIfUnchanged(file); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (memoryBackup) {
        try { await pruneInitDirectories(memoryRoot); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (memoryBackup) {
        await rm(memoryBackup.root, { recursive: true, force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], "Initialization failed and rollback was incomplete");
      }
      throw error;
    }
  });
}

export function defaultRoadmapMarkdown(projectName: string): string {
  const prefix = projectName.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase() || "PROJECT";
  return `# ${projectName} roadmap

## A — Foundation

- [ ] **${prefix}-A1** Define the first accepted milestone and its validation evidence.
`;
}

export function customPageStarter(title: string, starter?: string): string {
  const markdown = starter?.trim() ? starter : `# ${title}`;
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

interface CreatedInitFile {
  path: string;
  content: string;
}

async function writeMissing(
  file: string,
  content: string,
  created: string[],
  createdFiles: CreatedInitFile[],
  label: string,
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    created.push(label);
    createdFiles.push({ path: file, content });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function ensureIgnored(
  file: string,
  rule: string,
  created: string[],
  createdFiles: CreatedInitFile[],
): Promise<void> {
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const content = `${rule}\n`;
    if (await writeMissing(file, content, created, createdFiles, ".gitignore")) return;
    current = await readFile(file, "utf8");
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return;
  await appendFile(file, `${current.length && !current.endsWith("\n") ? "\n" : ""}${rule}\n`, "utf8");
  created.push(".gitignore");
}

const INIT_MEMORY_STATE_PATHS = [
  "working", "refresh", "index.md", "search", "cache/roadmap", "README.md", "direct/README.md",
] as const;

interface InitMemoryBackup {
  root: string;
  present: string[];
}

async function backupInitMemoryState(memoryRoot: string): Promise<InitMemoryBackup> {
  const backupRoot = await mkdtemp(path.join(os.tmpdir(), "orchbun-init-backup-"));
  const present: string[] = [];
  try {
    for (const relative of INIT_MEMORY_STATE_PATHS) {
      const source = path.join(memoryRoot, relative);
      try {
        const target = path.join(backupRoot, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
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

async function restoreInitMemoryState(memoryRoot: string, backup: InitMemoryBackup): Promise<void> {
  const present = new Set(backup.present);
  for (const relative of INIT_MEMORY_STATE_PATHS) {
    const target = path.join(memoryRoot, relative);
    await rm(target, { recursive: true, force: true });
    if (present.has(relative)) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(backup.root, relative), target, { recursive: true });
    }
  }
}

async function removeIfUnchanged(file: CreatedInitFile): Promise<void> {
  try {
    if (await readFile(file.path, "utf8") === file.content) await rm(file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function pruneInitDirectories(memoryRoot: string): Promise<void> {
  const directories = [
    "manual/pages", "archive/direct", "archive/runs", "archive/sweeps", "archive", "milestones",
    "runs", "working", "manual", "locks", "direct", "sleep", "search", "cache/roadmap", "cache", "refresh", "",
  ];
  for (const relative of directories) {
    try { await rmdir(path.join(memoryRoot, relative)); }
    catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

function memoryIgnoreRule(root: string, config: OrchbunConfig): string {
  const absolute = path.resolve(root, config.memoryDir);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return "memory/";
  if (relative === "memory" || relative.startsWith("memory/")) return "memory/";
  return `${relative.replace(/\/+$/, "")}/`;
}

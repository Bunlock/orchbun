import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE, DEFAULT_CONFIG, pathExists } from "./config.js";
import { RunJournal } from "./journal.js";
import { rebuildMemory } from "./memory.js";

export interface InitReceipt {
  root: string;
  created: string[];
  memoryRoot: string;
}

export async function initializeWorkspace(root: string): Promise<InitReceipt> {
  const resolved = path.resolve(root);
  if (!(await pathExists(resolved))) throw new Error(`Project root does not exist: ${resolved}`);
  const created: string[] = [];
  await writeMissing(path.join(resolved, CONFIG_FILE), YAML.stringify(DEFAULT_CONFIG), created, CONFIG_FILE);
  await ensureIgnored(path.join(resolved, ".gitignore"), "memory/", created);
  const projectName = path.basename(resolved);
  const prefix = projectName.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase() || "PROJECT";
  await writeMissing(path.join(resolved, "ROADMAP.md"), `# ${projectName} roadmap

## A — Foundation

- [ ] **${prefix}-A1** Define the first accepted milestone and its validation evidence.
`, created, "ROADMAP.md");
  await writeMissing(path.join(resolved, "AGENTS.md"), `# Agent workflow

- Read the generated working memory under \`memory/agents/working/\` before project work.
- Record durable direct-agent outcomes under \`memory/agents/direct/YYYY/MM/\`.
- Keep \`memory/\` local and ignored by Git; keep \`ROADMAP.md\` and this file versioned.
- Do not edit generated working files directly from the filesystem. Use OrchBun memory web for persistent manual overrides.
- Run \`orchbun memory rebuild\` and \`orchbun memory verify\` after recording memory.
- Mark only completed, verified roadmap steps as done. Approve a milestone manifest only after every step passes.
`, created, "AGENTS.md");
  const memoryRoot = path.join(resolved, DEFAULT_CONFIG.memoryDir);
  const journal = new RunJournal(memoryRoot);
  await journal.initialize();
  await rebuildMemory(journal, resolved);
  return { root: resolved, created, memoryRoot };
}

async function writeMissing(file: string, content: string, created: string[], label: string): Promise<void> {
  if (await pathExists(file)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  created.push(label);
}

async function ensureIgnored(file: string, rule: string, created: string[]): Promise<void> {
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return;
  await writeFile(file, `${current.trimEnd()}${current.trim() ? "\n" : ""}${rule}\n`, "utf8");
  created.push(".gitignore");
}

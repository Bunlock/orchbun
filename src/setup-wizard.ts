import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  BUILTIN_MEMORY_PAGES,
  DEFAULT_CONFIG,
  pathExists,
  setupSpecFromConfig,
  validateRoadmapConfig,
  validateSetupSpec,
  type ExternalRoadmapConfig,
  type RoadmapConfig,
  type SetupSpec,
} from "./config.js";

export interface SetupWizardPrompt {
  ask(message: string): Promise<string>;
  write(message: string): void;
}

export interface SetupWizardOptions {
  current?: SetupSpec;
  root: string;
  validateExternalRoadmap?: (root: string, roadmap: ExternalRoadmapConfig) => Promise<unknown>;
  allowCreateInternalRoadmap?: boolean;
  input?: Readable;
  output?: Writable;
}

export interface SetupWizardSelection {
  setup: SetupSpec;
  createInternalRoadmap: boolean;
}

/** Runs the terminal setup flow. A null result means the user cancelled at the review step. */
export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardSelection | null> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const readline = createInterface({ input, output });
  try {
    return await collectSetupSelection({
      ask: (message) => readline.question(message),
      write: (message) => { output.write(message); },
    }, options);
  } finally {
    readline.close();
  }
}

/** Prompt-independent wizard core, useful for CLI adapters and deterministic tests. */
export async function collectSetupSpec(
  prompt: SetupWizardPrompt,
  options: Omit<SetupWizardOptions, "input" | "output">,
): Promise<SetupSpec | null> {
  return (await collectSetupSelection(prompt, options))?.setup ?? null;
}

/** Full wizard result including the reviewed, transient file-creation choice. */
export async function collectSetupSelection(
  prompt: SetupWizardPrompt,
  options: Omit<SetupWizardOptions, "input" | "output">,
): Promise<SetupWizardSelection | null> {
  const current = validateSetupSpec(options.current ?? setupSpecFromConfig(DEFAULT_CONFIG));
  let roadmap: RoadmapConfig;
  let createInternalRoadmap = false;
  while (true) {
    roadmap = await collectRoadmap(prompt, current.roadmap, options.root, options.validateExternalRoadmap);
    if (roadmap.provider !== "internal" || !options.allowCreateInternalRoadmap
      || await pathExists(path.resolve(options.root, roadmap.path))) break;
    if (await confirm(prompt, `Roadmap ${roadmap.path} does not exist. Create it?`, true)) {
      createInternalRoadmap = true;
      break;
    }
    prompt.write("Choose an existing internal roadmap or another provider.\n");
  }
  const selectedBuiltins = new Set<SetupSpec["memoryPages"]["enabled"][number]>();
  for (const page of BUILTIN_MEMORY_PAGES) {
    const selected = await confirm(prompt, `Enable ${page.title}?`, current.memoryPages.enabled.includes(page.id));
    if (selected) selectedBuiltins.add(page.id);
  }
  // A checklist has no ordering gesture. Retain the configured order for pages
  // that stay selected, then append newly enabled pages in checklist order.
  const enabled: SetupSpec["memoryPages"]["enabled"] = [
    ...current.memoryPages.enabled.filter((id) => selectedBuiltins.has(id)),
    ...BUILTIN_MEMORY_PAGES.map(({ id }) => id)
      .filter((id) => selectedBuiltins.has(id) && !current.memoryPages.enabled.includes(id)),
  ];

  const custom: SetupSpec["memoryPages"]["custom"] = [];
  for (const page of current.memoryPages.custom) {
    if (!await confirm(prompt, `Keep custom process ${page.title} (${page.id})?`, true)) continue;
    const title = await text(prompt, `Title for ${page.id}`, page.title);
    const includeInContext = await confirm(prompt, `Include ${title} in agent context?`, page.includeInContext);
    custom.push({ ...page, title, includeInContext });
  }
  while (await confirm(prompt, "Add another custom process?", false)) {
    const id = await text(prompt, "Process id (lowercase slug)");
    const title = await text(prompt, "Process title");
    const includeInContext = await confirm(prompt, `Include ${title} in agent context?`, false);
    const starter = await optionalText(prompt, "Optional one-line starter Markdown");
    custom.push({ id, title, includeInContext, ...(starter ? { starter } : {}) });
    try {
      validateSetupSpec({ memoryPages: { enabled, custom }, roadmap });
    } catch (error) {
      custom.pop();
      prompt.write(`Invalid custom process: ${message(error)}\n`);
    }
  }

  const candidate = validateSetupSpec({ memoryPages: { enabled, custom }, roadmap });
  prompt.write(`\n${formatSetupSummary(candidate)}${createInternalRoadmap ? `\n- Roadmap file: create ${roadmap.provider === "internal" ? roadmap.path : ""}` : ""}\n`);
  const changes = describeSetupChanges(current, candidate);
  if (changes.length) prompt.write(`\nChanges:\n${changes.map((change) => `- ${change}`).join("\n")}\n`);
  else prompt.write("\nNo setup changes.\n");
  return await confirm(prompt, "Apply these choices?", true) ? { setup: candidate, createInternalRoadmap } : null;
}

export function describeSetupChanges(before: SetupSpec, after: SetupSpec): string[] {
  const previous = validateSetupSpec(before);
  const next = validateSetupSpec(after);
  const changes: string[] = [];
  for (const page of BUILTIN_MEMORY_PAGES) {
    const wasEnabled = previous.memoryPages.enabled.includes(page.id);
    const isEnabled = next.memoryPages.enabled.includes(page.id);
    if (wasEnabled && !isEnabled) changes.push(`${page.title} disabled; existing annotation retained.`);
    if (!wasEnabled && isEnabled) changes.push(`${page.title} enabled; prior annotation will be restored when present.`);
  }
  const oldCustom = new Map(previous.memoryPages.custom.map((page) => [page.id, page]));
  const newCustom = new Map(next.memoryPages.custom.map((page) => [page.id, page]));
  for (const page of previous.memoryPages.custom) {
    if (!newCustom.has(page.id)) changes.push(`${page.title} removed; its local page remains dormant.`);
  }
  for (const page of next.memoryPages.custom) {
    const old = oldCustom.get(page.id);
    if (!old) {
      changes.push(`${page.title} added; ${page.includeInContext ? "included in" : "excluded from"} agent context.`);
      continue;
    }
    if (old.title !== page.title) changes.push(`${old.title} renamed to ${page.title}; id ${page.id} is unchanged.`);
    if (old.includeInContext !== page.includeInContext) {
      changes.push(`${page.title} ${page.includeInContext ? "included in" : "excluded from"} agent context.`);
    }
  }
  if (!sameRoadmap(previous.roadmap, next.roadmap)) {
    changes.push(`Roadmap changed from ${roadmapLabel(previous.roadmap)} to ${roadmapLabel(next.roadmap)}.`);
  }
  return changes;
}

export function formatSetupSummary(setup: SetupSpec): string {
  const value = validateSetupSpec(setup);
  const builtins = value.memoryPages.enabled.map((id) =>
    BUILTIN_MEMORY_PAGES.find((page) => page.id === id)!.title);
  const processes = value.memoryPages.custom.map((page) => `${page.title} (${page.id}, ${page.includeInContext ? "in context" : "local only"})`);
  return [
    "Setup summary",
    `- Roadmap: ${roadmapLabel(value.roadmap)}`,
    `- Built-in memory pages: ${builtins.length ? builtins.join(", ") : "none"}`,
    `- Custom processes: ${processes.length ? processes.join(", ") : "none"}`,
  ].join("\n");
}

export function parseRoadmapCommand(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new Error("Provider command must be a JSON string array", { cause: error }); }
  const roadmap = validateRoadmapConfig({ provider: "external", name: "Provider", command: parsed });
  if (roadmap.provider !== "external") throw new Error("Provider command is invalid");
  return roadmap.command;
}

async function collectRoadmap(
  prompt: SetupWizardPrompt,
  current: RoadmapConfig,
  root: string,
  validateExternalRoadmap?: SetupWizardOptions["validateExternalRoadmap"],
): Promise<RoadmapConfig> {
  let preferred = current.provider;
  let external = current.provider === "external" ? current : undefined;
  while (true) {
    const provider = await choice(prompt, "Roadmap provider", ["internal", "external"] as const, preferred);
    if (provider === "internal") {
      const defaultPath = current.provider === "internal" ? current.path : "ROADMAP.md";
      return validateRoadmapConfig({ provider: "internal", path: await text(prompt, "Roadmap Markdown path", defaultPath) });
    }
    const name = await text(prompt, "External provider name", external?.name ?? "Jira");
    const command = parseRoadmapCommand(await text(
      prompt,
      "Provider command as a JSON array",
      JSON.stringify(external?.command ?? ["node", "tools/orchbun-roadmap-provider.mjs"]),
    ));
    const roadmap = validateRoadmapConfig({ provider: "external", name, command });
    if (roadmap.provider !== "external") throw new Error("External roadmap selection is invalid");
    external = roadmap;
    try {
      if (!validateExternalRoadmap) throw new Error("No external roadmap validator is configured");
      prompt.write(`Validating ${roadmap.name} with a read-only list request...\n`);
      await validateExternalRoadmap(root, roadmap);
      prompt.write(`${roadmap.name} validation succeeded.\n`);
      return roadmap;
    } catch (error) {
      prompt.write(`External roadmap validation failed: ${message(error)}\n`);
      if (await confirm(prompt, "Use the internal roadmap instead?", true)) preferred = "internal";
      else preferred = "external";
    }
  }
}

async function confirm(prompt: SetupWizardPrompt, label: string, defaultValue: boolean): Promise<boolean> {
  while (true) {
    const answer = (await prompt.ask(`${label} ${defaultValue ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    prompt.write("Enter yes or no.\n");
  }
}

async function text(prompt: SetupWizardPrompt, label: string, defaultValue?: string): Promise<string> {
  while (true) {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = (await prompt.ask(`${label}${suffix}: `)).trim();
    const value = answer || defaultValue || "";
    if (value) return value;
    prompt.write("A value is required.\n");
  }
}

async function optionalText(prompt: SetupWizardPrompt, label: string): Promise<string> {
  return (await prompt.ask(`${label} [none]: `)).trim();
}

async function choice<const T extends readonly string[]>(
  prompt: SetupWizardPrompt,
  label: string,
  choices: T,
  defaultValue: T[number],
): Promise<T[number]> {
  while (true) {
    const answer = (await prompt.ask(`${label} (${choices.join("/")}) [${defaultValue}]: `)).trim().toLowerCase();
    const value = answer || defaultValue;
    if (choices.includes(value)) return value as T[number];
    prompt.write(`Choose ${choices.join(" or ")}.\n`);
  }
}

function sameRoadmap(left: RoadmapConfig, right: RoadmapConfig): boolean {
  return left.provider === right.provider && (left.provider === "internal"
    ? left.path === (right.provider === "internal" ? right.path : "")
    : right.provider === "external" && left.name === right.name && JSON.stringify(left.command) === JSON.stringify(right.command));
}

function roadmapLabel(roadmap: RoadmapConfig): string {
  return roadmap.provider === "internal" ? roadmap.path : roadmap.name;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

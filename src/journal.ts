import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AdapterResponse } from "./adapters/base.js";
import { DIRECT_MEMORY_PROTOCOL } from "./direct-memory.js";
import type { AgentResult, ContextPacket, RunMetadata } from "./types.js";

const PROTOCOL = `# Agent memory protocol

This directory is local, ignored by Git, and shared by managed agents.

- Every managed invocation creates an immutable directory under \`runs/\`.
- \`prompt.md\` is the exact source prompt.
- \`prompt.expanded.md\` is the bounded prompt actually sent to the agent.
- Native provider output is retained without being loaded into future prompts.
- \`result.json\` and \`summary.md\` are the normalized compact result.
- Files under \`working/\` are generated projections. Do not edit them manually.
- Compact direct-agent notes under \`direct/\` are validated and merged into working memory.
- \`memory sleep\` reconciles active tasks with the first incomplete roadmap milestone.
- \`/compact\` accepts only a reviewed milestone manifest whose decision is \`accepted\`.
- Compaction archives the previous working context and publishes a durable milestone baseline.
- \`design/\` and old run history are never loaded automatically.
`;

export class RunJournal {
  constructor(readonly memoryRoot: string) {}

  async initialize(): Promise<void> {
    const directories = ["runs", "working", "locks", "direct", "milestones", "archive", "sleep"];
    await Promise.all(directories.map((directory) => mkdir(path.join(this.memoryRoot, directory), { recursive: true })));
    await this.writeIfMissing(path.join(this.memoryRoot, "README.md"), PROTOCOL);
    await this.writeIfMissing(path.join(this.memoryRoot, "direct", "README.md"), DIRECT_MEMORY_PROTOCOL);
    await this.writeIfMissing(path.join(this.memoryRoot, "index.md"), "# Agent runs\n\nNo runs recorded.\n");
    await this.writeIfMissing(path.join(this.memoryRoot, "working", "project-state.md"), "# Project state\n\nNo managed runs recorded.\n");
    await this.writeIfMissing(path.join(this.memoryRoot, "working", "active-tasks.md"), "# Active tasks\n\nNo active tasks recorded.\n");
    await this.writeIfMissing(path.join(this.memoryRoot, "working", "decisions.md"), "# Decisions\n\nNo decisions recorded.\n");
    await this.writeIfMissing(path.join(this.memoryRoot, "working", "contracts.md"), "# APIs and contracts\n\nNo APIs or contracts recorded.\n");
    await this.writeIfMissing(path.join(this.memoryRoot, "working", "risks.md"), "# Risks and blockers\n\nNo risks recorded.\n");
  }

  runDirectory(runId: string): string {
    const year = runId.slice(0, 4);
    const month = runId.slice(4, 6);
    return path.join(this.memoryRoot, "runs", year, month, runId);
  }

  async begin(metadata: RunMetadata, packet: ContextPacket): Promise<string> {
    const directory = this.runDirectory(metadata.runId);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    await Promise.all([
      this.writeMetadata(directory, metadata),
      writeFile(path.join(directory, "prompt.md"), packet.sourcePrompt),
      writeFile(path.join(directory, "prompt.expanded.md"), packet.expandedPrompt),
      writeFile(path.join(directory, "context.json"), `${JSON.stringify({
        included_files: packet.includedFiles,
        omitted_files: packet.omittedFiles,
        input_characters: packet.inputCharacters,
        estimated_input_tokens: packet.estimatedInputTokens,
      }, null, 2)}\n`),
    ]);
    return directory;
  }

  async complete(
    directory: string,
    metadata: RunMetadata,
    response: AdapterResponse,
  ): Promise<void> {
    await Promise.all([
      writeFile(path.join(directory, response.nativeFileName), response.nativeOutput),
      ...(response.diagnostics ? [writeFile(path.join(directory, "diagnostics.txt"), response.diagnostics)] : []),
      writeFile(path.join(directory, "result.json"), `${JSON.stringify(response.result, null, 2)}\n`),
      writeFile(path.join(directory, "summary.md"), renderSummary(metadata, response.result)),
      this.writeMetadata(directory, metadata),
    ]);
  }

  async fail(directory: string, metadata: RunMetadata, error: unknown): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    const native = error as { nativeOutput?: unknown; nativeFileName?: unknown };
    await Promise.all([
      writeFile(path.join(directory, "error.txt"), `${message.trim()}\n`),
      ...(typeof native.nativeOutput === "string" && typeof native.nativeFileName === "string"
        ? [writeFile(path.join(directory, native.nativeFileName), native.nativeOutput)]
        : []),
      this.writeMetadata(directory, metadata),
    ]);
  }

  async allRunDirectories(): Promise<string[]> {
    const root = path.join(this.memoryRoot, "runs");
    const output: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.isFile() && entry.name === "metadata.yaml")) {
        output.push(directory);
        return;
      }
      for (const entry of entries) if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    };
    await visit(root);
    return output.sort();
  }

  async readMetadata(directory: string): Promise<RunMetadata> {
    return metadataFromYaml(YAML.parse(await readFile(path.join(directory, "metadata.yaml"), "utf8")) as Record<string, unknown>);
  }

  async readResult(directory: string): Promise<AgentResult> {
    return JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")) as AgentResult;
  }

  async withProjectionLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.memoryRoot, "locks", "working-memory.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!handle) throw new Error("Timed out waiting for the working-memory lock");
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  private async writeMetadata(directory: string, metadata: RunMetadata): Promise<void> {
    await atomicWrite(path.join(directory, "metadata.yaml"), YAML.stringify(toSnakeCaseMetadata(metadata)));
  }

  private async writeIfMissing(target: string, contents: string): Promise<void> {
    try {
      await writeFile(target, contents, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function toSnakeCaseMetadata(metadata: RunMetadata): Record<string, unknown> {
  return {
    run_id: metadata.runId,
    parent_run_id: metadata.parentRunId,
    task_id: metadata.taskId,
    depth: metadata.depth,
    agent: metadata.agent,
    mode: metadata.mode,
    status: metadata.status,
    ...(metadata.model ? { model: metadata.model } : {}),
    started_at: metadata.startedAt,
    finished_at: metadata.finishedAt,
    prompt_hash: metadata.promptHash,
    input_characters: metadata.inputCharacters,
    estimated_input_tokens: metadata.estimatedInputTokens,
    included_files: metadata.includedFiles,
    omitted_files: metadata.omittedFiles,
    ...(metadata.gitBefore ? { git_before: metadata.gitBefore } : {}),
    ...(metadata.gitAfter ? { git_after: metadata.gitAfter } : {}),
    ...(metadata.usage ? { usage: {
      input_tokens: metadata.usage.inputTokens,
      output_tokens: metadata.usage.outputTokens,
      cached_input_tokens: metadata.usage.cachedInputTokens,
      cost_usd: metadata.usage.costUsd,
    } } : {}),
  };
}

export function metadataFromYaml(value: Record<string, unknown>): RunMetadata {
  const usage = value.usage as Record<string, number | undefined> | undefined;
  return {
    runId: String(value.run_id),
    parentRunId: value.parent_run_id ? String(value.parent_run_id) : null,
    taskId: value.task_id ? String(value.task_id) : null,
    depth: Number(value.depth ?? 0),
    agent: value.agent as RunMetadata["agent"],
    mode: value.mode as RunMetadata["mode"],
    status: value.status as RunMetadata["status"],
    ...(value.model ? { model: String(value.model) } : {}),
    startedAt: String(value.started_at),
    finishedAt: value.finished_at ? String(value.finished_at) : null,
    promptHash: String(value.prompt_hash),
    inputCharacters: Number(value.input_characters ?? 0),
    estimatedInputTokens: Number(value.estimated_input_tokens ?? 0),
    includedFiles: (value.included_files as string[] | undefined) ?? [],
    omittedFiles: (value.omitted_files as string[] | undefined) ?? [],
    ...(value.git_before ? { gitBefore: String(value.git_before) } : {}),
    ...(value.git_after ? { gitAfter: String(value.git_after) } : {}),
    ...(usage ? { usage: {
      ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
      ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
      ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
      ...(usage.cost_usd !== undefined ? { costUsd: usage.cost_usd } : {}),
    } } : {}),
  };
}

function renderSummary(metadata: RunMetadata, result: AgentResult): string {
  const list = (items: string[]): string => items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
  return `# ${result.prompt_intent}\n\n` +
    `- **Run:** ${metadata.runId}\n` +
    `- **Parent:** ${metadata.parentRunId ?? "None"}\n` +
    `- **Agent:** ${metadata.agent}\n` +
    `- **Mode:** ${metadata.mode}\n` +
    `- **Outcome:** ${result.outcome}\n\n` +
    `## Result\n\n${result.summary}\n\n` +
    `## Files changed\n\n${result.files_changed.length ? result.files_changed.map((item) => `- \`${item.path}\` — ${item.change}`).join("\n") : "- None"}\n\n` +
    `## Decisions\n\n${list(result.decisions)}\n\n` +
    `## Risks and blockers\n\n${list([...result.risks, ...result.blockers])}\n\n` +
    `## Next\n\n${list(result.next_actions)}\n\n` +
    `## Verification\n\n${result.verification.length ? result.verification.map((item) => `- **${item.result}:** ${item.check} — ${item.evidence}`).join("\n") : "- None"}\n`;
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, target);
}

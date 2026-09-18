import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRoadmapStore,
  RoadmapConflictError,
  RoadmapStoreError,
} from "../src/roadmap-store.js";

interface ProviderTask {
  id: string;
  title: string;
  completed: boolean;
  milestone_id: string;
  milestone_title: string;
}

interface ProviderState {
  revision: string;
  tasks: ProviderTask[];
  nextRevision?: string;
  mode?: "unavailable" | "unauthorized" | "malformed";
}

const initialTask: ProviderTask = {
  id: "APP-1",
  title: "Ship the provider contract.",
  completed: false,
  milestone_id: "A",
  milestone_title: "Foundation",
};

test("internal roadmap store uses content revisions and rejects stale completion writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-store-internal-"));
  const roadmapPath = path.join(root, "plans", "PRODUCT.md");
  await mkdir(path.dirname(roadmapPath), { recursive: true });
  await writeFile(roadmapPath, "# Roadmap\n\n## A — Foundation\n\n- [ ] **APP-1** Ship it.\n");
  const store = createRoadmapStore({
    root,
    memoryRoot: path.join(root, "memory", "agents"),
    config: { provider: "internal", path: "plans/PRODUCT.md" },
  });

  const first = await store.list();
  assert.equal(first.source.provider, "internal");
  assert.equal(first.source.artifact, "plans/PRODUCT.md");
  assert.equal(first.freshness, "fresh");
  assert.equal(first.completion, null);
  assert.deepEqual(first.tasks.map((task) => task.id), ["APP-1"]);

  await writeFile(roadmapPath, `${await readFile(roadmapPath, "utf8")}\nConcurrent note.\n`);
  await assert.rejects(
    store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: first.revision }),
    (error: unknown) => {
      assert.ok(error instanceof RoadmapConflictError);
      assert.equal(error.expectedRevision, first.revision);
      assert.notEqual(error.actualRevision, first.revision);
      return true;
    },
  );
  assert.match(await readFile(roadmapPath, "utf8"), /- \[ \] \*\*APP-1\*\*/);

  const current = await store.list();
  const updated = await store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: current.revision });
  assert.equal(updated.completion, "updated");
  assert.equal(updated.tasks[0]?.completed, true);
  const unchanged = await store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: updated.revision });
  assert.equal(unchanged.completion, "unchanged");
});

test("external roadmap store exchanges v1 JSON, updates by revision, and serves stale validated cache", async () => {
  const fixture = await externalFixture({ revision: "r1", tasks: [{ ...initialTask }], nextRevision: "r2" });
  const store = fixture.store();

  const listed = await store.list();
  assert.equal(listed.source.provider, "external");
  assert.equal(listed.source.label, "Fixture Jira");
  assert.equal(listed.revision, "r1");
  assert.equal(listed.activeMilestone, "A");
  assert.deepEqual(JSON.parse(await readFile(fixture.requestFile, "utf8")), {
    schema_version: "1.0",
    operation: "list",
  });

  const changed = await store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: listed.revision });
  assert.equal(changed.revision, "r2");
  assert.equal(changed.completion, "updated");
  assert.equal(changed.tasks[0]?.completed, true);
  assert.deepEqual(JSON.parse(await readFile(fixture.requestFile, "utf8")), {
    schema_version: "1.0",
    operation: "set_completion",
    task_id: "APP-1",
    completed: true,
    expected_revision: "r1",
  });

  const unchanged = await store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: "r2" });
  assert.equal(unchanged.revision, "r2");
  assert.equal(unchanged.completion, "unchanged");

  const state = await fixture.readState();
  state.mode = "unavailable";
  await fixture.writeState(state);
  await assert.rejects(store.list(), (error: unknown) => isStoreError(error, "unavailable"));
  const stale = await store.list({ allowStale: true });
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.revision, "r2");
  assert.equal(stale.tasks[0]?.completed, true);
});

test("external provider conflicts are structured and never use stale cache for writes", async () => {
  const fixture = await externalFixture({ revision: "r7", tasks: [{ ...initialTask }] });
  const store = fixture.store();
  await store.list();

  await assert.rejects(
    store.setCompletion({ taskId: "APP-1", completed: true, expectedRevision: "older" }),
    (error: unknown) => {
      assert.ok(error instanceof RoadmapConflictError);
      assert.equal(error.code, "conflict");
      assert.equal(error.expectedRevision, "older");
      assert.equal(error.actualRevision, "r7");
      return true;
    },
  );
  await assert.rejects(
    store.setCompletion({ taskId: "MISSING", completed: true, expectedRevision: "r7" }),
    (error: unknown) => isStoreError(error, "not_found"),
  );
});

test("stale fallback is limited to unavailable providers", async () => {
  const fixture = await externalFixture({ revision: "r1", tasks: [{ ...initialTask }] });
  const store = fixture.store();
  await store.list();
  const state = await fixture.readState();
  state.mode = "unauthorized";
  await fixture.writeState(state);
  await assert.rejects(
    store.list({ allowStale: true }),
    (error: unknown) => isStoreError(error, "unauthorized"),
  );
  state.mode = "malformed";
  await fixture.writeState(state);
  await assert.rejects(
    store.list({ allowStale: true }),
    (error: unknown) => isStoreError(error, "invalid_request"),
  );
});

test("external provider cannot reuse one revision for different content", async () => {
  const fixture = await externalFixture({ revision: "stable", tasks: [{ ...initialTask }] });
  const firstStore = fixture.store();
  await firstStore.list();
  const changed = await fixture.readState();
  changed.tasks[0]!.title = "Different content under the same revision.";
  await fixture.writeState(changed);

  await assert.rejects(firstStore.list(), (error: unknown) => isStoreError(error, "invalid_request"));
  const restartedStore = fixture.store();
  await assert.rejects(restartedStore.list(), (error: unknown) => isStoreError(error, "invalid_request"));
});

test("external provider validates unique tasks and consistent milestone titles", async () => {
  const duplicate = await externalFixture({
    revision: "invalid",
    tasks: [
      { ...initialTask },
      { ...initialTask, title: "Duplicate.", milestone_title: "A different title" },
    ],
  });
  await assert.rejects(duplicate.store().list(), (error: unknown) => isStoreError(error, "invalid_request"));

  const inconsistent = await externalFixture({
    revision: "invalid-milestone",
    tasks: [
      { ...initialTask },
      { ...initialTask, id: "APP-2", milestone_title: "A different title" },
    ],
  });
  await assert.rejects(inconsistent.store().list(), (error: unknown) => isStoreError(error, "invalid_request"));
});

test("external provider bounds execution time and output", async (context) => {
  await context.test("timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-store-timeout-"));
    const script = path.join(root, "hang.mjs");
    await writeFile(script, "process.stdin.resume(); setTimeout(() => {}, 10_000);\n");
    const store = createRoadmapStore({
      root,
      memoryRoot: path.join(root, "memory", "agents"),
      config: { provider: "external", name: "Slow", command: [process.execPath, script] },
      timeoutMs: 50,
    });
    await assert.rejects(store.list(), (error: unknown) => isStoreError(error, "unavailable"));
  });

  await context.test("output cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-store-output-"));
    const script = path.join(root, "large.mjs");
    await writeFile(script, "process.stdin.resume(); process.stdout.write('x'.repeat(2048));\n");
    const store = createRoadmapStore({
      root,
      memoryRoot: path.join(root, "memory", "agents"),
      config: { provider: "external", name: "Large", command: [process.execPath, script] },
      maxOutputBytes: 256,
    });
    await assert.rejects(store.list(), (error: unknown) => isStoreError(error, "invalid_request"));
  });
});

test("configuration preview can validate an external provider without publishing cache", async () => {
  const fixture = await externalFixture({ revision: "preview", tasks: [{ ...initialTask }] });
  const snapshot = await fixture.store({ cacheWrites: false }).list();
  assert.equal(snapshot.revision, "preview");
  await assert.rejects(readFile(path.join(fixture.memoryRoot, "cache")), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  });
});

async function externalFixture(initial: ProviderState): Promise<{
  root: string;
  memoryRoot: string;
  requestFile: string;
  store: (options?: { cacheWrites?: boolean }) => ReturnType<typeof createRoadmapStore>;
  readState: () => Promise<ProviderState>;
  writeState: (state: ProviderState) => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchbun-roadmap-store-external-"));
  const memoryRoot = path.join(root, "memory", "agents");
  const stateFile = path.join(root, "provider-state.json");
  const requestFile = path.join(root, "provider-request.json");
  const providerFile = path.join(root, "provider.mjs");
  await writeFile(stateFile, JSON.stringify(initial));
  await writeFile(providerFile, `
import { readFileSync, writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const stateFile = process.argv[2];
const requestFile = process.argv[3];
const state = JSON.parse(readFileSync(stateFile, "utf8"));
writeFileSync(requestFile, JSON.stringify(request));
const send = (value, exitCode = 0) => {
  process.stdout.write(JSON.stringify(value));
  process.exitCode = exitCode;
};
if (state.mode === "unavailable") {
  send({ schema_version: "1.0", error: { code: "unavailable", message: "Provider is offline" } }, 2);
} else if (state.mode === "unauthorized") {
  send({ schema_version: "1.0", error: { code: "unauthorized", message: "Provider credentials are invalid" } }, 2);
} else if (state.mode === "malformed") {
  process.stdout.write("{");
  process.exitCode = 2;
} else if (request.operation === "list") {
  send({ schema_version: "1.0", revision: state.revision, tasks: state.tasks });
} else if (request.operation === "set_completion") {
  if (request.expected_revision !== state.revision) {
    send({ schema_version: "1.0", error: { code: "conflict", message: "Revision changed", actual_revision: state.revision } }, 2);
  } else {
    const task = state.tasks.find((candidate) => candidate.id === request.task_id);
    if (!task) {
      send({ schema_version: "1.0", error: { code: "not_found", message: "Task was not found" } }, 2);
    } else {
      const result = task.completed === request.completed ? "unchanged" : "updated";
      task.completed = request.completed;
      if (result === "updated") state.revision = state.nextRevision ?? state.revision + "-next";
      delete state.nextRevision;
      writeFileSync(stateFile, JSON.stringify(state));
      send({ schema_version: "1.0", revision: state.revision, result, tasks: state.tasks });
    }
  }
} else {
  send({ schema_version: "1.0", error: { code: "invalid_request", message: "Unknown operation" } }, 2);
}
`);
  const store = (options: { cacheWrites?: boolean } = {}) => createRoadmapStore({
    root,
    memoryRoot,
    config: { provider: "external", name: "Fixture Jira", command: [process.execPath, providerFile, stateFile, requestFile] },
    ...options,
  });
  return {
    root,
    memoryRoot,
    requestFile,
    store,
    readState: async () => JSON.parse(await readFile(stateFile, "utf8")) as ProviderState,
    writeState: async (state) => writeFile(stateFile, JSON.stringify(state)),
  };
}

function isStoreError(error: unknown, code: RoadmapStoreError["code"]): boolean {
  assert.ok(error instanceof RoadmapStoreError);
  assert.equal(error.code, code);
  return true;
}

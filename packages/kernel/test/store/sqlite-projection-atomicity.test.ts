// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { executionDeclaration } from "../../src/entity/execution-declaration.ts";
import {
  readAttributionEventSource,
  readAttributionEventsFromSource
} from "../../src/local/attribution-event-source.ts";
import { localProjectionSourceFileSystem } from "../../src/local/local-layout-file-system.ts";
import { readDeclaredEntitySource } from "../../src/projection/entity-declaration-projection.ts";
import { readTaskProjection, rebuildTaskProjection } from "../../src/index.ts";
import { withTempStore, withTempStoreAsync } from "./helpers.ts";

test("SQLite full rebuild atomically publishes complete declared entity generations", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const executionPath = seedAtomicProjectionTask(rootDir, 250);
    const template = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    rebuildTaskProjection({ rootDir });

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const sourceHashes = new Map<string, string>();
    sourceHashes.set("submitted", readAtomicMetaValue(projectionPath, "sourceHash"));
    writeAtomicExecutionState(executionPath, template, "accepted");
    rebuildTaskProjection({ rootDir });
    sourceHashes.set("accepted", readAtomicMetaValue(projectionPath, "sourceHash"));
    writeAtomicExecutionState(executionPath, template, "submitted");
    rebuildTaskProjection({ rootDir });

    const reader = spawn(process.execPath, ["--input-type=module", "-e", atomicProjectionReaderScript], {
      env: {
        ...process.env,
        HARNESS_PROJECTION_PATH: projectionPath,
        HARNESS_EXPECTED_EXECUTIONS: "250",
        HARNESS_EXPECTED_GENERATIONS: JSON.stringify([...sourceHashes])
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    reader.stdout.setEncoding("utf8");
    reader.stderr.setEncoding("utf8");
    reader.stdout.on("data", (chunk: string) => { stdout += chunk; });
    reader.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await waitForAtomicReader(() => stdout.includes("READY\n"));

    for (let iteration = 0; iteration < 8; iteration += 1) {
      writeAtomicExecutionState(executionPath, template, iteration % 2 === 0 ? "accepted" : "submitted");
      rebuildTaskProjection({ rootDir });
    }

    const [exitCode] = await once(reader, "close") as [number];
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      readonly reads: number;
      readonly failures: number;
      readonly partial: number;
    };
    assert.equal(result.reads > 0, true);
    assert.deepEqual(result, { reads: result.reads, failures: 0, partial: 0 });
  });
});

test("task cache rejects a concurrent rewrite between signature passes", () => {
  withTempStore((rootDir) => {
    const taskPath = writeCacheTask(rootDir, "Task A");
    rebuildTaskProjection({ rootDir });
    const originalStatSignature = localProjectionSourceFileSystem.statSignature;
    let mutated = false;
    localProjectionSourceFileSystem.statSignature = (inputPath) => {
      const signature = originalStatSignature(inputPath);
      if (!mutated && inputPath === taskPath) {
        mutated = true;
        writeCacheTask(rootDir, "Task B");
      }
      return signature;
    };
    let result: ReturnType<typeof readTaskProjection>;
    try {
      result = readTaskProjection({ rootDir });
    } finally {
      localProjectionSourceFileSystem.statSignature = originalStatSignature;
    }

    assert.equal(mutated, true);
    assert.equal(result.rows[0]?.title, "Task B");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

test("task cache rejects an atomic rewrite after a stable body read", () => {
  withTempStore((rootDir) => {
    const taskPath = writeCacheTask(rootDir, "Task A");
    const originalReadStableText = localProjectionSourceFileSystem.readStableText;
    let mutated = false;
    localProjectionSourceFileSystem.readStableText = (inputPath) => {
      const stable = originalReadStableText(inputPath);
      if (!mutated && inputPath === taskPath) {
        mutated = true;
        writeCacheTask(rootDir, "Task B");
      }
      return stable;
    };
    let result: ReturnType<typeof rebuildTaskProjection>;
    try {
      result = rebuildTaskProjection({ rootDir });
    } finally {
      localProjectionSourceFileSystem.readStableText = originalReadStableText;
    }

    assert.equal(mutated, true);
    assert.equal(result.rows[0]?.title, "Task B");
    assert.equal(readTaskProjection({ rootDir }).rows[0]?.title, "Task B");
  });
});

test("declared source cache rejects a concurrent rewrite between signature passes", () => {
  withTempStore((rootDir) => {
    const executionPath = writeCacheExecution(rootDir, "submitted");
    readDeclaredEntitySource(rootDir, executionDeclaration);
    assert.equal(readDeclaredEntitySource(rootDir, executionDeclaration).stats.cacheHit, true);
    const originalStatSignature = localProjectionSourceFileSystem.statSignature;
    let mutated = false;
    localProjectionSourceFileSystem.statSignature = (inputPath) => {
      const signature = originalStatSignature(inputPath);
      if (!mutated && inputPath === executionPath) {
        mutated = true;
        writeCacheExecution(rootDir, "accepted");
      }
      return signature;
    };
    let source: ReturnType<typeof readDeclaredEntitySource>;
    try {
      source = readDeclaredEntitySource(rootDir, executionDeclaration);
    } finally {
      localProjectionSourceFileSystem.statSignature = originalStatSignature;
    }

    assert.equal(mutated, true);
    assert.equal(source.stats.cacheHit, false);
    assert.match(source.inputs[0]?.body ?? "", /"state": "accepted"/u);
  });
});

test("attribution cache rejects a concurrent rewrite between signature passes", () => {
  withTempStore((rootDir) => {
    const eventPath = writeCacheAttribution(rootDir, "person_alpha");
    readAttributionEventSource(rootDir);
    const originalStatSignature = localProjectionSourceFileSystem.statSignature;
    let mutated = false;
    localProjectionSourceFileSystem.statSignature = (inputPath) => {
      const signature = originalStatSignature(inputPath);
      if (!mutated && inputPath === eventPath) {
        mutated = true;
        writeCacheAttribution(rootDir, "person_bravo");
      }
      return signature;
    };
    let source: ReturnType<typeof readAttributionEventSource>;
    try {
      source = readAttributionEventSource(rootDir);
    } finally {
      localProjectionSourceFileSystem.statSignature = originalStatSignature;
    }

    assert.equal(mutated, true);
    assert.equal(
      readAttributionEventsFromSource(source)[0]?.actor.principal.personId,
      "person_bravo"
    );
  });
});

function writeCacheTask(rootDir: string, title: "Task A" | "Task B"): string {
  const taskId = "task_01J00000000000000000000001";
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const taskPath = path.join(taskRoot, "INDEX.md");
  writeFileSync(taskPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  return taskPath;
}

function writeCacheExecution(rootDir: string, state: "submitted" | "accepted"): string {
  const taskId = "task_01J00000000000000000000001";
  const executionId = "exe_01J00000000000000000000001";
  const executionPath = path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`);
  mkdirSync(path.dirname(executionPath), { recursive: true });
  writeFileSync(executionPath, `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state,
    primary_actor: {
      principal: { personId: "person_cache" },
      executor: { kind: "agent", id: "agent_cache" },
      responsibleHuman: "person_cache"
    },
    claimed_at: "2026-07-13T00:00:00.000Z",
    submitted_at: "2026-07-13T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: null
  }, null, 2)}\n`);
  return executionPath;
}

function writeCacheAttribution(rootDir: string, personId: "person_alpha" | "person_bravo"): string {
  const eventRoot = path.join(rootDir, "harness/attribution-events");
  mkdirSync(eventRoot, { recursive: true });
  const eventPath = path.join(eventRoot, "event-cache-race.jsonl");
  writeFileSync(eventPath, `${JSON.stringify({
    schema: "attribution-event/v1",
    eventId: "event-cache-race",
    opId: "op-event-cache-race",
    journalRecordSchema: "write-journal/v2",
    entityId: "task/task-cache",
    kind: "progress_append",
    actor: {
      principal: { kind: "person", personId },
      executor: { kind: "agent", id: "agent_cache" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: `sha256:${"0".repeat(64)}`
    },
    executorSource: "client-asserted",
    at: "2026-07-13T00:00:00.000Z",
    recordedAt: "2026-07-13T00:00:01.000Z",
    payloadHash: `sha256:${"1".repeat(64)}`,
    payloadRef: {
      path: ".harness/payloads/event-cache-race.json",
      sha256: `sha256:${"1".repeat(64)}`
    }
  })}\n`);
  return eventPath;
}

function seedAtomicProjectionTask(rootDir: string, executionCount: number): string {
  const taskId = "task_01J00000000000000000000000";
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  const executionRoot = path.join(taskRoot, "executions");
  mkdirSync(executionRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Atomic projection",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: in_review",
    "  ref: ",
    "  titleSnapshot: Atomic projection",
    "  url: ",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    "# Atomic projection",
    ""
  ].join("\n"));
  const template = {
    schema: "execution/v2",
    execution_id: "exe_01J00000000000000000000000",
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person:test" },
      executor: { kind: "agent", id: "agent:test" },
      responsibleHuman: "person:test"
    },
    claimed_at: "2026-07-11T01:00:00.000Z",
    submitted_at: "2026-07-11T01:10:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: {
      completion_claim: "ready",
      deliverables: [],
      evidence_refs: [],
      verification_notes: [],
      known_gaps: [],
      residual_risks: []
    }
  };
  for (let index = 0; index < executionCount; index += 1) {
    const executionId = index === 0 ? template.execution_id : `exe_${String(index).padStart(26, "0")}`;
    writeFileSync(path.join(executionRoot, `${executionId}.md`), `${JSON.stringify({
      ...template,
      execution_id: executionId
    }, null, 2)}\n`);
  }
  return path.join(executionRoot, `${template.execution_id}.md`);
}

function writeAtomicExecutionState(
  executionPath: string,
  template: Readonly<Record<string, unknown>>,
  state: "submitted" | "accepted"
): void {
  writeFileSync(executionPath, `${JSON.stringify({ ...template, state }, null, 2)}\n`);
}

function readAtomicMetaValue(projectionPath: string, key: string): string {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    return String(db.prepare("SELECT value FROM projection_meta WHERE key = ?").get(key)?.value);
  } finally {
    db.close();
  }
}

async function waitForAtomicReader(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for projection reader");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const atomicProjectionReaderScript = `
import { DatabaseSync } from "node:sqlite";
const projectionPath = process.env.HARNESS_PROJECTION_PATH;
const expected = Number(process.env.HARNESS_EXPECTED_EXECUTIONS);
const expectedGenerations = new Map(JSON.parse(process.env.HARNESS_EXPECTED_GENERATIONS));
let reads = 0;
let failures = 0;
let partial = 0;
process.stdout.write("READY\\n");
const deadline = Date.now() + 4_000;
while (Date.now() < deadline) {
  let db;
  try {
    db = new DatabaseSync(projectionPath, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM execution_projection").get();
    const meta = db.prepare("SELECT value FROM projection_meta WHERE key = 'declaredRowsHash'").get();
    const source = db.prepare("SELECT value FROM projection_meta WHERE key = 'sourceHash'").get();
    const execution = db.prepare("SELECT state FROM execution_projection WHERE execution_id = 'exe_01J00000000000000000000000'").get();
    reads += 1;
    if (Number(row.count) !== expected || typeof meta?.value !== "string" || meta.value.length === 0 || expectedGenerations.get(execution?.state) !== source?.value) partial += 1;
  } catch {
    failures += 1;
  } finally {
    db?.close();
  }
}
process.stdout.write(JSON.stringify({ reads, failures, partial }) + "\\n");
`;

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateExecutions } from "../../packages/gui/src/renderer/execution-data.ts";
import { queryExecutionEvidencePage, queryExecutions, rebuildTaskProjection } from "../../packages/kernel/src/index.ts";
import { queryExecutionEvidencePageFromReadyProjection } from "../../packages/kernel/src/projection/sqlite-execution-evidence-reader.ts";
import { captureProjectionSourceFingerprint } from "../../packages/kernel/src/projection/projection-source-snapshot.ts";
import { readDeclaredSourceManifestRows } from "../../packages/kernel/src/projection/sqlite-declared-source-manifest.ts";
import { updateTaskProjectionIncrementally } from "../../packages/kernel/src/projection/sqlite-task-incremental-projection.ts";

const size = positiveInteger("--size", 1_000);
const outputsPerExecution = positiveInteger("--outputs", 5);
const attributionEventsPerExecution = positiveInteger("--attribution-events", 5);
const keep = process.argv.includes("--keep");
const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-perf-"));

try {
  const fixtureStart = performance.now();
  const fixtureRows = [];
  for (let index = 0; index < size; index += 1) fixtureRows.push(writeTask(index));
  const fixtureMs = performance.now() - fixtureStart;

  const rebuildStart = performance.now();
  const rebuilt = rebuildTaskProjection({ rootDir });
  const rebuildMs = performance.now() - rebuildStart;

  const querySamples = sample(20, () => queryExecutions({ rootDir }));
  const executions = querySamples.value;
  const legacyExecutionsPayloadBytes = Buffer.byteLength(JSON.stringify({ ok: true, executions }), "utf8");
  const warmQueryP95 = percentile(querySamples.samples, 0.95);
  const evidencePageSamples = sample(20, () => queryExecutionEvidencePage({ rootDir, limit: 25 }));
  const evidencePage = evidencePageSamples.value;
  const readyEvidencePageSamples = sample(20, () => queryExecutionEvidencePageFromReadyProjection({ rootDir, limit: 25 }));
  const readyEvidencePageP95 = percentile(readyEvidencePageSamples.samples, 0.95);
  const evidencePagePayloadBytes = Buffer.byteLength(JSON.stringify(evidencePage), "utf8");
  const evidencePageVisibleItems = evidencePage.groups.length +
    evidencePage.groups.reduce((count, group) => count + group.executions.length, 0) +
    evidencePage.groups.reduce((count, group) => count + group.executions.reduce((outputs, execution) => outputs + execution.outputs.length, 0), 0);
  const aggregateSamples = sample(20, () => aggregateExecutions(rebuilt.rows, executions));
  const changedExecution = fixtureRows[0];
  const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
  const manifest = readDeclaredSourceManifestRows(projectionPath);
  const previousSourceFingerprint = captureProjectionSourceFingerprint(rootDir, manifest).fingerprint;
  const changedBody = JSON.parse(readFileSync(changedExecution.executionPath, "utf8"));
  writeFileSync(changedExecution.executionPath, `${JSON.stringify({ ...changedBody, state: "accepted" }, null, 2)}\n`);
  const incrementalStarted = performance.now();
  const incremental = updateTaskProjectionIncrementally({
    rootDir,
    touchedPaths: [changedExecution.executionPath],
    previousSourceFingerprint
  });
  const incrementalExecutionMs = performance.now() - incrementalStarted;
  const result = {
    schema: "gui-projection-benchmark/v1",
    fixture: {
      tasks: size,
      executions: size,
      outputs: size * outputsPerExecution,
      attributionEvents: size * attributionEventsPerExecution,
      rootDir: keep ? rootDir : "<temporary>"
    },
    milliseconds: {
      fixture: rounded(fixtureMs),
      rebuild: rounded(rebuildMs),
      queryExecutions: summarize(querySamples.samples),
      queryExecutionEvidencePage: summarize(evidencePageSamples.samples),
      queryExecutionEvidencePageFromReadyProjection: summarize(readyEvidencePageSamples.samples),
      aggregateExecutions: summarize(aggregateSamples.samples),
      incrementalExecution: rounded(incrementalExecutionMs)
    },
    assertions: {
      executionCount: executions.length === size,
      outputCount: aggregateSamples.value.totalOutputs === size * outputsPerExecution,
      evidencePageGroupCount: evidencePage.groups.length,
      evidencePagePayloadBytes,
      legacyExecutionsPayloadBytes,
      evidencePagePayloadReductionRatio: rounded(legacyExecutionsPayloadBytes / Math.max(1, evidencePagePayloadBytes)),
      evidencePagePayloadWithinBudget: evidencePagePayloadBytes <= 250 * 1024,
      evidencePageVisibleItems,
      evidencePageVisibleItemsWithinBudget: evidencePageVisibleItems <= 200,
      readyEvidencePageP95BudgetMs: size === 1_000 ? 15 : size === 5_000 ? 60 : null,
      readyEvidencePageWithinBudget: size === 1_000
        ? readyEvidencePageP95 <= 15
        : size === 5_000
          ? readyEvidencePageP95 <= 60
          : null,
      oneThousandWarmQueryP95BudgetMs: size === 1_000 ? 100 : null,
      warmQueryWithinBudget: size === 1_000
        ? warmQueryP95 <= 100
        : null,
      oneThousandColdProjectionReadyBudgetMs: size === 1_000 ? 10_000 : null,
      coldProjectionReadyWithinBudget: size === 1_000
        ? rebuildMs + warmQueryP95 <= 10_000
        : null,
      incrementalExecutionMode: incremental.mode
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.assertions.executionCount ||
      !result.assertions.outputCount ||
      !result.assertions.evidencePagePayloadWithinBudget ||
      !result.assertions.evidencePageVisibleItemsWithinBudget ||
      result.assertions.readyEvidencePageWithinBudget === false ||
      result.assertions.warmQueryWithinBudget === false ||
      result.assertions.coldProjectionReadyWithinBudget === false ||
      incremental.mode !== "incremental") {
    process.exitCode = 1;
  }
} finally {
  if (!keep) rmSync(rootDir, { recursive: true, force: true });
}

function writeTask(index) {
  const taskId = `task_${String(index).padStart(26, "0")}`;
  const executionId = `exe_${String(index).padStart(26, "0")}`;
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: Performance Task ${index}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: in_review",
    "  ref: ",
    `  titleSnapshot: Performance Task ${index}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"0".repeat(64)}`,
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "",
    `# Performance Task ${index}`,
    ""
  ].join("\n"));
  const executionPath = path.join(taskRoot, "executions", `${executionId}.md`);
  writeFileSync(executionPath, `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person_perf" },
      executor: { kind: "agent", id: "codex" },
      responsibleHuman: "person_perf"
    },
    claimed_at: "2026-07-13T00:00:00.000Z",
    submitted_at: "2026-07-13T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: Array.from({ length: outputsPerExecution }, (_, outputIndex) => ({
      evidence_id: `ev_${index}_${outputIndex}`,
      execution_ref: `execution/${taskId}/${executionId}`,
      locator: { substrate: "inline", text: `Evidence ${index}-${outputIndex}` }
    })),
    submission: null
  }, null, 2)}\n`);
  const attributionRoot = path.join(rootDir, "harness/attribution-events");
  mkdirSync(attributionRoot, { recursive: true });
  for (let eventIndex = 0; eventIndex < attributionEventsPerExecution; eventIndex += 1) {
    const eventId = `event-perf-${index}-${eventIndex}`;
    writeFileSync(path.join(attributionRoot, `${eventId}.jsonl`), `${JSON.stringify({
      schema: "attribution-event/v1",
      eventId,
      opId: `op-${eventId}`,
      journalRecordSchema: "write-journal/v2",
      entityId: `execution/${executionId}`,
      kind: "progress_append",
      actor: {
        principal: { kind: "person", personId: "person_perf" },
        executor: { kind: "agent", id: "codex" }
      },
      principalSource: {
        kind: "local-configured",
        authority: "harness.yaml",
        authoritySha256: `sha256:${"0".repeat(64)}`
      },
      executorSource: "client-asserted",
      at: `2026-07-13T00:00:${String(eventIndex).padStart(2, "0")}.000Z`,
      recordedAt: `2026-07-13T00:01:${String(eventIndex).padStart(2, "0")}.000Z`,
      payloadHash: `sha256:${"1".repeat(64)}`,
      payloadRef: {
        path: `.harness/payloads/${eventId}.json`,
        sha256: `sha256:${"1".repeat(64)}`
      }
    })}\n`);
  }
  return { taskId, executionId, executionPath };
}

function sample(iterations, run) {
  run();
  const samples = [];
  let value;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    value = run();
    samples.push(performance.now() - started);
  }
  return { samples, value };
}

function summarize(samples) {
  return {
    median: rounded(percentile(samples, 0.5)),
    p95: rounded(percentile(samples, 0.95)),
    max: rounded(Math.max(...samples))
  };
}

function percentile(samples, quantile) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function positiveInteger(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} requires a positive integer`);
  return value;
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateExecutions } from "../../packages/gui/src/renderer/execution-data.ts";
import { queryExecutions, rebuildTaskProjection } from "../../packages/kernel/src/index.ts";

const size = positiveInteger("--size", 1_000);
const outputsPerExecution = positiveInteger("--outputs", 5);
const keep = process.argv.includes("--keep");
const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-perf-"));

try {
  const fixtureStart = performance.now();
  for (let index = 0; index < size; index += 1) writeTask(index);
  const fixtureMs = performance.now() - fixtureStart;

  const rebuildStart = performance.now();
  const rebuilt = rebuildTaskProjection({ rootDir });
  const rebuildMs = performance.now() - rebuildStart;

  const querySamples = sample(5, () => queryExecutions({ rootDir }));
  const executions = querySamples.value;
  const aggregateSamples = sample(20, () => aggregateExecutions(rebuilt.rows, executions));
  const result = {
    schema: "gui-projection-benchmark/v1",
    fixture: {
      tasks: size,
      executions: size,
      outputs: size * outputsPerExecution,
      rootDir: keep ? rootDir : "<temporary>"
    },
    milliseconds: {
      fixture: rounded(fixtureMs),
      rebuild: rounded(rebuildMs),
      queryExecutions: summarize(querySamples.samples),
      aggregateExecutions: summarize(aggregateSamples.samples)
    },
    assertions: {
      executionCount: executions.length === size,
      outputCount: aggregateSamples.value.totalOutputs === size * outputsPerExecution,
      oneThousandExecutionBudgetMs: size === 1_000 ? 10_000 : null,
      queryAndAggregateWithinBudget: size === 1_000
        ? percentile(querySamples.samples, 0.95) + percentile(aggregateSamples.samples, 0.95) < 10_000
        : null
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.assertions.executionCount || !result.assertions.outputCount || result.assertions.queryAndAggregateWithinBudget === false) {
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
  writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
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

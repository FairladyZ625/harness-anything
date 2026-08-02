import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const completionReporterUrl = pathToFileURL(
  path.join(repoRoot, "tools/node-test-completion-reporter.mjs")
).href;
const DEFAULT_TERMINATION_GRACE_MS = 150;
const FINAL_CLOSE_BUDGET_MS = 5_000;

/**
 * Prototype only: run one directly owned Node process per selected test file.
 * File identity is assigned before spawn and never discovered from an OS table.
 */
export async function runFileWorkerSchedule({
  files,
  concurrency,
  env,
  testTimeoutMs = 180_000,
  workerDeadlineMs = 180_000,
  proofExitGraceMs = 1_000,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  junitRoot,
  abortSignal,
  onEvent = () => {}
}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("file-worker prototype requires at least one test file");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("file-worker prototype concurrency must be a positive integer");
  }
  if (junitRoot !== undefined) mkdirSync(junitRoot, { recursive: true });

  const startedAt = performance.now();
  const results = new Array(files.length);
  let cursor = 0;
  const runLane = async () => {
    while (cursor < files.length) {
      if (abortSignal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const worker = {
        id: `file-worker-${String(index + 1).padStart(3, "0")}`,
        file: files[index]
      };
      results[index] = await runOwnedFileWorker({
        worker,
        env,
        testTimeoutMs,
        workerDeadlineMs,
        proofExitGraceMs,
        terminationGraceMs,
        junitPath: junitRoot === undefined
          ? undefined
          : path.join(junitRoot, `${worker.id}.xml`),
        abortSignal,
        runStartedAt: startedAt,
        onEvent
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => runLane())
  );

  if (abortSignal?.aborted && results.some((result) => result === undefined)) {
    for (let index = 0; index < results.length; index += 1) {
      if (results[index] !== undefined) continue;
      results[index] = unstartedSignalResult(files[index], index, abortSignal.reason);
    }
  }
  const durationMs = performance.now() - startedAt;
  const passed = results.every((result) => result.outcome === "passed"
    || result.outcome === "passed-after-reap");
  return {
    schema: "harness-file-worker-schedule-prototype/v1",
    verdict: passed ? "pass" : "fail",
    exitCode: passed ? 0 : 1,
    durationMs,
    concurrency,
    workers: results
  };
}

async function runOwnedFileWorker({
  worker,
  env,
  testTimeoutMs,
  workerDeadlineMs,
  proofExitGraceMs,
  terminationGraceMs,
  junitPath,
  abortSignal,
  runStartedAt,
  onEvent
}) {
  const trace = [];
  const failures = [];
  let output = "";
  let errorOutput = "";
  let proof;
  let proofError;
  let terminationReason;
  let terminationEffect;
  let deadline;

  const args = workerInvocation(worker.file, { testTimeoutMs, junitPath });
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  recordEvent("spawn", { pid: child.pid, command: process.execPath, args });

  const closed = new Promise((resolveClose) => {
    child.once("error", (error) => resolveClose({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveClose({ code, signal, error: null }));
  });

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });
  consumeProofRecords(child.stdio[3], {
    onRecord(record) {
      if (record.type === "test-failure" && proofFile(record.file) === worker.file) {
        failures.push({ name: record.name, file: worker.file });
        return;
      }
      const isOwnedFileSummary = record.type === "test-file-summary"
        && proofFile(record.file) === worker.file;
      // Under `--test-isolation=none`, Node emits the one-process run summary
      // rather than an outer isolation-file summary. The worker is already
      // bound to exactly one file at spawn, so that summary is its direct proof.
      const isOwnedRunSummary = record.type === "test-run-summary";
      if (!isOwnedFileSummary && !isOwnedRunSummary) return;
      if (typeof record.success !== "boolean" || !validProofCounts(record.counts)) {
        proofError = "completion reporter emitted an invalid matching summary";
        requestTermination("invalid-proof");
        return;
      }
      if (proof !== undefined) {
        proofError = "completion reporter emitted more than one matching file summary";
        requestTermination("invalid-proof");
        return;
      }
      proof = {
        success: record.success,
        counts: record.counts
      };
      recordEvent("proof-flushed", { success: proof.success, counts: proof.counts });
      clearTimeout(deadline);
      deadline = setTimeout(
        () => requestTermination("post-proof-exit-wedge"),
        proofExitGraceMs
      );
    },
    onProtocolError(error) {
      proofError = error.message;
      requestTermination("invalid-proof");
    }
  });

  const onAbort = () => requestTermination(parentSignalReason(abortSignal.reason));
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();
  deadline = setTimeout(() => requestTermination("deadline-before-proof"), workerDeadlineMs);

  let close = await closed;
  clearTimeout(deadline);
  if (terminationEffect !== undefined) await terminationEffect;
  if (close.error === null && close.code === null && close.signal === null) {
    close = await closeWithinBudget(closed, FINAL_CLOSE_BUDGET_MS);
  }
  abortSignal?.removeEventListener("abort", onAbort);
  recordEvent("close/reap", {
    kind: terminationReason === undefined ? "close" : "reap",
    reason: terminationReason ?? "natural-close",
    code: close.code,
    signal: close.signal,
    error: close.error?.message ?? null
  });

  const result = settleWorker({
    worker,
    proof,
    proofError,
    failures,
    terminationReason,
    close,
    trace,
    output,
    errorOutput
  });
  recordEvent("settled", { outcome: result.outcome, failure: result.failure });
  result.trace = trace;
  result.durationMs = performance.now() - (runStartedAt + trace[0].atMs);
  return result;

  function requestTermination(reason) {
    if (terminationEffect !== undefined) return;
    terminationReason = reason;
    terminationEffect = terminateOwnedTree(child, terminationGraceMs);
  }

  function recordEvent(phase, detail) {
    const event = {
      phase,
      atMs: performance.now() - runStartedAt,
      detail
    };
    trace.push(event);
    onEvent({ workerId: worker.id, file: worker.file, ...event });
  }
}

function workerInvocation(file, { testTimeoutMs, junitPath }) {
  const args = [
    "--test",
    "--test-isolation=none",
    `--test-timeout=${testTimeoutMs}`,
    `--test-reporter=${completionReporterUrl}`,
    "--test-reporter-destination=stdout"
  ];
  if (junitPath !== undefined) {
    args.push("--test-reporter=junit", `--test-reporter-destination=${junitPath}`);
  }
  args.push("--test-force-exit", file);
  return args;
}

function consumeProofRecords(stream, { onRecord, onProtocolError }) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      try {
        onRecord(JSON.parse(line));
      } catch (error) {
        onProtocolError(new Error(
          `completion proof is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        ));
      }
    }
  });
  stream.once("end", () => {
    if (buffer.trim() !== "") {
      onProtocolError(new Error("completion proof ended with a partial JSON record"));
    }
  });
  stream.once("error", (error) => onProtocolError(error));
}

function proofFile(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../")) return null;
  return relative;
}

function validProofCounts(counts) {
  return counts !== null
    && typeof counts === "object"
    && [
      counts.tests,
      counts.failed,
      counts.passed,
      counts.cancelled,
      counts.skipped,
      counts.todo
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

function settleWorker({
  worker,
  proof,
  proofError,
  failures,
  terminationReason,
  close,
  trace,
  output,
  errorOutput
}) {
  const base = {
    id: worker.id,
    file: worker.file,
    proof: proof ?? null,
    failures,
    close: {
      code: close.code,
      signal: close.signal,
      error: close.error?.message ?? null
    },
    output,
    errorOutput,
    trace
  };
  if (terminationReason?.startsWith("parent-signal:")) {
    return {
      ...base,
      outcome: "failed",
      failure: { name: worker.file, kind: terminationReason }
    };
  }
  if (proofError !== undefined) {
    return {
      ...base,
      outcome: "failed",
      failure: { name: worker.file, kind: "invalid-structured-proof", detail: proofError }
    };
  }
  if (proof === undefined) {
    return {
      ...base,
      outcome: "failed",
      failure: {
        name: worker.file,
        kind: terminationReason ?? "closed-before-proof"
      }
    };
  }
  if (!proof.success) {
    return {
      ...base,
      outcome: terminationReason === "post-proof-exit-wedge" ? "failed-after-reap" : "failed",
      failure: {
        name: failures[0]?.name ?? worker.file,
        kind: "test-failure"
      }
    };
  }
  if (terminationReason === "post-proof-exit-wedge") {
    return { ...base, outcome: "passed-after-reap", failure: null };
  }
  if (terminationReason === undefined && close.error === null && close.code === 0 && close.signal === null) {
    return { ...base, outcome: "passed", failure: null };
  }
  return {
    ...base,
    outcome: "failed",
    failure: { name: worker.file, kind: terminationReason ?? "unexpected-close-after-proof" }
  };
}

async function terminateOwnedTree(child, graceMs) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await runTaskkill(child.pid, graceMs);
    return;
  }
  signalOwnedGroup(child.pid, "SIGTERM");
  await delay(graceMs);
  signalOwnedGroup(child.pid, "SIGKILL");
}

function signalOwnedGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function runTaskkill(pid, graceMs) {
  return new Promise((resolveKill) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    const deadline = setTimeout(() => {
      killer.kill("SIGKILL");
      resolveKill();
    }, Math.max(graceMs, 1_000));
    killer.once("error", () => {
      clearTimeout(deadline);
      resolveKill();
    });
    killer.once("close", () => {
      clearTimeout(deadline);
      resolveKill();
    });
  });
}

function parentSignalReason(reason) {
  const signal = reason?.signal;
  return `parent-signal:${typeof signal === "string" ? signal : "unknown"}`;
}

function unstartedSignalResult(file, index, reason) {
  return {
    id: `file-worker-${String(index + 1).padStart(3, "0")}`,
    file,
    outcome: "failed",
    failure: { name: file, kind: parentSignalReason(reason) },
    proof: null,
    failures: [],
    close: { code: null, signal: null, error: null },
    trace: [],
    durationMs: 0,
    output: "",
    errorOutput: ""
  };
}

function closeWithinBudget(closed, timeoutMs) {
  return Promise.race([
    closed,
    new Promise((resolveClose) => setTimeout(
      () => resolveClose({
        code: null,
        signal: null,
        error: new Error(`owned worker did not close within ${timeoutMs}ms after termination`)
      }),
      timeoutMs
    ))
  ]);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

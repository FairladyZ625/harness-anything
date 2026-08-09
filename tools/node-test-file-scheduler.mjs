import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  beginClosing,
  beginReaping,
  createRunningWorker,
  flushCompletionProof,
  settleWorker
} from "./node-test-supervisor.ts";
import {
  capturePreKillDiagnostics,
  STALL_REPORT_GRACE_MS,
  STALL_TOTAL_ABORT_GRACE_MS
} from "./node-test-stall-diagnostics.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const completionReporterUrl = pathToFileURL(
  path.join(repoRoot, "tools/node-test-completion-reporter.mjs")
).href;
const workerBootstrapUrl = pathToFileURL(
  path.join(repoRoot, "tools/node-test-file-worker-bootstrap.mjs")
).href;
const DEFAULT_PROOF_EXIT_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 150;
const FINAL_CLOSE_BUDGET_MS = 5_000;

export function ownedTreeTerminationAdapter(platform = process.platform) {
  return platform === "win32" ? "windows-taskkill-tree" : "posix-owned-process-group";
}

/**
 * The sole production scheduler for Node test files. Each identity is assigned
 * before spawn and remains paired with its direct ChildProcess for life.
 */
export async function runNodeTestFileSchedule({
  files,
  concurrency,
  env,
  nodeTestV8Flags = [],
  commandPrefix = [],
  testTimeoutMs,
  diagnosticIntervalMs,
  abortWindows,
  proofExitGraceMs = DEFAULT_PROOF_EXIT_GRACE_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  junitRoot,
  stallReportRoot,
  onEvent = () => {}
}) {
  assertScheduleInput({ files, concurrency, testTimeoutMs, diagnosticIntervalMs, abortWindows });
  const preProofDeadlineMs = Math.max(
    testTimeoutMs + diagnosticIntervalMs,
    diagnosticIntervalMs * abortWindows
  );
  mkdirSync(junitRoot, { recursive: true });
  mkdirSync(stallReportRoot, { recursive: true });

  const runStartedAt = performance.now();
  const results = new Array(files.length);
  const activeChildren = new Map();
  const removeParentSignalForwarding = installParentSignalForwarding(activeChildren);
  let cursor = 0;

  try {
    const runLane = async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await runOwnedFileWorker({
          index,
          file: files[index],
          env,
          nodeTestV8Flags,
          commandPrefix,
          testTimeoutMs,
          diagnosticIntervalMs,
          preProofDeadlineMs,
          proofExitGraceMs,
          terminationGraceMs,
          junitPath: path.join(junitRoot, `file-worker-${String(index + 1).padStart(4, "0")}.xml`),
          stallReportRoot,
          activeChildren,
          runStartedAt,
          onEvent
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, () => runLane())
    );
  } finally {
    removeParentSignalForwarding();
  }

  const durationMs = performance.now() - runStartedAt;
  const passed = results.every((result) =>
    result.outcome === "passed" || result.outcome === "passed-after-reap"
  );
  return {
    schema: "harness-node-test-file-schedule/v1",
    verdict: passed ? "pass" : "fail",
    exitCode: passed ? 0 : 1,
    durationMs,
    concurrency,
    counts: aggregateProofCounts(results),
    workers: results
  };
}

async function runOwnedFileWorker({
  index,
  file,
  env,
  nodeTestV8Flags,
  commandPrefix,
  testTimeoutMs,
  diagnosticIntervalMs,
  preProofDeadlineMs,
  proofExitGraceMs,
  terminationGraceMs,
  junitPath,
  stallReportRoot,
  activeChildren,
  runStartedAt,
  onEvent
}) {
  const workerId = `file-worker-${String(index + 1).padStart(4, "0")}`;
  let state = createRunningWorker(workerId, file);
  let terminalState;
  let firstFailureName;
  let protocolError;
  let output = "";
  let errorOutput = "";
  let completionOutput = "";
  let deadline;
  let terminationEffect;
  const trace = [];
  const args = workerInvocation(file, {
    nodeTestV8Flags,
    testTimeoutMs,
    junitPath,
    stallReportRoot
  });
  const invocation = commandPrefix.length === 0
    ? { command: process.execPath, args }
    : { command: commandPrefix[0], args: [...commandPrefix.slice(1), process.execPath, ...args] };
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: {
      ...env,
      HARNESS_FILE_WORKER_SUPPRESS_RUN_SUMMARY: "1"
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  activeChildren.set(workerId, child);
  const workerStartedAt = performance.now();
  recordEvent("spawn", {
    pid: child.pid ?? null,
    command: invocation.command,
    args: invocation.args
  });
  if (shouldLogWorkerIdentity(env)) {
    console.error(
      `[node-test-stall] direct file worker id=${workerId} file=${file}; test host pid=${child.pid ?? "unknown"}`
    );
  }

  const closed = new Promise((resolveClose) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolveClose(value);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });

  const noteActivity = () => {
    if (terminalState !== undefined || state.phase !== "running") return;
    armDeadline(preProofDeadlineMs, "deadline-before-proof");
  };
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    noteActivity();
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    errorOutput += text;
    noteActivity();
    process.stderr.write(text);
  });

  consumeProofRecords(child.stdio[3], {
    onRaw(line) {
      completionOutput += `${line}\n`;
    },
    onRecord(record) {
      if (terminalState !== undefined) return;
      if (record.type === "test-failure") {
        const proofFileName = repositoryRelativeProofFile(record.file);
        if (proofFileName !== file || typeof record.name !== "string") {
          invalidateProof("completion reporter emitted an invalid file failure");
          return;
        }
        firstFailureName ??= record.name;
        return;
      }
      const isOwnedFileSummary = record.type === "test-file-summary"
        && repositoryRelativeProofFile(record.file) === file;
      const isOwnedRunSummary = record.type === "test-run-summary";
      if (!isOwnedFileSummary && !isOwnedRunSummary) {
        invalidateProof("completion reporter emitted an unknown or mismatched record");
        return;
      }
      if (state.phase !== "running") {
        invalidateProof("completion reporter emitted more than one matching summary");
        return;
      }
      if (typeof record.success !== "boolean" || !validProofCounts(record.counts)) {
        invalidateProof("completion reporter emitted an invalid matching summary");
        return;
      }
      state = flushCompletionProof(state, {
        success: record.success,
        counts: record.counts
      });
      recordEvent("proof-flushed", {
        success: state.proof.success,
        counts: state.proof.counts
      });
      if (!state.proof.success && state.proof.counts.cancelled > 0) {
        // A cancelled structured proof is Node's typed timeout outcome. Start
        // owned-tree cleanup before the direct worker can force-exit and orphan
        // a descendant (especially important for taskkill on Windows).
        requestTermination("post-proof-exit-wedge");
      } else {
        armDeadline(proofExitGraceMs, "post-proof-exit-wedge");
      }
    },
    onProtocolError(error) {
      invalidateProof(error.message);
    }
  });

  armDeadline(preProofDeadlineMs, "deadline-before-proof");
  let close = await closed;
  clearTimeout(deadline);
  if (terminalState === undefined) terminalState = beginClosing(state);
  if (terminationEffect !== undefined) await terminationEffect;
  if (terminalState.phase === "closing") {
    await terminateResidualOwnedGroup(child, terminationGraceMs);
  }
  if (close.code === null && close.signal === null && close.error === null) {
    close = await closeWithinBudget(closed, FINAL_CLOSE_BUDGET_MS);
  }
  activeChildren.delete(workerId);
  const normalizedClose = {
    code: close.code,
    signal: close.signal,
    error: close.error instanceof Error ? close.error.message : null
  };
  recordEvent("close/reap", {
    kind: terminalState.phase === "reaping" ? "reap" : "close",
    reason: terminalState.phase === "reaping" ? terminalState.reason.kind : "natural-close",
    ...normalizedClose
  });

  const settled = settleWorker(terminalState, normalizedClose, firstFailureName);
  recordEvent("settled", { outcome: settled.outcome, failure: settled.failure });
  return {
    id: settled.worker.id,
    file: settled.worker.file,
    outcome: settled.outcome,
    failure: settled.failure,
    proof: settled.proof === null
      ? null
      : { success: settled.proof.success, counts: settled.proof.counts },
    close: settled.close,
    trace,
    durationMs: performance.now() - workerStartedAt,
    output,
    errorOutput,
    completionOutput,
    junitPath
  };

  function armDeadline(delayMs, kind) {
    clearTimeout(deadline);
    deadline = setTimeout(() => requestTermination(kind), delayMs);
    deadline.unref?.();
  }

  function invalidateProof(detail) {
    if (protocolError !== undefined || terminalState !== undefined) return;
    protocolError = detail;
    requestTermination("invalid-structured-proof", detail);
  }

  function requestTermination(kind, detail) {
    if (terminalState !== undefined) return;
    clearTimeout(deadline);
    terminalState = beginReaping(state, {
      kind,
      ...(detail === undefined ? {} : { detail })
    });
    terminationEffect = terminateWorker({
      child,
      worker: state.worker,
      state,
      reason: kind,
      diagnosticIntervalMs,
      terminationGraceMs,
      stallReportRoot
    });
  }

  function recordEvent(phase, detail) {
    const event = { phase, atMs: performance.now() - runStartedAt, detail };
    trace.push(event);
    onEvent({ workerId, file, ...event });
  }
}

function workerInvocation(file, {
  nodeTestV8Flags,
  testTimeoutMs,
  junitPath,
  stallReportRoot
}) {
  return [
    ...nodeTestV8Flags,
    `--import=${workerBootstrapUrl}`,
    "--test",
    "--test-isolation=none",
    `--test-timeout=${testTimeoutMs}`,
    `--test-reporter=${completionReporterUrl}`,
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${junitPath}`,
    "--test-force-exit",
    "--report-on-signal",
    "--report-signal=SIGUSR2",
    "--report-exclude-env",
    `--report-directory=${stallReportRoot}`,
    file
  ];
}

async function terminateWorker({
  child,
  worker,
  state,
  reason,
  diagnosticIntervalMs,
  terminationGraceMs,
  stallReportRoot
}) {
  if (child.pid === undefined) return;
  const proof = state.phase === "proof-flushed" ? state.proof : null;
  if (proof?.success === true && reason === "post-proof-exit-wedge") {
    console.error(
      `\n[node-test-stall] direct child pid=${child.pid} completed reporter summary for ${worker.file}; collecting diagnostics before post-completion reap`
    );
    await captureDirectWorkerDiagnostics(child.pid, worker.file, stallReportRoot);
    await forceTerminateOwnedTree(child, terminationGraceMs);
    console.error(
      `[node-test-stall] reaped post-completion child pid=${child.pid} file=${worker.file} termination=${process.platform === "win32" ? "taskkill" : "SIGKILL"}`
    );
    return;
  }

  if (proof?.success === false && proof.counts.cancelled > 0) {
    console.error("node --test reported a structured cancellation; terminating its process tree");
  }

  const silentForMs = reason === "deadline-before-proof"
    ? diagnosticIntervalMs
    : DEFAULT_PROOF_EXIT_GRACE_MS;
  console.error(`\n[node-test-stall] no test output for ${silentForMs}ms; test host pid=${child.pid}`);
  console.error(`[node-test-stall] runner active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  dumpOwnedProcessGroup(child.pid, worker.file);
  console.error(
    `[node-test-stall] direct file worker pid=${child.pid} remained unsettled; --test-timeout cannot fire here, so the runner is terminating the test process tree`
  );
  console.error(`[node-test-stall] stalled test file(s): ${worker.file}`);
  const startedAt = performance.now();
  await captureDirectWorkerDiagnostics(child.pid, worker.file, stallReportRoot);
  if (process.platform === "win32") {
    await forceTerminateOwnedTree(child, terminationGraceMs);
  } else {
    signalOwnedGroup(child.pid, "SIGTERM");
    const remainingGraceMs = Math.max(
      0,
      STALL_TOTAL_ABORT_GRACE_MS - (performance.now() - startedAt)
    );
    if (remainingGraceMs > 0) await delay(remainingGraceMs);
    signalOwnedGroup(child.pid, "SIGKILL");
  }
  console.error(
    `[node-test-stall] diagnostic grace ended; process tree kill completed within ${STALL_TOTAL_ABORT_GRACE_MS}ms budget (report grace ${STALL_REPORT_GRACE_MS}ms)`
  );
}

async function captureDirectWorkerDiagnostics(pid, file, reportDirectory) {
  const member = {
    pid,
    ppid: process.pid,
    pgid: pid,
    waitChannel: null,
    command: `${process.execPath} --test --test-isolation=none ${file}`
  };
  let deadline;
  await Promise.race([
    capturePreKillDiagnostics({
      members: [member],
      hostPid: pid,
      repoRoot,
      reportDirectory,
      preferredPid: pid
    }).catch((error) => {
      console.error(
        `[node-test-stall] pre-kill diagnostics failed; continuing termination: ${error instanceof Error ? error.message : String(error)}`
      );
    }),
    new Promise((resolveDeadline) => {
      deadline = setTimeout(resolveDeadline, STALL_TOTAL_ABORT_GRACE_MS);
      deadline.unref?.();
    })
  ]);
  clearTimeout(deadline);
}

function dumpOwnedProcessGroup(pid, file) {
  if (process.platform === "win32") return;
  const columns = process.platform === "darwin"
    ? "pid ppid pgid stat elapsed argv"
    : "pid ppid pgid stat elapsed wait-channel argv";
  console.error(`[node-test-stall] process group (${columns}):`);
  console.error(`${pid} ${process.pid} ${pid} direct owned ${process.execPath} --test --test-isolation=none ${file}`);
}

function consumeProofRecords(stream, { onRaw, onRecord, onProtocolError }) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      onRaw(line);
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

function repositoryRelativeProofFile(file) {
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

function aggregateProofCounts(results) {
  const total = { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const result of results) {
    if (result.proof === null) continue;
    for (const key of Object.keys(total)) total[key] += result.proof.counts[key];
  }
  return total;
}

async function forceTerminateOwnedTree(child, graceMs) {
  if (child.pid === undefined) return;
  if (ownedTreeTerminationAdapter() === "windows-taskkill-tree") {
    await runTaskkill(child.pid, graceMs);
    return;
  }
  signalOwnedGroup(child.pid, "SIGKILL");
}

async function terminateResidualOwnedGroup(child, graceMs) {
  if (ownedTreeTerminationAdapter() === "windows-taskkill-tree" || child.pid === undefined) return;
  if (!signalOwnedGroup(child.pid, "SIGTERM", { afterNaturalClose: true })) return;
  console.error(
    `[node-test-stall] direct worker pid=${child.pid} closed with lingering descendants; terminating its owned process tree`
  );
  await delay(graceMs);
  signalOwnedGroup(child.pid, "SIGKILL", { afterNaturalClose: true });
}

function signalOwnedGroup(pid, signal, { afterNaturalClose = false } = {}) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // A detached QoS wrapper can finish after proof and Darwin can report EPERM
    // for its former group rather than ESRCH. This exception is safe only after
    // the directly owned child has emitted close; active timeout and
    // signal-forwarding paths remain strict and still surface EPERM.
    if (afterNaturalClose && residualGroupCleanupShouldStop(error)) return false;
    throw error;
  }
}

export function residualGroupCleanupShouldStop(error) {
  return error?.code === "ESRCH" || error?.code === "EPERM";
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

function installParentSignalForwarding(activeChildren) {
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      remove();
      for (const child of activeChildren.values()) {
        if (child.pid === undefined) continue;
        if (ownedTreeTerminationAdapter() === "windows-taskkill-tree") {
          void runTaskkill(child.pid, DEFAULT_TERMINATION_GRACE_MS);
        } else {
          signalOwnedGroup(child.pid, "SIGKILL");
        }
      }
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.prependOnceListener(signal, handler);
  }
  return remove;
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

function shouldLogWorkerIdentity(env) {
  return env.HARNESS_NODE_TEST_EVENT_TRACE === "1"
    || env.HARNESS_RUNNER_STALL_FIXTURE !== undefined
    || env.HARNESS_RUNNER_TIMEOUT_FIXTURE !== undefined
    || env.HARNESS_FILE_WORKER_FIXTURE !== undefined;
}

function assertScheduleInput({ files, concurrency, testTimeoutMs, diagnosticIntervalMs, abortWindows }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("node test file scheduler requires at least one test file");
  }
  for (const [label, value] of Object.entries({
    concurrency,
    testTimeoutMs,
    diagnosticIntervalMs,
    abortWindows
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// Preloaded into every test child. A stalled test file names itself through the watchdog, but the
// watchdog can only say which test entered and never returned -- not what it is waiting for, and on
// a remote Windows runner there is no way to attach a debugger and ask. Node already knows: the
// diagnostic report lists every live libuv handle. Print the ones that keep a process alive shortly
// before the watchdog kills it, so one CI round answers "waiting on what" instead of one more guess.
import { isMainThread, threadId } from "node:worker_threads";

const delayMs = selectStallReportDelayMs(
  process.env.HARNESS_TEST_STALL_REPORT_MS,
  process.env.HARNESS_TEST_STALL_REPORT_FILE_MS,
  process.argv[1],
);

if (Number.isInteger(delayMs) && delayMs > 0) {
  const timer = setTimeout(() => {
    // pid joins a worker thread's report to the process it is holding open, and
    // the thread label says which side of that process is stuck. Without both,
    // two reports from the same stalled process are indistinguishable from two
    // unrelated processes that happened to stall at the same moment.
    const who = `pid=${process.pid} thread=${threadLabel()}`;
    if (process.platform === "win32") {
      emitWindowsActiveResources(who, delayMs);
      return;
    }
    let report;
    try {
      report = process.report.getReport();
    } catch (error) {
      console.error(`[stall-report] could not collect a diagnostic report: ${String(error)}`);
      return;
    }
    const handles = Array.isArray(report.libuv) ? report.libuv.filter(isWaitWorthy) : [];
    console.error(
      `[stall-report] ${process.argv[1] ?? "test child"} ${who} still running after ${delayMs}ms; ${handles.length} active handle(s)`,
    );
    for (const handle of handles) {
      console.error(`[stall-report]   ${describeHandle(handle)}`);
    }
    // A live worker thread keeps its process alive but owns a separate event
    // loop, so its handles never appear in the list above -- a main thread with
    // zero handles that still cannot exit is exactly this case. The report
    // carries each worker's own libuv list; print it from here rather than
    // relying on the preload having run inside the worker.
    for (const worker of Array.isArray(report.workers) ? report.workers : []) {
      const workerHandles = Array.isArray(worker.libuv) ? worker.libuv.filter(isWaitWorthy) : [];
      console.error(`[stall-report]   worker thread still alive; ${workerHandles.length} active handle(s)`);
      for (const handle of workerHandles) console.error(`[stall-report]     ${describeHandle(handle)}`);
    }
  }, delayMs);
  // The report is only interesting for a process that is stuck, and a stuck process has other
  // handles holding it open. Never let this timer be the reason a healthy process cannot exit.
  timer.unref?.();
}

function selectStallReportDelayMs(rawDefaultMs, rawFileOverrides, entryPath) {
  const defaultDelayMs = Number.parseInt(rawDefaultMs ?? "", 10);
  if (!rawFileOverrides || typeof entryPath !== "string" || entryPath.length === 0) return defaultDelayMs;
  const normalizedEntry = entryPath.replaceAll("\\", "/");
  let overrides;
  try {
    overrides = JSON.parse(rawFileOverrides);
  } catch (error) {
    console.error(`[stall-report] invalid HARNESS_TEST_STALL_REPORT_FILE_MS: ${String(error)}`);
    return defaultDelayMs;
  }
  if (!overrides || typeof overrides !== "object") return defaultDelayMs;
  for (const [relativeFile, overrideMs] of Object.entries(overrides)) {
    const normalizedFile = relativeFile.replaceAll("\\", "/");
    if (normalizedEntry === normalizedFile || normalizedEntry.endsWith(`/${normalizedFile}`)) {
      return Number.isInteger(overrideMs) ? overrideMs : defaultDelayMs;
    }
  }
  return defaultDelayMs;
}

// Node 24 on Windows can natively crash when process.report.getReport() walks live worker threads'
// libuv loops concurrently. Summarize active JS resources instead so the child stays alive and
// still reports what is holding its event loop open.
function emitWindowsActiveResources(who, reportDelayMs) {
  const resources = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
  const counts = new Map();
  for (const resource of resources) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  console.error(
    `[stall-report] ${process.argv[1] ?? "test child"} ${who} still running after ${reportDelayMs}ms; ${resources.length} active resource(s) (win32 safe summary)`,
  );
  for (const [resource, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    console.error(`[stall-report]   ${resource} count=${count}`);
  }
}

function threadLabel() {
  try {
    return isMainThread ? "main" : `worker:${threadId}`;
  } catch {
    return "unknown";
  }
}

// Deny known loop plumbing rather than allowing known resources: an unfamiliar handle type is
// exactly the one worth seeing, and an allowlist would drop it silently.
const loopPlumbing = new Set(["async", "check", "prepare", "idle", "loop", "signal"]);
function isWaitWorthy(handle) {
  return handle.is_active === true && !loopPlumbing.has(handle.type);
}

function describeHandle(handle) {
  const parts = [handle.type ?? "unknown"];
  // Every field below is optional and handle-type specific; whichever ones exist are the ones that
  // identify the resource, so include what is present rather than assuming a shape.
  for (const key of [
    "fd",
    "pid",
    "path",
    "localEndpoint",
    "remoteEndpoint",
    "repeat",
    "firesInMsFromNow",
    "width",
    "height",
  ]) {
    const value = handle[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(" ");
}

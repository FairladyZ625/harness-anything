// Preloaded into every test child. A stalled test file names itself through the watchdog, but the
// watchdog can only say which test entered and never returned -- not what it is waiting for, and on
// a remote Windows runner there is no way to attach a debugger and ask. Node already knows: the
// diagnostic report lists every live libuv handle. Print the ones that keep a process alive shortly
// before the watchdog kills it, so one CI round answers "waiting on what" instead of one more guess.
const delayMs = Number.parseInt(process.env.HARNESS_TEST_STALL_REPORT_MS ?? "", 10);

if (Number.isInteger(delayMs) && delayMs > 0) {
  const timer = setTimeout(() => {
    let report;
    try {
      report = process.report.getReport();
    } catch (error) {
      console.error(`[stall-report] could not collect a diagnostic report: ${String(error)}`);
      return;
    }
    const handles = Array.isArray(report.libuv) ? report.libuv.filter(isWaitWorthy) : [];
    console.error(`[stall-report] ${process.argv[1] ?? "test child"} still running after ${delayMs}ms; ${handles.length} active handle(s)`);
    for (const handle of handles) {
      console.error(`[stall-report]   ${describeHandle(handle)}`);
    }
  }, delayMs);
  // The report is only interesting for a process that is stuck, and a stuck process has other
  // handles holding it open. Never let this timer be the reason a healthy process cannot exit.
  timer.unref?.();
}

// Deny known loop plumbing rather than allowing known resources: an unfamiliar handle type is
// exactly the one worth seeing, and an allowlist would drop it silently.
const loopPlumbing = new Set(["async", "check", "prepare", "idle", "loop", "signal"]);
function isWaitWorthy(handle) { return handle.is_active === true && !loopPlumbing.has(handle.type); }

function describeHandle(handle) {
  const parts = [handle.type ?? "unknown"];
  // Every field below is optional and handle-type specific; whichever ones exist are the ones that
  // identify the resource, so include what is present rather than assuming a shape.
  for (const key of ["fd", "pid", "path", "localEndpoint", "remoteEndpoint", "repeat", "firesInMsFromNow", "width", "height"]) {
    const value = handle[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(" ");
}

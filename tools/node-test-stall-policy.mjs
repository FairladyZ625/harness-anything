/**
 * Owns the scheduler-independent policy for diagnosing and aborting a stalled
 * Node test run. The runner supplies clock readings and process observations;
 * this module decides when the evidence is strong enough to act.
 */
export function createNodeTestStallPolicy({
  diagnosticIntervalMs,
  abortWindows,
  testTimeoutMs,
  startedAt
}) {
  assertPositiveInteger(diagnosticIntervalMs, "diagnosticIntervalMs");
  assertPositiveInteger(abortWindows, "abortWindows");
  assertPositiveInteger(testTimeoutMs, "testTimeoutMs");
  assertTimestamp(startedAt, "startedAt");

  // A stable per-process wait signature identifies the exact isolated file and
  // is strong enough to act after the configured observation windows.
  const isolationAbortAfterMs = abortWindows * diagnosticIntervalMs;
  // Aggregate silence is weaker evidence. Never let it preempt Node's own
  // per-test timeout, which can name a running test more precisely.
  const aggregateAbortAfterMs = Math.max(
    isolationAbortAfterMs,
    testTimeoutMs + diagnosticIntervalMs
  );
  const isolationObservations = new Map();
  let lastProgressAt = startedAt;
  let lastDiagnosticAt = startedAt;
  let abortChosen = false;

  return {
    noteOutput(text, at) {
      assertTimestamp(at, "output timestamp");
      if (typeof text !== "string") throw new Error("output must be a string");
      lastProgressAt = at;
      lastDiagnosticAt = at;
    },

    tick({ at, isolationCandidates = [] }) {
      assertTimestamp(at, "tick timestamp");
      if (!Array.isArray(isolationCandidates)) {
        throw new Error("isolationCandidates must be an array");
      }
      if (abortChosen) return { diagnostic: null, abort: null };

      const isolationAbort = observeIsolationCandidates({
        at,
        candidates: isolationCandidates,
        observations: isolationObservations,
        abortAfterMs: isolationAbortAfterMs,
        diagnosticIntervalMs
      });

      const silentForMs = elapsedMilliseconds(lastProgressAt, at);
      const silentWindows = Math.floor(silentForMs / diagnosticIntervalMs);
      let diagnostic = null;
      if (
        silentForMs >= diagnosticIntervalMs
        && elapsedMilliseconds(lastDiagnosticAt, at) >= diagnosticIntervalMs
      ) {
        lastDiagnosticAt = at;
        diagnostic = { silentForMs, silentWindows };
      }

      // The timer is only a wake-up mechanism. Decisions use elapsed evidence,
      // so a busy CI scheduler cannot postpone the bound by skipping callbacks.
      const aggregateAbort = silentForMs >= aggregateAbortAfterMs
        ? {
            kind: "aggregate-silence",
            silentMs: silentForMs,
            silentWindows
          }
        : null;
      const abort = isolationAbort ?? aggregateAbort;
      if (abort !== null) abortChosen = true;
      return { diagnostic, abort };
    },

    resumeAfterReap(at) {
      assertTimestamp(at, "reap timestamp");
      isolationObservations.clear();
      lastProgressAt = at;
      lastDiagnosticAt = at;
      abortChosen = false;
    }
  };
}

function observeIsolationCandidates({
  at,
  candidates,
  observations,
  abortAfterMs,
  diagnosticIntervalMs
}) {
  const liveCandidates = new Set();
  const wedged = [];
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate?.pid) || candidate.pid <= 0 || !Array.isArray(candidate.files)) continue;
    const files = [...new Set(candidate.files)]
      .filter((file) => typeof file === "string" && file.length > 0)
      .sort();
    if (files.length === 0) continue;
    liveCandidates.add(candidate.pid);
    const fileKey = files.join("\0");
    const previous = observations.get(candidate.pid);
    const firstSeenAt = previous?.fileKey === fileKey ? previous.firstSeenAt : at;
    observations.set(candidate.pid, { fileKey, firstSeenAt });
    const wedgedForMs = elapsedMilliseconds(firstSeenAt, at);
    if (wedgedForMs >= abortAfterMs) {
      wedged.push({
        pid: candidate.pid,
        files,
        wedgedForMs
      });
    }
  }

  for (const pid of observations.keys()) {
    if (!liveCandidates.has(pid)) observations.delete(pid);
  }
  if (wedged.length === 0) return null;

  const primary = wedged.reduce((oldest, entry) => (
    entry.wedgedForMs > oldest.wedgedForMs ? entry : oldest
  ));
  return {
    kind: "isolation-wedge",
    isolationChildPid: primary.pid,
    files: [...new Set(wedged.flatMap((entry) => entry.files))],
    silentMs: primary.wedgedForMs,
    silentWindows: Math.max(1, Math.floor(primary.wedgedForMs / diagnosticIntervalMs))
  };
}

function elapsedMilliseconds(startedAt, endedAt) {
  return Math.max(0, Math.floor(endedAt - startedAt));
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

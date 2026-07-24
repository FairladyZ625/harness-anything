import path from "node:path";

export function parseCompletionLedger(source, repoRoot) {
  const fileSummaries = new Map();
  const failures = [];
  let runSummary = null;
  const lines = source.split("\n");
  const trailingFragment = lines.pop() ?? "";

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return invalidLedger("completion reporter emitted invalid JSON");
    }
    if (record?.type === "test-file-summary") {
      const file = repositoryRelativeFile(record.file, repoRoot);
      if (
        file === null
        || fileSummaries.has(file)
        || typeof record.success !== "boolean"
        || !validCounts(record.counts)
      ) {
        return invalidLedger("completion reporter emitted an invalid file summary");
      }
      fileSummaries.set(file, {
        success: record.success,
        counts: record.counts
      });
      continue;
    }
    if (record?.type === "test-failure") {
      const file = repositoryRelativeFile(record.file, repoRoot);
      if (file === null || typeof record.name !== "string") {
        return invalidLedger("completion reporter emitted an invalid failure");
      }
      failures.push({
        file,
        name: record.name,
        signal: typeof record.signal === "string" ? record.signal : null
      });
      continue;
    }
    if (record?.type === "test-run-summary") {
      if (
        runSummary !== null
        || typeof record.success !== "boolean"
        || !validCounts(record.counts)
      ) {
        return invalidLedger("completion reporter emitted an invalid run summary");
      }
      runSummary = { success: record.success, counts: record.counts };
      continue;
    }
    return invalidLedger("completion reporter emitted an unknown record");
  }

  return {
    valid: true,
    incompleteTrailingRecord: trailingFragment.trim() !== "",
    fileSummaries,
    failures,
    runSummary,
    error: null
  };
}

export function completedIsolationFile(ledger, files) {
  if (!ledger.valid || files.length !== 1) return null;
  const file = files[0];
  const summary = ledger.fileSummaries.get(file);
  return summary === undefined ? null : { file, summary };
}

export function canIgnoreReapedFileFailures({
  ledger,
  selectedFiles,
  reapedFiles
}) {
  if (!ledger.valid || ledger.incompleteTrailingRecord || ledger.runSummary === null || reapedFiles.size === 0) {
    return false;
  }
  if (selectedFiles.some((file) => ledger.fileSummaries.get(file)?.success !== true)) {
    return false;
  }
  if (
    ledger.failures.length !== reapedFiles.size
    || ledger.failures.some((failure) =>
      !reapedFiles.has(failure.file)
      || failure.name !== failure.file
      || failure.signal !== "SIGKILL"
    )
  ) {
    return false;
  }
  return ledger.runSummary.success === false
    && ledger.runSummary.counts.failed === reapedFiles.size;
}

function repositoryRelativeFile(file, repoRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../")) return null;
  return relative;
}

function validCounts(counts) {
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

function invalidLedger(error) {
  return {
    valid: false,
    incompleteTrailingRecord: false,
    fileSummaries: new Map(),
    failures: [],
    runSummary: null,
    error
  };
}

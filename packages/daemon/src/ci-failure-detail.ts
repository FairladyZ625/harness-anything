import type { CiRunDetail } from "@harness-anything/kernel";
type CiDiagnosticTest = CiRunDetail["tests"][number];

export interface CiFailureExcerpt {
  readonly testFiles: readonly string[];
  readonly tests: readonly string[];
  readonly errors: readonly {
    readonly test: string;
    readonly firstLine: string;
    readonly frames: readonly string[];
  }[];
  readonly excerpt: string;
  readonly truncated: boolean;
}

type ParsedFailure = CiFailureExcerpt & { readonly failedFilePaths: readonly string[] };

const maxFailedTestsPerJob = 20,
  maxFailedFilesPerJob = 20,
  maxFramesPerError = 5,
  failureLineCharBudget = 512,
  errorBlockLineBudget = 60,
  fallbackExcerptLines = 15,
  fallbackExcerptChars = 2048;
const timestampPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u;
const failedFileLine = /^\[node-test-file\] (?!pass\b)(\S+) (.+)$/u;
const failedTestLine = /^\s*✖ (.+)$/u;
const durationSuffix = / \([\d.]+m?s\)$/u;
const frameLine = /^\s*at /u;
const reporterLine = /^\s*[✔✖❯▼﹒✎‼﹖ℹ]/u;
const fallbackErrorLine = /##\[error\]|Error:|error:/u;

function bounded(text: string, limit: number, truncated: { value: boolean }): string {
  if (text.length <= limit) return text;
  truncated.value = true;
  return text.slice(0, limit);
}

/** Parse runner markers into bounded, provider-neutral failure detail. The raw log never leaves this boundary. */
export function extractCiFailure(log: string): CiFailureExcerpt {
  return parseCiFailure(log);
}

function parseCiFailure(log: string): ParsedFailure {
  const lines = log.split(/\r?\n/u).map((line) => line.replace(timestampPrefix, "")),
    testFiles: string[] = [],
    failedFilePaths: string[] = [],
    tests: string[] = [],
    errors = new Map<string, { test: string; firstLine: string; frames: string[] }>();
  const truncated = { value: false };
  let currentFile: string | undefined;
  const scanErrorBlock = (start: number, name: string) => {
    let firstLine = "";
    const frames: string[] = [];
    for (let j = start; j < Math.min(lines.length, start + errorBlockLineBudget); j += 1) {
      const raw = lines[j]!;
      if (reporterLine.test(raw) || failedFileLine.test(raw)) break;
      const text = raw.trim();
      if (text === "") continue;
      if (frameLine.test(text)) {
        if (firstLine === "") break;
        if (frames.length >= maxFramesPerError) truncated.value = true;
        else frames.push(bounded(text, failureLineCharBudget, truncated));
        continue;
      }
      if (firstLine === "") firstLine = bounded(text, failureLineCharBudget, truncated);
    }
    const previous = errors.get(name);
    errors.set(name, {
      test: name,
      firstLine: previous?.firstLine || firstLine,
      frames: previous && previous.frames.length > 0 ? previous.frames : frames,
    });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!,
      file = failedFileLine.exec(line);
    if (file) {
      const entry = `${file[1]} ${file[2]}`;
      currentFile = file[2]!;
      if (testFiles.length >= maxFailedFilesPerJob) truncated.value = true;
      else if (!testFiles.includes(entry)) testFiles.push(entry);
      if (!failedFilePaths.includes(currentFile) && failedFilePaths.length < maxFailedFilesPerJob)
        failedFilePaths.push(currentFile);
      continue;
    }
    const failed = failedTestLine.exec(line);
    if (!failed) continue;
    const name = bounded(failed[1]!.trim().replace(durationSuffix, ""), failureLineCharBudget, truncated);
    if (name === "failing tests:") continue;
    if (!tests.includes(name)) {
      if (tests.length >= maxFailedTestsPerJob) truncated.value = true;
      else tests.push(name);
    }
    scanErrorBlock(i + 1, name);
  }
  let excerpt = "";
  if (tests.length === 0 && testFiles.length === 0) {
    const index = lines.findIndex((line) => fallbackErrorLine.test(line));
    if (index >= 0) {
      const joined = lines.slice(index, index + fallbackExcerptLines).join("\n");
      excerpt = bounded(joined, fallbackExcerptChars, truncated);
    }
  }
  return {
    testFiles,
    tests,
    errors: [...errors.values()],
    excerpt,
    truncated: truncated.value,
    failedFilePaths,
  };
}

function boundedSummary(value: string): string {
  return value.length <= 256 ? value : value.slice(0, 256);
}

/** Convert a bounded provider log into the canonical detail blob accepted by CI observation v4. */
export function ciFailureDetail(log: string): CiRunDetail {
  const parsed = parseCiFailure(log),
    tests: CiDiagnosticTest[] = parsed.tests.map((name, index) => ({
      testKey: JSON.stringify([parsed.failedFilePaths[index] ?? parsed.failedFilePaths[0] ?? "unknown", name]),
      file: parsed.failedFilePaths[index] ?? parsed.failedFilePaths[0] ?? "unknown",
      name,
      suite: [],
      executionOrdinal: index + 1,
      declarationLocation: { line: null, column: null },
      failureLocation: null,
      tier: "unknown",
      shard: null,
      durationMs: 0,
      status: "failed",
      ...(parsed.errors[index]?.firstLine
        ? { failureSummary: boundedSummary(parsed.errors[index]!.firstLine) }
        : { failureSummary: "diagnostic unavailable" }),
      truncated: parsed.truncated,
    }));
  const diagnostics = [
    ...parsed.errors.map((error) => ({
      kind: "ci-failure",
      test: error.test,
      firstLine: error.firstLine,
      frames: error.frames,
    })),
    ...(parsed.excerpt ? [{ kind: "ci-failure-excerpt", excerpt: parsed.excerpt }] : []),
  ];
  return { schema: "ci-run-detail/v1", tests, fileOutcomes: [], diagnostics };
}

export function emptyCiFailureDetail(): CiRunDetail {
  return { schema: "ci-run-detail/v1", tests: [], fileOutcomes: [], diagnostics: [] };
}

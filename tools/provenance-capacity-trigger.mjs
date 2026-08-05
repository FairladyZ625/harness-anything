#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyProvenanceCapacitySample,
  provenanceCapacityHeadroomThresholdRatio,
  readProvenanceLedgerScale
} from "../packages/daemon/src/observability/provenance-capacity-trigger.ts";
import { defaultRepoWriteRequestTimeoutMs } from "../packages/daemon/src/runtime/repo-write-client-contract.ts";

export function summarizeRequestEntries(entries, input) {
  const ordered = entries
    .filter((entry) => entry?.repoId === input.repoId)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const telemetry = ordered.flatMap((entry) => {
    if (entry.event !== "repo-write.request.telemetry" || entry.requestId !== input.requestId) return [];
    const message = parseObject(entry.message);
    return message ? [{ entry, frame: message }] : [];
  });
  if (telemetry.length === 0) throw new Error(`No production telemetry found for request ${input.requestId}.`);
  const witnessObserved = telemetry.some(({ frame }) => frame.phase === "compile-task-witness"
    && frame.details?.stage === "document-produce"
    && frame.details?.state === "start");
  if (!witnessObserved) throw new Error(`Request ${input.requestId} is not a task-complete proof.`);

  const historyStarts = [];
  const historyDurations = [];
  const historyPathCounts = [];
  let telemetryInvalid = false;
  let writerExecutionMs = null;
  let writerTerminalMs = null;
  let committed = false;
  let proofObservedAt = null;
  for (const { entry, frame } of telemetry) {
    if (frame.phase === "authority-event-published") committed = true;
    if (frame.phase === "child-execution-returned") writerExecutionMs = finiteMilliseconds(frame.elapsedMs);
    if (frame.phase === "child-terminal-response") writerTerminalMs = finiteMilliseconds(frame.elapsedMs);
    if (frame.phase !== "authority-publication-proof") continue;
    if (frame.details?.stage === "history-start") {
      historyStarts.push({
        elapsedMs: finiteMilliseconds(frame.elapsedMs),
        pathCount: pathCount(frame.details?.pathCount)
      });
    } else if (frame.details?.stage === "history-done") {
      const start = historyStarts.shift();
      const donePathCount = pathCount(frame.details?.pathCount);
      if (!start || start.pathCount !== donePathCount || frame.elapsedMs < start.elapsedMs) {
        telemetryInvalid = true;
        continue;
      }
      historyDurations.push(frame.elapsedMs - start.elapsedMs);
      historyPathCounts.push(donePathCount);
      proofObservedAt = entry.timestamp ?? proofObservedAt;
    }
  }

  if (writerTerminalMs === null) {
    const lastTelemetrySequence = Math.max(...telemetry.map(({ entry }) => Number(entry.sequence)));
    const performance = ordered
      .filter((entry) => Number(entry.sequence) > lastTelemetrySequence && entry.event === "request.performance")
      .map((entry) => ({ entry, message: parseObject(entry.message) }))
      .find(({ message }) => message?.method === "repo.command.run"
        && typeof message.phasesMs?.["repo-write-child"] === "number");
    if (performance?.message) {
      writerTerminalMs = finiteMilliseconds(performance.message.phasesMs["repo-write-child"]);
      writerExecutionMs ??= writerTerminalMs;
    }
  }
  if (writerTerminalMs === null) throw new Error(`Request ${input.requestId} has no terminal writer duration.`);
  if (!committed && input.includeDryRun !== true) {
    throw new Error(`Request ${input.requestId} is a dry-run; pass --include-dry-run to report it explicitly.`);
  }

  const telemetryComplete = historyDurations.length === 4
    && historyStarts.length === 0
    && historyPathCounts.every((count) => count !== null)
    && !telemetryInvalid;
  const writerDeadlineMs = positiveNumber(input.writerDeadlineMs ?? defaultRepoWriteRequestTimeoutMs, "writer deadline");
  const headroomMs = roundMilliseconds(writerDeadlineMs - writerTerminalMs);
  const headroomRatio = roundRatio(headroomMs / writerDeadlineMs);
  const alert = writerDeadlineMs - writerTerminalMs
    <= writerDeadlineMs * provenanceCapacityHeadroomThresholdRatio;
  const sampleClass = classifyProvenanceCapacitySample(input.requestId);
  return {
    schema: "provenance-capacity-report/v1",
    status: telemetryComplete
      ? (sampleClass === "cold-start" ? "cold-start" : alert ? "alert" : "ok")
      : "measurement-failed",
    source: committed ? "production-task-complete" : "production-dry-run",
    sampleClass,
    requestId: input.requestId,
    proofObservedAt,
    proofHistoryMs: telemetryComplete
      ? roundMilliseconds(historyDurations.reduce((sum, duration) => sum + duration, 0))
      : null,
    historyScanCount: historyDurations.length,
    historyPathCounts,
    writerExecutionMs: writerExecutionMs === null ? null : roundMilliseconds(writerExecutionMs),
    writerTerminalMs: roundMilliseconds(writerTerminalMs),
    writerDeadlineMs,
    headroomMs,
    headroomRatio,
    alertThresholdRatio: roundRatio(provenanceCapacityHeadroomThresholdRatio)
  };
}

export function formatProvenanceCapacityReport(report) {
  const values = [
    `status=${report.status}`,
    `source=${report.source}`,
    `sampleClass=${report.sampleClass}`,
    `request=${report.requestId}`,
    `proofObservedAt=${report.proofObservedAt ?? "unknown"}`,
    `ledgerHeadNow=${report.ledgerHeadNow}`,
    `firstParentCommitsNow=${report.firstParentCommitCountNow}`,
    `totalCommitsNow=${report.totalCommitCountNow}`,
    `proofHistoryMs=${report.proofHistoryMs ?? "unavailable"}`,
    `writerExecutionMs=${report.writerExecutionMs ?? "unavailable"}`,
    `writerTerminalMs=${report.writerTerminalMs}`,
    `writerDeadlineMs=${report.writerDeadlineMs}`,
    `headroomMs=${report.headroomMs}`,
    `headroomRatio=${report.headroomRatio}`,
    `thresholdRatio=${report.alertThresholdRatio}`,
    `historyScans=${report.historyScanCount}`,
    `pathCounts=${report.historyPathCounts.join(",")}`
  ];
  return `[provenance-capacity] ${values.join(" ")}`;
}

async function main(argv) {
  const options = parseArguments(argv);
  const entries = readDaemonLogEntries(options.logDir);
  const requestId = options.requestId ?? latestObservedRequestId(entries, options.repoId);
  const measurement = summarizeRequestEntries(entries, {
    requestId,
    repoId: options.repoId,
    includeDryRun: options.includeDryRun,
    writerDeadlineMs: options.writerDeadlineMs
  });
  const authoredGitRoot = path.resolve(options.root, options.authoredRoot);
  const scale = await readProvenanceLedgerScale(authoredGitRoot);
  const report = {
    ...measurement,
    ledgerHeadNow: scale.ledgerHead,
    firstParentCommitCountNow: scale.firstParentCommitCount,
    totalCommitCountNow: scale.totalCommitCount
  };
  console.log(options.json ? JSON.stringify(report) : formatProvenanceCapacityReport(report));
  return report.status === "alert" ? 2 : report.status === "measurement-failed" ? 1 : 0;
}

function parseArguments(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return candidate;
  };
  const root = path.resolve(value("--root", process.cwd()));
  const deadline = Number(value("--deadline-ms", String(defaultRepoWriteRequestTimeoutMs)));
  return {
    root,
    authoredRoot: value("--authored-root", "harness"),
    logDir: path.resolve(value("--log-dir", path.join(homedir(), ".harness-production", "logs", "harness-anything"))),
    repoId: value("--repo-id", "canonical"),
    requestId: value("--request-id", null),
    includeDryRun: argv.includes("--include-dry-run"),
    writerDeadlineMs: positiveNumber(deadline, "--deadline-ms"),
    json: argv.includes("--json")
  };
}

function readDaemonLogEntries(logDir) {
  const files = readdirSync(logDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/u.test(name))
    .sort();
  return files.flatMap((name) => readFileSync(path.join(logDir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = parseObject(line);
      return entry ? [entry] : [];
    }));
}

function latestObservedRequestId(entries, repoId) {
  for (const entry of [...entries].sort((left, right) => Number(right.sequence) - Number(left.sequence))) {
    if (entry.repoId !== repoId || ![
      "provenance.capacity.observation",
      "provenance.capacity.alert",
      "provenance.capacity.cold-start",
      "provenance.capacity.measurement-failed"
    ].includes(entry.event)) continue;
    const message = parseObject(entry.message);
    if (typeof message?.requestId === "string") return message.requestId;
  }
  throw new Error("No automatic provenance capacity observation was found; pass --request-id for a historical production request.");
}

function parseObject(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pathCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteMilliseconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Production telemetry contains an invalid elapsedMs value.");
  }
  return value;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(`[provenance-capacity] error=${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}

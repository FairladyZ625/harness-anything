import {
  hasContractFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
} from "./write-chain.contract.ts";
import { completionEvidenceResults } from "./completion-evidence.ts";
import {
  CI_RUN_OBSERVATION_SCHEMA,
  validRun,
  validVerification,
  type CiRunObservationEventV3,
} from "./ci-run-observation-event.ts";

export type CiTestOutcome = "passed" | "failed" | "skipped" | "cancelled";
export type CiFileTerminationOutcome = "timeout" | "hung" | "crashed" | "cancelled";
export type CiMeasurementStatus = "complete" | "partial" | "unknown" | "no-test-artifact";

export type CiDiagnosticTest = {
  readonly testKey: string;
  readonly file: string;
  readonly name: string;
  readonly suite: readonly string[];
  readonly executionOrdinal: number;
  readonly declarationLocation: { readonly line: number | null; readonly column: number | null };
  readonly failureLocation: { readonly file: string; readonly line: number; readonly column: number } | null;
  readonly tier: string;
  readonly shard: number | null;
  readonly durationMs: number;
  readonly status: CiTestOutcome;
  readonly failureSummary?: string;
  readonly truncated?: boolean;
  readonly error?: unknown;
};
export type CiFileOutcome = {
  readonly file: string;
  readonly outcome: CiFileTerminationOutcome;
  readonly lastActiveTest?: string | null;
  readonly elapsedMs?: number;
  readonly limitMs?: number | "none";
  readonly reason: string;
  readonly stallSummary?: string;
  readonly truncated?: boolean;
  readonly diagnosticRef?: string | null;
};
export type CiDetailRef = {
  readonly schema: "ci-run-detail/v1";
  readonly sha256: string;
  readonly mediaType: "application/json";
  readonly encoding: "identity";
  readonly encodedBytes: number;
  readonly decodedBytes: number;
};
export type CiObservationIdentity = {
  readonly provider: "github-actions" | "write-coordinator" | "local";
  readonly repositoryId: string;
  readonly workflow: string;
  readonly workflowPath: string;
  readonly workflowId: string | null;
  readonly databaseRunId: string;
  readonly runAttempt: number;
  readonly jobExecutionId: string | null;
  readonly jobKey: string | null;
};
export type CiRunObservationEventV4 = EventEnvelope<
  "ci-run-observation/v4",
  "ci_run_observed",
  ActorIdentity,
  {
    readonly scope: "workflow" | "job";
    readonly identity: CiObservationIdentity;
    readonly run: CiRunObservationEventV3["payload"]["run"];
    readonly verification: CiRunObservationEventV3["payload"]["verification"];
    readonly gates: CiRunObservationEventV3["payload"]["gates"];
    readonly measurementCoverage: {
      readonly status: CiMeasurementStatus;
      readonly missingReason: string | null;
      readonly startedFileCount: number | null;
      readonly completedFileCount: number | null;
    };
    readonly testSummary: {
      readonly observationCount: number;
      readonly finalTestCount: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
      readonly cancelled: number;
    } | null;
    readonly failedTests: readonly CiDiagnosticTest[];
    readonly fileOutcomes: readonly CiFileOutcome[];
    readonly shardDurations: readonly {
      readonly tier: string;
      readonly shard: number | null;
      readonly durationMs: number;
    }[];
    readonly detailRef: CiDetailRef | null;
  }
>;

export function ciDiagnosticSummary(
  tests: readonly CiDiagnosticTest[],
): NonNullable<CiRunObservationEventV4["payload"]["testSummary"]> {
  const final = [...new Map(tests.map((test) => [test.testKey, test])).values()];
  return {
    observationCount: tests.length,
    finalTestCount: final.length,
    passed: final.filter((test) => test.status === "passed").length,
    failed: final.filter((test) => test.status === "failed").length,
    skipped: final.filter((test) => test.status === "skipped").length,
    cancelled: final.filter((test) => test.status === "cancelled").length,
  };
}

export type CiRunDetail = {
  readonly schema: "ci-run-detail/v1";
  readonly tests: readonly CiDiagnosticTest[];
  readonly fileOutcomes: readonly CiFileOutcome[];
  readonly diagnostics: readonly unknown[];
};

export function ciDetailMeasurement(detail: CiRunDetail) {
  const tests = [...new Map(detail.tests.map((test) => [test.testKey, test])).values()];
  const shards = new Map<string, { tier: string; shard: number | null; durationMs: number }>();
  for (const test of detail.tests) {
    const key = JSON.stringify([test.tier, test.shard]);
    const row = shards.get(key) ?? { tier: test.tier, shard: test.shard, durationMs: 0 };
    row.durationMs += test.durationMs;
    shards.set(key, row);
  }
  return {
    testSummary: ciDiagnosticSummary(detail.tests),
    failedTests: tests.filter((test) => test.status === "failed").map(({ error: _error, ...test }) => test),
    fileOutcomes: detail.fileOutcomes.map(
      ({ file, outcome, lastActiveTest, elapsedMs, limitMs, reason, stallSummary, truncated, diagnosticRef }) => ({
        file,
        outcome,
        lastActiveTest,
        elapsedMs,
        limitMs,
        reason,
        stallSummary,
        truncated,
        diagnosticRef,
      }),
    ),
    shardDurations: [...shards.values()],
  };
}

export function validateCiRunObservationEventV4(value: unknown, allowUnknownFields = true): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(value, CI_RUN_OBSERVATION_SCHEMA.required, allowUnknownFields) ||
    value.schema !== "ci-run-observation/v4" ||
    value.type !== "ci_run_observed" ||
    validateEventEnvelopeIdentity(value, allowUnknownFields).length
  )
    return ["invalid v4 CI envelope"];
  const p = value.payload;
  if (
    !isRecord(p) ||
    !hasContractFields(
      p,
      [
        "scope",
        "identity",
        "run",
        "verification",
        "gates",
        "measurementCoverage",
        "testSummary",
        "failedTests",
        "fileOutcomes",
        "shardDurations",
        "detailRef",
      ],
      allowUnknownFields,
    ) ||
    !["workflow", "job"].includes(String(p.scope))
  )
    return ["invalid v4 payload"];
  if (
    !isRecord(p.identity) ||
    !hasContractFields(
      p.identity,
      [
        "provider",
        "repositoryId",
        "workflow",
        "workflowPath",
        "workflowId",
        "databaseRunId",
        "runAttempt",
        "jobExecutionId",
        "jobKey",
      ],
      allowUnknownFields,
    ) ||
    !["github-actions", "local", "write-coordinator"].includes(String(p.identity.provider)) ||
    !text(p.identity.repositoryId) ||
    !text(p.identity.workflow) ||
    !text(p.identity.workflowPath) ||
    !(p.identity.workflowId === null || text(p.identity.workflowId)) ||
    !text(p.identity.databaseRunId) ||
    !positive(p.identity.runAttempt)
  )
    return ["invalid CI identity"];
  if (
    !validRun(p.run, allowUnknownFields) ||
    !isRecord(p.run) ||
    !["runId", "sha", "branch", "job", "runner"].every((key) => text((p.run as Record<string, unknown>)[key])) ||
    !nonnegative(p.run.wallclockMs)
  )
    return ["invalid CI run"];
  if (
    !Array.isArray(p.gates) ||
    p.gates.some(
      (gate) =>
        !isRecord(gate) ||
        !hasContractFields(gate, ["gate", "result", "metrics"], allowUnknownFields) ||
        !text(gate.gate) ||
        !completionEvidenceResults.includes(gate.result as never) ||
        !isRecord(gate.metrics) ||
        (!allowUnknownFields &&
          Object.values(gate.metrics).some((metric) => typeof metric !== "number" || !Number.isFinite(metric))),
    )
  )
    return ["invalid CI gates"];
  if (
    !isRecord(p.measurementCoverage) ||
    !hasContractFields(
      p.measurementCoverage,
      ["status", "missingReason", "startedFileCount", "completedFileCount"],
      allowUnknownFields,
    ) ||
    !["complete", "partial", "unknown", "no-test-artifact"].includes(String(p.measurementCoverage.status))
  )
    return ["invalid measurement coverage"];
  if (
    ![p.measurementCoverage.startedFileCount, p.measurementCoverage.completedFileCount].every(
      (n) => n === null || integer(n),
    ) ||
    !(p.measurementCoverage.missingReason === null || text(p.measurementCoverage.missingReason))
  )
    return ["invalid measurement file counts"];
  if (
    !Array.isArray(p.failedTests) ||
    p.failedTests.some((test) => !validFailure(test, allowUnknownFields)) ||
    !Array.isArray(p.fileOutcomes) ||
    p.fileOutcomes.some(
      (entry) =>
        !isRecord(entry) ||
        !hasContractFields(
          entry,
          [
            "file",
            "outcome",
            "reason",
            ...["lastActiveTest", "elapsedMs", "limitMs", "stallSummary", "truncated", "diagnosticRef"].filter(
              (key) => key in entry,
            ),
          ],
          allowUnknownFields,
        ) ||
        !text(entry.file) ||
        !["timeout", "hung", "crashed", "cancelled"].includes(String(entry.outcome)) ||
        !text(entry.reason) ||
        (entry.stallSummary !== undefined &&
          (typeof entry.stallSummary !== "string" || !validSummary(entry.stallSummary))),
    )
  )
    return ["invalid CI diagnostics"];
  if (
    !Array.isArray(p.shardDurations) ||
    p.shardDurations.some(
      (entry) =>
        !isRecord(entry) ||
        !hasContractFields(entry, ["tier", "shard", "durationMs"], allowUnknownFields) ||
        !text(entry.tier) ||
        !(entry.shard === null || positive(entry.shard)) ||
        !nonnegative(entry.durationMs),
    )
  )
    return ["invalid shard durations"];
  if (p.scope === "workflow") {
    if (
      p.detailRef !== null ||
      p.testSummary !== null ||
      p.failedTests.length ||
      p.fileOutcomes.length ||
      p.shardDurations.length ||
      p.measurementCoverage.status !== "no-test-artifact" ||
      p.identity.jobExecutionId !== null ||
      p.identity.jobKey !== null
    )
      return ["workflow cannot invent test measurement"];
  } else {
    const ref = p.detailRef,
      summary = p.testSummary;
    if (
      !text(p.identity.jobExecutionId) ||
      !text(p.identity.jobKey) ||
      !isRecord(ref) ||
      !hasContractFields(
        ref,
        ["schema", "sha256", "mediaType", "encoding", "encodedBytes", "decodedBytes"],
        allowUnknownFields,
      ) ||
      ref.schema !== "ci-run-detail/v1" ||
      ref.mediaType !== "application/json" ||
      ref.encoding !== "identity" ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(ref.sha256) ||
      !integer(ref.encodedBytes) ||
      ref.decodedBytes !== ref.encodedBytes ||
      !isRecord(summary) ||
      !hasContractFields(
        summary,
        ["observationCount", "finalTestCount", "passed", "failed", "skipped", "cancelled"],
        allowUnknownFields,
      ) ||
      !["observationCount", "finalTestCount", "passed", "failed", "skipped", "cancelled"].every((key) =>
        integer(summary[key]),
      ) ||
      summary.failed !== p.failedTests.length ||
      Number(summary.finalTestCount) !==
        Number(summary.passed) + Number(summary.failed) + Number(summary.skipped) + Number(summary.cancelled)
    )
      return ["invalid CI detail reference or summary"];
  }
  if (
    p.identity.provider === "github-actions" &&
    (!/^[1-9][0-9]*$/u.test(p.identity.databaseRunId) ||
      p.run.runId !== `${p.identity.databaseRunId}.${p.identity.runAttempt}`)
  )
    return ["invalid provider run identity"];
  if (!validVerification(p.verification, p.run, allowUnknownFields) || (p.scope === "job" && p.verification !== null))
    return ["invalid CI verification"];
  const v = p.verification;
  if (
    v !== null &&
    (!isRecord(v) ||
      !text(v.workflow) ||
      !text(v.runId) ||
      !positive(v.attempt) ||
      v.headSha !== p.run.sha ||
      !text(v.conclusion) ||
      v.source !== p.identity.provider ||
      (v.source === "github-actions" &&
        (v.runId !== p.identity.databaseRunId ||
          v.attempt !== p.identity.runAttempt ||
          v.workflow !== p.identity.workflow ||
          p.run.branch !== "main" ||
          !text(v.event))))
  )
    return ["invalid CI verification"];
  return [];
}
function validFailure(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    validDiagnosticTest(value, allowUnknownFields) &&
    isRecord(value) &&
    value.status === "failed" &&
    typeof value.failureSummary === "string" &&
    validSummary(value.failureSummary) &&
    typeof value.truncated === "boolean" &&
    (allowUnknownFields || (!("retry" in value) && !("error" in value)))
  );
}
function validSummary(value: string): boolean {
  return new TextEncoder().encode(JSON.stringify(value).slice(1, -1)).length <= 256;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function positive(value: unknown): value is number {
  return integer(value) && value > 0;
}

/** Only this decoder knows historical schema generations. It never rewrites event bytes. */
export type CiObservationRead = Omit<CiRunObservationEventV4, "schema" | "payload"> & {
  readonly schema: "ci-run-observation/read-v1";
  readonly payload: Omit<CiRunObservationEventV4["payload"], "scope" | "measurementCoverage"> & {
    readonly scope: "workflow" | "job" | "legacy";
    readonly measurementCoverage: {
      readonly status: string;
      readonly missingReason: string | null;
      readonly startedFileCount: number | null;
      readonly completedFileCount: number | null;
    };
  };
};
export function decodeCiObservation(
  event:
    | CiRunObservationEventV4
    | CiRunObservationEventV3
    | import("./ci-run-observation-event.ts").CiRunObservationEventV2,
): CiObservationRead {
  if (event.schema === "ci-run-observation/v4") return { ...event, schema: "ci-run-observation/read-v1" };
  const { gates, run, verification } = event.payload;
  const detail = legacyCiDetail(event);
  return {
    ...event,
    schema: "ci-run-observation/read-v1",
    payload: {
      scope: "legacy",
      run,
      verification,
      identity: {
        provider: verification?.source ?? "local",
        repositoryId: "legacy",
        workflow: verification?.workflow ?? "legacy",
        workflowPath: "legacy",
        workflowId: null,
        databaseRunId: verification?.runId ?? run.runId,
        runAttempt: verification?.attempt ?? 1,
        jobExecutionId: null,
        jobKey: null,
      },
      gates: gates.map((gate) =>
        "pass" in gate ? { gate: gate.gate, result: gate.pass ? "pass" : "fail", metrics: gate.metrics } : gate,
      ),
      measurementCoverage: {
        status: "unknown",
        missingReason: "legacy diagnostics unavailable",
        startedFileCount: null,
        completedFileCount: null,
      },
      ...ciDetailMeasurement(detail),
      detailRef: null,
    },
  };
}
export function legacyCiDetail(
  event: CiRunObservationEventV3 | import("./ci-run-observation-event.ts").CiRunObservationEventV2,
): CiRunDetail {
  return {
    schema: "ci-run-detail/v1",
    diagnostics: [],
    fileOutcomes: [],
    tests: event.payload.tests.map((test, index) => ({
      file: test.file,
      name: test.name,
      tier: test.tier,
      shard: test.shard,
      durationMs: test.durationMs,
      status: test.status,
      suite: [],
      testKey: JSON.stringify([test.file, test.name]),
      executionOrdinal: index + 1,
      declarationLocation: { line: null, column: null },
      failureLocation: null,
      ...(test.status === "failed" ? { failureSummary: "unavailable", truncated: false } : {}),
    })),
  };
}

export function validDiagnosticTest(value: unknown, allowUnknownFields = false): boolean {
  return (
    isRecord(value) &&
    hasContractFields(
      value,
      [
        "testKey",
        "file",
        "name",
        "suite",
        "executionOrdinal",
        "declarationLocation",
        "failureLocation",
        "tier",
        "shard",
        "durationMs",
        "status",
        ...["failureSummary", "truncated", "error"].filter((key) => key in value),
      ],
      allowUnknownFields,
    ) &&
    text(value.testKey) &&
    text(value.file) &&
    text(value.name) &&
    Array.isArray(value.suite) &&
    value.suite.every(text) &&
    positive(value.executionOrdinal) &&
    isRecord(value.declarationLocation) &&
    hasContractFields(value.declarationLocation, ["line", "column"], allowUnknownFields) &&
    [value.declarationLocation.line, value.declarationLocation.column].every((n) => n === null || positive(n)) &&
    (value.failureLocation === null ||
      (isRecord(value.failureLocation) &&
        hasContractFields(value.failureLocation, ["file", "line", "column"], allowUnknownFields) &&
        text(value.failureLocation.file) &&
        positive(value.failureLocation.line) &&
        positive(value.failureLocation.column))) &&
    ["fast", "contract", "integration", "gui", "nightly", "unknown"].includes(String(value.tier)) &&
    (value.shard === null || positive(value.shard)) &&
    nonnegative(value.durationMs) &&
    ["passed", "failed", "skipped", "cancelled"].includes(String(value.status)) &&
    (allowUnknownFields || !("retry" in value))
  );
}

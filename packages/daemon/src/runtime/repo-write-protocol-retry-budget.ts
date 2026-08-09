import {
  repoWriteRetryBudgetSignalPhases,
  type RepoWriteRetryBudgetSignalFrame,
  type RepoWriteRetryBudgetSignalPhase
} from "./repo-write-diagnostic-protocol.ts";
import type { RepoWriteProtocolLimits } from "./repo-write-protocol.ts";
import {
  invalidRepoWriteProtocol as invalid,
  limitRepoWriteProtocol as limit
} from "./repo-write-protocol-errors.ts";

type RetryBudgetFrameRecord = Record<string, unknown> & {
  readonly kind: string;
};

type RetryBudgetBaseFields = Pick<
  RepoWriteRetryBudgetSignalFrame,
  "protocol" | "repoId" | "generation"
>;

export function decodeRepoWriteRetryBudgetSignal(
  frame: RetryBudgetFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: RetryBudgetBaseFields
): RepoWriteRetryBudgetSignalFrame {
  assertExactRetryBudgetKeys(frame);
  if (!repoWriteRetryBudgetSignalPhases.includes(
    frame.phase as RepoWriteRetryBudgetSignalPhase
  )) {
    invalid("$.phase", "retry-budget signal phase");
  }
  return {
    ...baseFields,
    kind: "retry-budget-signal",
    phase: frame.phase as RepoWriteRetryBudgetSignalPhase,
    operation: retryBudgetText(frame.operation, "$.operation", limits.maxStringBytes),
    cause: retryBudgetText(frame.cause, "$.cause", limits.maxDiagnosticBytes),
    failures: nonNegativeSafeInteger(frame.failures, "$.failures"),
    retriesUsed: nonNegativeSafeInteger(frame.retriesUsed, "$.retriesUsed"),
    elapsedMs: nonNegativeSafeInteger(frame.elapsedMs, "$.elapsedMs"),
    ...(Object.hasOwn(frame, "remainingMs") ? {
      remainingMs: nonNegativeSafeInteger(frame.remainingMs, "$.remainingMs")
    } : {})
  };
}

function assertExactRetryBudgetKeys(frame: Record<string, unknown>): void {
  const required = [
    "protocol", "repoId", "generation", "kind", "phase", "operation",
    "cause", "failures", "retriesUsed", "elapsedMs"
  ];
  const allowed = new Set([...required, "remainingMs"]);
  if (required.some((key) => !Object.hasOwn(frame, key))
    || Object.keys(frame).some((key) => !allowed.has(key))) {
    invalid("$", "exact message fields");
  }
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, "non-negative safe integer");
  }
  return value;
}

function retryBudgetText(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) limit(path, "string byte length", bytes, maxBytes);
  if (!value.trim()) invalid(path, "non-empty string");
  return value;
}

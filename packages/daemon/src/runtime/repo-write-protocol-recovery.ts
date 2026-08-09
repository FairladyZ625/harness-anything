import type {
  RepoWriteRecoveryDeferredFrame,
  RepoWriteRecoveryRejectedFrame
} from "./repo-write-diagnostic-protocol.ts";
import type { RepoWriteProtocolLimits } from "./repo-write-protocol.ts";
import {
  invalidRepoWriteProtocol as invalid,
  limitRepoWriteProtocol as limit
} from "./repo-write-protocol-errors.ts";

type RecoveryFrameRecord = Record<string, unknown> & {
  readonly kind: string;
};

type RecoveryBaseFields = Pick<
  RepoWriteRecoveryDeferredFrame,
  "protocol" | "repoId" | "generation"
>;

export function decodeRepoWriteRecoveryDeferred(
  frame: RecoveryFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: RecoveryBaseFields
): RepoWriteRecoveryDeferredFrame {
  assertExactRecoveryKeys(frame, ["outerOpId", "code", "diagnostic"]);
  return {
    ...baseFields,
    kind: "recovery-deferred",
    outerOpId: recoveryIdentifier(frame.outerOpId, "$.outerOpId", limits),
    code: recoveryIdentifier(frame.code, "$.code", limits),
    diagnostic: recoveryText(frame.diagnostic, "$.diagnostic", limits.maxDiagnosticBytes)
  };
}

export function decodeRepoWriteRecoveryRejected(
  frame: RecoveryFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: RecoveryBaseFields
): RepoWriteRecoveryRejectedFrame {
  assertExactRecoveryKeys(frame, ["outerOpId", "code", "diagnostic", "next"]);
  return {
    ...baseFields,
    kind: "recovery-rejected",
    outerOpId: recoveryIdentifier(frame.outerOpId, "$.outerOpId", limits),
    code: recoveryIdentifier(frame.code, "$.code", limits),
    diagnostic: recoveryText(frame.diagnostic, "$.diagnostic", limits.maxDiagnosticBytes),
    next: recoveryText(frame.next, "$.next", limits.maxDiagnosticBytes)
  };
}

function assertExactRecoveryKeys(
  frame: Record<string, unknown>,
  fields: ReadonlyArray<string>
): void {
  const required = ["protocol", "repoId", "generation", "kind", ...fields];
  const allowed = new Set(required);
  if (required.some((key) => !Object.hasOwn(frame, key))
    || Object.keys(frame).some((key) => !allowed.has(key))) {
    invalid("$", "exact message fields");
  }
}

function recoveryIdentifier(
  value: unknown,
  path: string,
  limits: RepoWriteProtocolLimits
): string {
  const text = recoveryText(value, path, Math.min(limits.maxStringBytes, 4_096));
  if (!text.trim()) invalid(path, "non-empty identifier");
  return text;
}

function recoveryText(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) limit(path, "string byte length", bytes, maxBytes);
  return value;
}

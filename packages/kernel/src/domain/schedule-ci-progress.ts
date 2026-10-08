import { isRecord, isNonEmptyString } from "./write-chain.contract.ts";
import { timestamp } from "./timestamp.ts";

/** One bounded reconciliation page per occurrence; old runs are revisited on every scan pass. */
export interface CiObserveProgress {
  readonly workflow: string;
  readonly workflowIndex: number;
  readonly scanPass: number;
  readonly nextPage: number;
  readonly nextRunId: number | null;
  readonly nextAttempt: number;
  readonly pending: readonly { readonly runId: number; readonly attempt: number; readonly workflow: string }[];
  readonly unavailable: readonly { readonly runId: number; readonly attempt: number; readonly reason: string }[];
  readonly lastCompletedScanAt: string | null;
  readonly error: string | null;
  readonly retryAt: string | null;
}

export function validCiObserveProgress(value: unknown): value is CiObserveProgress {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "workflow",
          "workflowIndex",
          "scanPass",
          "nextPage",
          "nextRunId",
          "nextAttempt",
          "pending",
          "unavailable",
          "lastCompletedScanAt",
          "error",
          "retryAt",
        ].includes(key),
    )
  )
    return false;
  const integer = (v: unknown, minimum: number) => Number.isSafeInteger(v) && Number(v) >= minimum;
  const target = (v: unknown) => isRecord(v) && integer(v.runId, 1) && integer(v.attempt, 1);
  return (
    typeof value.workflow === "string" &&
    integer(value.workflowIndex, 0) &&
    integer(value.scanPass, 0) &&
    integer(value.nextPage, 1) &&
    (value.nextRunId === null || integer(value.nextRunId, 1)) &&
    integer(value.nextAttempt, 1) &&
    Array.isArray(value.pending) &&
    value.pending.length <= 100 &&
    value.pending.every(
      (v) => target(v) && isRecord(v) && isNonEmptyString(v.workflow) && Object.keys(v).length === 3,
    ) &&
    Array.isArray(value.unavailable) &&
    value.unavailable.length <= 100 &&
    value.unavailable.every(
      (v) => target(v) && isRecord(v) && isNonEmptyString(v.reason) && Object.keys(v).length === 3,
    ) &&
    (value.lastCompletedScanAt === null || timestamp(value.lastCompletedScanAt)) &&
    (value.retryAt === null || timestamp(value.retryAt)) &&
    (value.error === null || (isNonEmptyString(value.error) && value.error.length <= 1024))
  );
}

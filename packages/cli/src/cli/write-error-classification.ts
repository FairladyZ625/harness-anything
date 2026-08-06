import type { WriteError } from "@harness-anything/kernel";
import { CliErrorCode } from "./error-codes.ts";

export function preserveWriteErrorOrUnclassified(error: unknown): WriteError {
  if (isWriteError(error)) return error;
  if (isKernelWriteRejectedError(error)) {
    return {
      _tag: "WriteRejected",
      reason: error.reason,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      ...(typeof error.currentWatermark === "string" || error.currentWatermark === null
        ? { currentWatermark: error.currentWatermark }
        : {}),
      ...(typeof error.expectedWatermark === "string" || error.expectedWatermark === null
        ? { expectedWatermark: error.expectedWatermark }
        : {})
    };
  }
  return {
    _tag: "WriteRejected",
    code: CliErrorCode.UnclassifiedCommandFailure,
    reason: caughtErrorMessage(error)
  };
}

function isWriteError(error: unknown): error is WriteError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  if (error._tag === "WriteRejected") return "reason" in error && typeof error.reason === "string";
  return error._tag === "WriteConflict"
    || error._tag === "GlobalWriteConflict"
    || error._tag === "JournalUnavailable";
}

function isKernelWriteRejectedError(error: unknown): error is {
  readonly _tag: "WriteRejectedError";
  readonly reason: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly currentWatermark?: string | null;
  readonly expectedWatermark?: string | null;
} {
  return typeof error === "object"
    && error !== null
    && "_tag" in error
    && error._tag === "WriteRejectedError"
    && "reason" in error
    && typeof error.reason === "string";
}

function caughtErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string") {
    return error.reason;
  }
  return String(error);
}

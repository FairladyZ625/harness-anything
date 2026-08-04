export function codeDocReconcileNoopReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly reason?: unknown;
    readonly cause?: unknown;
  };
  if ((candidate._tag === "WriteRejected" || candidate._tag === "WriteRejectedError")
    && candidate.code === "code_doc_reconcile_noop"
    && typeof candidate.reason === "string") {
    return candidate.reason;
  }
  if (typeof candidate.message === "string") {
    try {
      const parsed = JSON.parse(candidate.message) as unknown;
      const nested = codeDocReconcileNoopReason(parsed);
      if (nested) return nested;
    } catch {
      // Non-JSON error messages are not typed write rejections.
    }
  }
  return codeDocReconcileNoopReason(candidate.cause);
}

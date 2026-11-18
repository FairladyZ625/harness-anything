/** Render an Error cause chain for a bounded human-facing failure detail. */
export function errorMessageWithCause(error: unknown, limit = 500): string {
  if (!(error instanceof Error)) return String(error).slice(0, limit);
  let message = error.message || error.name,
    cause: unknown = error.cause,
    depth = 0;
  if (cause === undefined) return message.slice(0, limit);
  message += " (cause: ";
  while (cause !== undefined && depth < 3) {
    if (depth > 0) message += " <- ";
    const detail = cause instanceof Error ? cause.message || cause.name : String(cause),
      code =
        typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
    message += `${detail}${code ? ` [${code}]` : ""}`;
    cause = cause instanceof Error ? cause.cause : undefined;
    depth += 1;
  }
  message += ")";
  return message.slice(0, limit);
}

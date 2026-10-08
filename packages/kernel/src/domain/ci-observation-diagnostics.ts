/** Shared observation semantics for Node and Vitest; summaries count JSON-escaped UTF-8 bytes. */
export function boundedCiSummary(text: string): { summary: string; truncated: boolean } {
  let summary = "";
  for (const character of text) {
    const next = summary + character;
    if (new TextEncoder().encode(JSON.stringify(next).slice(1, -1)).length > 256) return { summary, truncated: true };
    summary = next;
  }
  return { summary, truncated: false };
}

export function ciTestOutcome(
  status: string,
  skip?: unknown,
  todo?: unknown,
): "passed" | "failed" | "skipped" | "cancelled" {
  if (skip !== undefined || todo !== undefined || ["pending", "todo", "skipped"].includes(status)) return "skipped";
  if (status === "cancelled") return "cancelled";
  if (status === "passed" || status === "failed") return status;
  throw new Error(`Unknown CI test outcome: ${status}`);
}

export type CiErrorDetail = { name: string; message: string; stack: string | null; cause: CiErrorDetail | null };
export function ciErrorDetail(error: unknown, seen = new Set<unknown>()): CiErrorDetail | null {
  if (error === undefined || error === null) return null;
  if (seen.has(error)) return { name: "Error", message: "circular cause", stack: null, cause: null };
  seen.add(error);
  if (typeof error !== "object") return { name: "Error", message: String(error), stack: null, cause: null };
  const value = error as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : "",
    stack: typeof value.stack === "string" ? value.stack : null,
    cause: ciErrorDetail(value.cause, seen),
  };
}

export function ciFailureDiagnostic(error: unknown): {
  failureSummary: string;
  truncated: boolean;
  error: CiErrorDetail | null;
} {
  const detail = ciErrorDetail(error);
  let cursor =
    typeof error === "object" && error !== null && "code" in error && error.code === "ERR_TEST_FAILURE" && detail?.cause
      ? detail.cause
      : detail;
  while (cursor && !cursor.message.trim()) cursor = cursor.cause;
  const { summary, truncated } = boundedCiSummary(
    cursor?.message.split(/\r?\n/u).find((line) => line.trim()) ?? "unavailable",
  );
  return { failureSummary: summary, truncated, error: detail };
}

export function ciFailureLocation(
  error: { readonly stack?: unknown; readonly cause?: unknown } | undefined,
  root: string,
): { file: string; line: number; column: number } | null {
  const cause = error?.cause;
  const stack = typeof cause === "object" && cause !== null && "stack" in cause ? cause.stack : error?.stack;
  const match = typeof stack === "string" ? /(?:file:\/\/)?([^\s()]+):(\d+):(\d+)/u.exec(stack) : null;
  if (!match) return null;
  const file = match[1]!.replaceAll("\\", "/"),
    prefix = `${root.replaceAll("\\", "/")}/`;
  return {
    file: file.startsWith(prefix) ? file.slice(prefix.length) : file,
    line: Number(match[2]),
    column: Number(match[3]),
  };
}

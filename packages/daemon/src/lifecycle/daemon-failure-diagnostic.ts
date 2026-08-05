export function formatDaemonFailure(error: unknown): string {
  const messages: string[] = [];
  collectDaemonFailure(error, messages, new Set<unknown>());
  return messages.join(" | ") || String(error);
}

export function repoWriteGracefulFailureLog(error: unknown) {
  return {
    level: "warn" as const,
    source: "daemon" as const,
    component: "repo-write-child",
    event: "repo-write.stop.graceful-failed",
    message: `Repo writer graceful shutdown failed, but child exit was confirmed: ${formatDaemonFailure(error)}`,
    errorCode: error instanceof Error
      && "code" in error
      && typeof error.code === "string"
      ? error.code
      : "REPO_WRITE_GRACEFUL_SHUTDOWN_FAILED"
  };
}

function collectDaemonFailure(
  error: unknown,
  messages: string[],
  seen: Set<unknown>
): void {
  if (error !== null && typeof error === "object") {
    if (seen.has(error)) return;
    seen.add(error);
  }
  if (error instanceof Error) {
    messages.push(`${error.name}: ${error.message}`);
    if (error instanceof AggregateError) {
      for (const nested of error.errors) collectDaemonFailure(nested, messages, seen);
    }
    if (error.cause !== undefined) collectDaemonFailure(error.cause, messages, seen);
    return;
  }
  messages.push(String(error));
}

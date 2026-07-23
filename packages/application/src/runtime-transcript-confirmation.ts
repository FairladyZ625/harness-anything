const confirmedUnavailableTranscripts = new Set<string>();

export function recordRuntimeTranscriptInspection(
  session: { readonly runtime: string; readonly sessionId: string },
  status: "available" | "unavailable" | "indeterminate"
): void {
  const key = runtimeTranscriptKey(session.runtime, session.sessionId);
  if (status === "unavailable") confirmedUnavailableTranscripts.add(key);
  else confirmedUnavailableTranscripts.delete(key);
}

export function clearRuntimeTranscriptConfirmation(
  session: { readonly runtime: string; readonly sessionId: string }
): void {
  confirmedUnavailableTranscripts.delete(runtimeTranscriptKey(session.runtime, session.sessionId));
}

export function isRuntimeTranscriptConfirmedUnavailable(
  session: { readonly runtime: string; readonly sessionId: string }
): boolean {
  return confirmedUnavailableTranscripts.has(runtimeTranscriptKey(session.runtime, session.sessionId));
}

function runtimeTranscriptKey(runtime: string, sessionId: string): string {
  return `${runtime}:${sessionId}`;
}

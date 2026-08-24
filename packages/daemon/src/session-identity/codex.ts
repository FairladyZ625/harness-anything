import {
  unavailableSessionIdentity,
  type SessionIdentity,
  type SessionIdentityResolver,
  type SessionIdentityResolverInput,
} from "../../../kernel/src/index.ts";

export const codexSessionIdentityResolver: SessionIdentityResolver = Object.freeze({
  resolve: (input: SessionIdentityResolverInput): SessionIdentity => {
    const events = input.dispatchEvents ?? [],
      threadId =
        events
          .map(codexProviderEvent)
          .filter((event) => event?.type === "thread.started")
          .map((event) => cleanCodexSessionId(event?.thread_id))
          .find((value) => value !== null) ?? null,
      recordedBinding =
        events
          .filter(isCodexRecord)
          .filter((event) => event.kind === "provider_binding")
          .map((event) => cleanCodexSessionId(event.providerSessionId))
          .find((value) => value !== null) ?? null,
      canonicalBinding = cleanCodexSessionId(input.providerBinding?.sessionId),
      environmentThreadId = cleanCodexSessionId(input.env?.CODEX_THREAD_ID),
      environmentSessionId = cleanCodexSessionId(input.env?.CODEX_SESSION_ID);
    if (
      (threadId !== null && recordedBinding !== null && threadId !== recordedBinding) ||
      (canonicalBinding !== null && threadId !== null && canonicalBinding !== threadId) ||
      (canonicalBinding !== null && recordedBinding !== null && canonicalBinding !== recordedBinding) ||
      (environmentThreadId !== null && environmentSessionId !== null && environmentThreadId !== environmentSessionId)
    )
      return unavailableSessionIdentity(input.runtime);
    const dispatchedSessionId = canonicalBinding ?? threadId ?? recordedBinding;
    if (dispatchedSessionId !== null)
      return { runtime: input.runtime, sessionId: dispatchedSessionId, transcriptReachability: "dispatch_stream_only" };
    const interactiveSessionId = environmentThreadId ?? environmentSessionId;
    return interactiveSessionId === null
      ? unavailableSessionIdentity(input.runtime)
      : { runtime: "codex", sessionId: interactiveSessionId, transcriptReachability: "by_session_id" };
  },
});

function codexProviderEvent(value: unknown): Record<string, unknown> | null {
  if (!isCodexRecord(value)) return null;
  return value.kind === "provider_event" && isCodexRecord(value.event) ? value.event : value;
}
function isCodexRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanCodexSessionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

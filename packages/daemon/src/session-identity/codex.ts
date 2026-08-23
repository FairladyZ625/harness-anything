import { unavailableSessionIdentity, type SessionIdentity, type SessionIdentityResolver, type SessionIdentityResolverInput } from "../../../kernel/src/index.ts";

export const codexSessionIdentityResolver: SessionIdentityResolver = Object.freeze({
  resolve: (input: SessionIdentityResolverInput): SessionIdentity => {
    const events = input.dispatchEvents ?? [], threadId = events.map(codexProviderEvent).filter((event) => event?.type === "thread.started").map((event) => cleanCodexSessionId(event?.thread_id)).find((value) => value !== null) ?? null, recordedBinding = events.filter(isCodexRecord).filter((event) => event.kind === "provider_binding").map((event) => cleanCodexSessionId(event.providerSessionId)).find((value) => value !== null) ?? null, canonicalBinding = cleanCodexSessionId(input.providerBinding?.sessionId);
    if (threadId !== null && recordedBinding !== null && threadId !== recordedBinding || canonicalBinding !== null && threadId !== null && canonicalBinding !== threadId || canonicalBinding !== null && recordedBinding !== null && canonicalBinding !== recordedBinding) return unavailableSessionIdentity(input.runtime);
    const sessionId = canonicalBinding ?? threadId ?? recordedBinding;
    return sessionId === null ? unavailableSessionIdentity(input.runtime) : { runtime: input.runtime, sessionId, transcriptReachability: "dispatch_stream_only" };
  }
});

function codexProviderEvent(value: unknown): Record<string, unknown> | null { if (!isCodexRecord(value)) return null; return value.kind === "provider_event" && isCodexRecord(value.event) ? value.event : value; }
function isCodexRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function cleanCodexSessionId(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

import {
  unavailableSessionIdentity,
  type SessionIdentity,
  type SessionIdentityResolver,
  type SessionIdentityResolverInput,
} from "../../../kernel/src/index.ts";

export const agySessionIdentityResolver: SessionIdentityResolver = Object.freeze({
  resolve: (input: SessionIdentityResolverInput): SessionIdentity => {
    const eventId =
        input.dispatchEvents
          ?.map(agyProviderEvent)
          .filter((event) => event?.event === "init")
          .map((event) => cleanAgySessionId(event?.conversation_id))
          .find((value) => value !== null) ?? null,
      sessionId = cleanAgySessionId(input.providerBinding?.sessionId) ?? eventId;
    return sessionId === null
      ? unavailableSessionIdentity(input.runtime)
      : { runtime: input.runtime, sessionId, transcriptReachability: "dispatch_stream_only" };
  },
});

function agyProviderEvent(value: unknown): Record<string, unknown> | null {
  if (!isAgyRecord(value)) return null;
  return value.kind === "provider_event" && isAgyRecord(value.event) ? value.event : value;
}
function isAgyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanAgySessionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

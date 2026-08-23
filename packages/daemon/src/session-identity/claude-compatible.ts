import { unavailableSessionIdentity, type SessionIdentity, type SessionIdentityResolver, type SessionIdentityResolverInput } from "../../../kernel/src/index.ts";

export const claudeCompatibleSessionIdentityResolver: SessionIdentityResolver = Object.freeze({
  resolve: (input: SessionIdentityResolverInput): SessionIdentity => {
    const sessionId = cleanClaudeSessionId(input.providerBinding?.sessionId) ?? cleanClaudeSessionId(input.env?.CLAUDE_CODE_SESSION_ID) ?? input.dispatchEvents?.map(claudeProviderEvent).map((event) => cleanClaudeSessionId(event?.session_id)).find((value) => value !== null) ?? null;
    return sessionId === null ? unavailableSessionIdentity(input.runtime) : { runtime: input.runtime, sessionId, transcriptReachability: "by_session_id" };
  }
});

function claudeProviderEvent(value: unknown): Record<string, unknown> | null { if (!isClaudeRecord(value)) return null; return value.kind === "provider_event" && isClaudeRecord(value.event) ? value.event : value; }
function isClaudeRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function cleanClaudeSessionId(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

import { runtimeProtocolFamilies, runtimeSessionIdFromActor, unavailableSessionIdentity, type RuntimeProtocolFamily, type SessionIdentity, type SessionIdentityResolver, type SessionIdentityResolverInput, type TaskProjection } from "../../../kernel/src/index.ts";
import { agySessionIdentityResolver } from "./agy.ts";
import { claudeCompatibleSessionIdentityResolver } from "./claude-compatible.ts";
import { codexSessionIdentityResolver } from "./codex.ts";

const sessionIdentityResolvers = Object.freeze({
  "claude-compatible": claudeCompatibleSessionIdentityResolver,
  codex: codexSessionIdentityResolver,
  agy: agySessionIdentityResolver
} satisfies Record<RuntimeProtocolFamily, SessionIdentityResolver>);
if (!runtimeProtocolFamilies.every((family) => Object.hasOwn(sessionIdentityResolvers, family))) throw new Error("session identity resolver registry is incomplete");

export function sessionIdentityResolverFor(protocolFamily: RuntimeProtocolFamily): SessionIdentityResolver { return sessionIdentityResolvers[protocolFamily]; }
export function resolveSessionIdentity(protocolFamily: RuntimeProtocolFamily, input: SessionIdentityResolverInput): SessionIdentity { return sessionIdentityResolverFor(protocolFamily).resolve(input); }

export function resolveWriteSessionIdentity(binding: { readonly actor: Parameters<typeof runtimeSessionIdFromActor>[0] }, projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeInstallation">): SessionIdentity {
  const runtimeSessionId = runtimeSessionIdFromActor(binding.actor); if (runtimeSessionId === null) return unavailableSessionIdentity();
  const session = projection.readRuntimeSession(runtimeSessionId); if (session === null) return unavailableSessionIdentity();
  const installation = projection.readRuntimeInstallation(session.installationId); if (installation === null) return unavailableSessionIdentity(session.kindId);
  if (session.providerSessionId === null || session.transcriptRef === null) return unavailableSessionIdentity(session.kindId);
  return resolveSessionIdentity(installation.protocolFamily, { runtime: session.kindId, providerBinding: { sessionId: session.providerSessionId, transcriptRef: session.transcriptRef } });
}

export function transcriptRefForSessionIdentity(identity: SessionIdentity, dispatchStreamRef: string): string | null {
  if (identity.sessionId === null) return null;
  return identity.transcriptReachability === "by_session_id" ? `provider:${encodeURIComponent(identity.runtime)}/${encodeURIComponent(identity.sessionId)}` : identity.transcriptReachability === "dispatch_stream_only" && dispatchStreamRef.startsWith("file:") ? dispatchStreamRef : null;
}

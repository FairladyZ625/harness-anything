import {
  runtimeSessionIdFromActor,
  unavailableSessionIdentity,
  type RuntimeProtocolFamily,
  type SessionIdentity,
  type SessionIdentityResolver,
  type SessionIdentityResolverInput,
  type TaskProjection,
} from "../../../kernel/src/index.ts";
import { runtimeKinds, runtimeProtocolFamilies } from "../runtime-inventory.ts";

export function sessionIdentityResolverFor(protocolFamily: RuntimeProtocolFamily): SessionIdentityResolver {
  const declaration = runtimeKinds.find((kind) => kind.protocolFamily === protocolFamily);
  if (!declaration) throw new Error(`Unknown runtime protocol family: ${protocolFamily}`);
  return {
    resolve: (input) => {
      const clean = (value: unknown): string | null =>
          typeof value === "string" && value.trim() ? value.trim() : null,
        binding = clean(input.providerBinding?.sessionId),
        recordedBinding =
          (input.dispatchEvents ?? [])
            .filter(
              (value): value is Record<string, unknown> =>
                value !== null && typeof value === "object" && !Array.isArray(value),
            )
            .filter((value) => value.kind === "provider_binding")
            .map((value) => clean(value.providerSessionId))
            .find((value) => value !== null) ?? null,
        event = (input.dispatchEvents ?? []).map(providerEvent).find((candidate) => {
          const expected = declaration.sessionIdentity.eventDiscriminator;
          return candidate && (expected === null || candidate[expected[0]] === expected[1]);
        }),
        eventId = clean(event?.[declaration.sessionIdentity.eventIdField]),
        environmentIds = declaration.sessionIdentity.environmentFields
          .map((field) => clean(input.env?.[field]))
          .filter((value): value is string => value !== null),
        candidates = [binding, recordedBinding, eventId, ...environmentIds].filter(
          (value): value is string => value !== null,
        );
      if (new Set(candidates).size > 1) return unavailableSessionIdentity(input.runtime);
      const sessionId = candidates[0] ?? null;
      return sessionId === null
        ? unavailableSessionIdentity(input.runtime)
        : {
            runtime:
              binding === null && recordedBinding === null && eventId === null ? declaration.kindId : input.runtime,
            sessionId,
            transcriptReachability:
              binding === null && recordedBinding === null && eventId === null
                ? "by_session_id"
                : declaration.sessionIdentity.transcriptReachability,
          };
    },
  };
}

function providerEvent(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.kind === "provider_event" && record.event !== null && typeof record.event === "object"
    ? (record.event as Record<string, unknown>)
    : record;
}
export function resolveSessionIdentity(
  protocolFamily: RuntimeProtocolFamily,
  input: SessionIdentityResolverInput,
): SessionIdentity {
  return sessionIdentityResolverFor(protocolFamily).resolve(input);
}

export function resolveWriteSessionIdentity(
  binding: {
    readonly actor: Parameters<typeof runtimeSessionIdFromActor>[0];
    readonly sessionEnvironment?: SessionIdentityResolverInput["env"];
  },
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeInstallation">,
): SessionIdentity {
  const runtimeSessionId = runtimeSessionIdFromActor(binding.actor);
  if (runtimeSessionId === null) return resolveInteractiveSessionIdentity(binding.sessionEnvironment);
  const session = projection.readRuntimeSession(runtimeSessionId);
  if (session === null) return unavailableSessionIdentity();
  const installation = projection.readRuntimeInstallation(session.installationId);
  if (installation === null) return unavailableSessionIdentity(session.kindId);
  if (session.providerSessionId === null || session.transcriptRef === null)
    return unavailableSessionIdentity(session.kindId);
  return resolveSessionIdentity(installation.protocolFamily, {
    runtime: session.kindId,
    providerBinding: { sessionId: session.providerSessionId, transcriptRef: session.transcriptRef },
  });
}

function resolveInteractiveSessionIdentity(env: SessionIdentityResolverInput["env"]): SessionIdentity {
  if (env === undefined) return unavailableSessionIdentity();
  const resolved = runtimeProtocolFamilies
    .map((protocolFamily) => resolveSessionIdentity(protocolFamily, { runtime: protocolFamily, env }))
    .filter((identity) => identity.sessionId !== null);
  return resolved.length === 1 ? resolved[0]! : unavailableSessionIdentity();
}

export function transcriptRefForSessionIdentity(identity: SessionIdentity, dispatchStreamRef: string): string | null {
  if (identity.sessionId === null) return null;
  return identity.transcriptReachability === "by_session_id"
    ? `provider:${encodeURIComponent(identity.runtime)}/${encodeURIComponent(identity.sessionId)}`
    : identity.transcriptReachability === "dispatch_stream_only" && dispatchStreamRef.startsWith("file:")
      ? dispatchStreamRef
      : null;
}

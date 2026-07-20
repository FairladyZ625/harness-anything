import type {
  RuntimeAttachableEvidence,
  RuntimeAuthenticatedEvidence,
  RuntimeDiscoverySource,
  RuntimeInstalledEvidence,
  RuntimeRunningEvidence
} from "@harness-anything/kernel";
import type {
  AgentRuntimeSessionStatus,
  RuntimeAuthenticationProfileProjection
} from "./agent-runtime-control.ts";

export function executableProbeEvidence(input: {
  readonly source: RuntimeDiscoverySource;
  readonly executablePath: string;
  readonly executable: boolean;
  readonly observedAt: string;
}): RuntimeInstalledEvidence {
  return {
    criterion: "executable-probe",
    state: input.executable,
    reason: input.executable ? "executable-verified" : "executable-not-verified",
    observedAt: input.observedAt,
    observation: {
      kind: "executable-probe",
      source: input.source,
      executablePath: input.executablePath,
      outcome: input.executable ? "executable" : "not-executable"
    }
  };
}

export function authenticationProbeEvidence(
  profiles: ReadonlyArray<RuntimeAuthenticationProfileProjection> | undefined,
  observedAt: string
): RuntimeAuthenticatedEvidence {
  if (!profiles) return { criterion: "authentication-probe", state: "unknown", reason: "authentication-probe-failed", observedAt };
  const authenticated = profiles.find(({ state, assurance }) => state === "configured" && assurance === "authenticated-status");
  if (authenticated) return {
    criterion: "authentication-probe", state: true, reason: "profile-authenticated", observedAt,
    observation: { kind: "authentication-probe", profileKind: authenticated.profileKind, outcome: "authenticated" }
  };
  const invalid = profiles.find(({ state }) => state === "invalid");
  if (invalid) return {
    criterion: "authentication-probe", state: false, reason: "profile-invalid", observedAt,
    observation: { kind: "authentication-probe", profileKind: invalid.profileKind, outcome: "invalid" }
  };
  if (profiles.some(({ state }) => state === "configured")) {
    return { criterion: "authentication-probe", state: "unknown", reason: "authentication-unverified", observedAt };
  }
  return {
    criterion: "authentication-probe", state: false, reason: "profile-not-authenticated", observedAt,
    observation: { kind: "authentication-probe", outcome: "not-authenticated" }
  };
}

export function processProbeEvidence(
  sessions: ReadonlyArray<AgentRuntimeSessionStatus> | undefined,
  observedAt: string
): RuntimeRunningEvidence {
  if (!sessions) return { criterion: "process-probe", state: "unknown", reason: "process-witness-unavailable", observedAt };
  const alive = sessions.find(({ process }) => process.state === "alive");
  if (alive && alive.process.state === "alive") return {
    criterion: "process-probe", state: true, reason: "process-alive", observedAt,
    observation: { kind: "process-probe", outcome: "alive", runtimeSessionId: alive.runtimeSessionId, pid: alive.process.pid }
  };
  return {
    criterion: "process-probe", state: false, reason: "process-not-found", observedAt,
    observation: { kind: "process-probe", outcome: "not-found" }
  };
}

export function attachChannelProbeEvidence(
  sessions: ReadonlyArray<AgentRuntimeSessionStatus> | undefined,
  observedAt: string
): RuntimeAttachableEvidence {
  if (!sessions) return { criterion: "attach-channel-probe", state: "unknown", reason: "attach-channel-probe-failed", observedAt };
  const available = sessions.find(({ attachable }) => attachable);
  return {
    criterion: "attach-channel-probe",
    state: available !== undefined,
    reason: available ? "attach-channel-available" : "attach-channel-unavailable",
    observedAt,
    observation: {
      kind: "attach-channel-probe",
      outcome: available ? "available" : "unavailable",
      ...(available ? { runtimeSessionId: available.runtimeSessionId } : {})
    }
  };
}

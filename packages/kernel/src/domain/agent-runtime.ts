export const runtimeProtocolFamilies = ["stream-json", "json-rpc", "acp", "plain-text"] as const;
export type RuntimeProtocolFamily = (typeof runtimeProtocolFamilies)[number];

export const runtimeCapabilityNames = [
  "discover",
  "spawn",
  "attach",
  "resume",
  "interactive",
  "resize",
  "events"
] as const;
export type RuntimeCapabilityName = (typeof runtimeCapabilityNames)[number];
export type RuntimeCapabilityState = "supported" | "unsupported" | "unknown";
export type RuntimeEvidenceState = boolean | "unknown";

export interface RuntimeCapability {
  readonly name: RuntimeCapabilityName;
  readonly state: RuntimeCapabilityState;
}

export interface RuntimeAuthenticationProfile {
  readonly profileKind: string;
  readonly label: string;
}

export interface RuntimeKind {
  readonly kindId: string;
  readonly displayName: string;
  readonly protocolFamily: RuntimeProtocolFamily;
  readonly executableNames: ReadonlyArray<string>;
  readonly environmentOverride: string;
  readonly appBundleCandidates: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<RuntimeCapability>;
  readonly authenticationProfiles: ReadonlyArray<RuntimeAuthenticationProfile>;
}

export type RuntimeDiscoverySource = "environment-override" | "path" | "login-shell" | "app-bundle";

interface RuntimeEvidenceBase {
  readonly state: RuntimeEvidenceState;
  readonly reason: string;
  readonly observedAt?: string;
}

export interface RuntimeInstalledEvidence extends RuntimeEvidenceBase {
  readonly criterion: "executable-probe";
  readonly reason: "executable-verified" | "executable-not-verified" | "discovery-not-run" | "discovery-probe-failed";
  readonly observation?: {
    readonly kind: "executable-probe";
    readonly source: RuntimeDiscoverySource;
    readonly executablePath: string;
    readonly outcome: "executable" | "not-executable";
  };
}

export interface RuntimeAuthenticatedEvidence extends RuntimeEvidenceBase {
  readonly criterion: "authentication-probe";
  readonly reason: "profile-authenticated" | "profile-not-authenticated" | "profile-invalid" | "authentication-not-probed" | "authentication-unverified" | "authentication-probe-failed";
  readonly observation?: {
    readonly kind: "authentication-probe";
    readonly profileKind?: string;
    readonly outcome: "authenticated" | "not-authenticated" | "invalid";
  };
}

export interface RuntimeRunningEvidence extends RuntimeEvidenceBase {
  readonly criterion: "process-probe";
  readonly reason: "process-alive" | "process-exited" | "process-not-found" | "process-witness-unavailable";
  readonly observation?: {
    readonly kind: "process-probe";
    readonly outcome: "alive" | "exited" | "not-found";
    readonly runtimeSessionId?: string;
    readonly pid?: number;
  };
}

export interface RuntimeAttachableEvidence extends RuntimeEvidenceBase {
  readonly criterion: "attach-channel-probe";
  readonly reason: "attach-channel-available" | "attach-channel-unavailable" | "attach-channel-not-probed" | "attach-channel-probe-failed";
  readonly observation?: {
    readonly kind: "attach-channel-probe";
    readonly outcome: "available" | "unavailable";
    readonly runtimeSessionId?: string;
  };
}

export type RuntimeStateEvidence =
  | RuntimeInstalledEvidence
  | RuntimeAuthenticatedEvidence
  | RuntimeRunningEvidence
  | RuntimeAttachableEvidence;

export interface RuntimeInstallationStates {
  readonly installed: RuntimeInstalledEvidence;
  readonly authenticated: RuntimeAuthenticatedEvidence;
  readonly running: RuntimeRunningEvidence;
  readonly attachable: RuntimeAttachableEvidence;
}

export interface RuntimeInstallation {
  readonly installationId: string;
  readonly kindId: string;
  readonly hostId: "local";
  readonly executablePath: string;
  readonly version?: string;
  readonly discoveredBy: RuntimeDiscoverySource;
  readonly states: RuntimeInstallationStates;
}

export type RuntimeProcessWitness =
  | {
    readonly state: "alive";
    readonly pid: number;
    readonly startedAt: string;
    readonly heartbeatAt?: string;
  }
  | {
    readonly state: "exited";
    readonly pid?: number;
    readonly startedAt?: string;
    readonly heartbeatAt?: string;
    readonly exitedAt: string;
    readonly exitCode?: number | null;
  }
  | {
    readonly state: "unknown";
  };

export interface RuntimeSession {
  readonly runtimeSessionId: string;
  readonly kindId: string;
  readonly installationId: string;
  readonly providerSessionId?: string;
  readonly workdir?: string;
  readonly processWitness: RuntimeProcessWitness;
  readonly attachable: RuntimeAttachableEvidence;
  readonly clientBinding?: {
    readonly assertion: "client-asserted";
    readonly taskId?: string;
    readonly executionId?: string;
  };
}

export interface AgentRuntimeInventory {
  readonly schema: "agent-runtime-inventory/v1";
  readonly generatedAt: string;
  readonly kinds: ReadonlyArray<RuntimeKind>;
  readonly installations: ReadonlyArray<RuntimeInstallation>;
  readonly sessions: ReadonlyArray<RuntimeSession>;
}

function unknownCapabilities(): ReadonlyArray<RuntimeCapability> {
  return runtimeCapabilityNames.map((name) => ({ name, state: name === "discover" ? "supported" : "unknown" }));
}

export const runtimeKindRegistry = [
  {
    kindId: "claude-code",
    displayName: "Claude Code",
    protocolFamily: "stream-json",
    executableNames: ["claude"],
    environmentOverride: "HARNESS_CLAUDE_CODE_PATH",
    appBundleCandidates: ["/Applications/Claude.app/Contents/MacOS/claude"],
    capabilities: unknownCapabilities(),
    authenticationProfiles: [
      { profileKind: "subscription-account", label: "Claude account" },
      { profileKind: "api-key", label: "API key" }
    ]
  },
  {
    kindId: "codex",
    displayName: "Codex",
    protocolFamily: "json-rpc",
    executableNames: ["codex"],
    environmentOverride: "HARNESS_CODEX_PATH",
    appBundleCandidates: ["/Applications/Codex.app/Contents/Resources/codex"],
    capabilities: unknownCapabilities(),
    authenticationProfiles: [
      { profileKind: "chatgpt-account", label: "ChatGPT account" },
      { profileKind: "api-key", label: "API key" }
    ]
  }
] as const satisfies ReadonlyArray<RuntimeKind>;

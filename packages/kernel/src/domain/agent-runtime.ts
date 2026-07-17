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

export interface RuntimeStateEvidence {
  readonly state: RuntimeEvidenceState;
  readonly reason: string;
  readonly observedAt?: string;
}

export interface RuntimeInstallationStates {
  readonly installed: RuntimeStateEvidence;
  readonly authenticated: RuntimeStateEvidence;
  readonly running: RuntimeStateEvidence;
  readonly attachable: RuntimeStateEvidence;
}

export type RuntimeDiscoverySource = "environment-override" | "path" | "login-shell" | "app-bundle";

export interface RuntimeInstallation {
  readonly installationId: string;
  readonly kindId: string;
  readonly hostId: "local";
  readonly executablePath: string;
  readonly version?: string;
  readonly discoveredBy: RuntimeDiscoverySource;
  readonly states: RuntimeInstallationStates;
}

export interface RuntimeProcessWitness {
  readonly state: "alive" | "exited" | "unknown";
  readonly pid?: number;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
  readonly exitedAt?: string;
  readonly exitCode?: number | null;
}

export interface RuntimeSession {
  readonly runtimeSessionId: string;
  readonly kindId: string;
  readonly installationId: string;
  readonly providerSessionId?: string;
  readonly workdir?: string;
  readonly processWitness: RuntimeProcessWitness;
  readonly attachable: RuntimeStateEvidence;
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

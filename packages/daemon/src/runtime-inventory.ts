import type { RuntimeInstallation, RuntimeKind } from "../../kernel/src/index.ts";

export type RuntimeCapabilitySupport = "supported" | "unsupported" | "unverified";
export type RuntimeAuthMode = "subscription" | "api-key";
export interface RuntimeProviderDeclaration {
  readonly kindId: string;
  readonly protocolFamily: RuntimeInstallation["protocolFamily"];
  readonly displayName: string;
  readonly defaultProviderId: string;
  readonly executable: {
    readonly command: string;
    readonly configDirectory: string;
    readonly configHomeEnvironment: string | null;
    readonly authFile: string | null;
    readonly modelProbe: readonly string[];
    readonly modelProbeFormat: "aliases-from-help" | "json-models" | "tabular-models";
  };
  readonly declaredCapabilities: RuntimeInstallation["effectiveCapabilities"];
  readonly configuration: {
    readonly fields: Readonly<Record<string, "identifier" | "url" | "effort" | "boolean" | "headers" | "agy-effort">>;
    readonly publicFields: Readonly<Record<string, string>>;
    readonly publicDefaults: Readonly<Record<string, unknown>>;
  };
  readonly auth: {
    readonly shape: "subscription-only" | "api-override" | "separate";
    readonly modes: readonly RuntimeAuthMode[];
    readonly subscriptionProbe: readonly string[];
    readonly subscriptionProbeTimeoutMs: number;
  };
  readonly isolation: {
    readonly defaultState: "enforced" | "operator-environment";
    readonly states: readonly ("enforced" | "operator-environment")[];
  };
  readonly permissions: { readonly available: boolean; readonly defaultMode: "bypass" };
  readonly launch: {
    readonly input: "argument" | "stdin";
    readonly streamFormat: "stream-json" | "jsonl";
    readonly resumeFlag: string;
    readonly argumentTemplate: readonly string[];
    readonly permissionArgs: Readonly<Record<"bypass" | "workspace-write" | "read-only", readonly string[]>>;
    readonly resumePermissionArgs?: Readonly<Record<"bypass" | "workspace-write" | "read-only", readonly string[]>>;
    readonly apiKeyArgs?: readonly string[];
    readonly fastArgs?: readonly string[];
  };
  readonly sessionIdentity: {
    readonly eventDiscriminator: readonly [string, string] | null;
    readonly eventIdField: string;
    readonly environmentFields: readonly string[];
    readonly transcriptReachability: "by_session_id" | "dispatch_stream_only";
    readonly everyFrame: boolean;
  };
  readonly gui: {
    readonly modelFamily: "open" | "codex-only" | "gemini-only";
    readonly effort: "none" | "free" | "enum";
    readonly effortValues: readonly string[];
  };
  readonly capabilities: Readonly<Record<string, RuntimeCapabilitySupport>>;
}

const sharedCapabilities = {
  resume: "supported",
  streamingOutput: "supported",
  sessionIdEveryFrame: "unsupported",
  modelSelection: "supported",
  authentication: "supported",
} as const;

export const runtimeKinds = [
  {
    kindId: "claude",
    protocolFamily: "claude-compatible",
    displayName: "Claude Code",
    defaultProviderId: "anthropic",
    executable: {
      command: "claude",
      configDirectory: ".claude",
      configHomeEnvironment: "CLAUDE_CONFIG_DIR",
      authFile: ".credentials.json",
      modelProbe: ["--help"],
      modelProbeFormat: "aliases-from-help",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: { effort: "effort", baseUrl: "url" },
      publicFields: { effort: "effort", baseUrl: "baseUrl", baseUrlConfigured: "baseUrlConfigured" },
      publicDefaults: { effort: null, baseUrl: null, baseUrlConfigured: false },
    },
    auth: {
      shape: "api-override",
      modes: ["subscription", "api-key"],
      subscriptionProbe: ["auth", "status", "--json"],
      subscriptionProbeTimeoutMs: 5_000,
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "argument",
      streamFormat: "stream-json",
      resumeFlag: "--resume",
      argumentTemplate: [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "$permission",
        "--model",
        "$model",
        "$effort-flag",
        "$api-auth",
        "$resume",
      ],
      permissionArgs: {
        bypass: ["--permission-mode", "bypassPermissions"],
        "workspace-write": ["--permission-mode", "acceptEdits"],
        "read-only": ["--permission-mode", "plan"],
      },
      apiKeyArgs: ["--bare"],
    },
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "session_id",
      environmentFields: ["CLAUDE_CODE_SESSION_ID"],
      transcriptReachability: "by_session_id",
      everyFrame: false,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      toolAllowlist: "supported",
      toolDenylist: "supported",
      turnLimit: "supported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "unverified",
      effort: "supported",
      mcp: "supported",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "codex",
    protocolFamily: "codex",
    displayName: "Codex",
    defaultProviderId: "openai",
    executable: {
      command: "codex",
      configDirectory: ".codex",
      configHomeEnvironment: "CODEX_HOME",
      authFile: "auth.json",
      modelProbe: ["debug", "models", "--bundled"],
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {
        reasoningEffort: "effort",
        fast: "boolean",
        baseUrl: "url",
        wireApi: "identifier",
        requiresOpenAiAuth: "boolean",
        httpHeaders: "headers",
      },
      publicFields: {
        reasoningEffort: "reasoningEffort",
        fast: "fast",
        baseUrl: "baseUrl",
        baseUrlConfigured: "baseUrlConfigured",
        wireApi: "wire_api",
        requiresOpenAiAuth: "requires_openai_auth",
        httpHeaders: "http_headers",
      },
      publicDefaults: {
        reasoningEffort: null,
        fast: false,
        baseUrl: null,
        baseUrlConfigured: false,
        wire_api: null,
        requires_openai_auth: null,
        http_headers: null,
      },
    },
    auth: {
      shape: "separate",
      modes: ["subscription", "api-key"],
      subscriptionProbe: ["login", "status"],
      subscriptionProbeTimeoutMs: 5_000,
    },
    isolation: { defaultState: "enforced", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "resume",
      argumentTemplate: [
        "exec",
        "$resume-command",
        "--json",
        "$permission",
        "--model",
        "$model",
        "$effort-config",
        "$fast",
        "$session",
        "-",
      ],
      permissionArgs: {
        bypass: ["--sandbox", "danger-full-access"],
        "workspace-write": [
          "--sandbox",
          "workspace-write",
          "--config",
          "sandbox_workspace_write.exclude_tmpdir_env_var=true",
          "--config",
          "sandbox_workspace_write.exclude_slash_tmp=true",
        ],
        "read-only": ["--sandbox", "read-only"],
      },
      resumePermissionArgs: {
        bypass: ["--dangerously-bypass-approvals-and-sandbox"],
        "workspace-write": [
          "--config",
          'sandbox_mode="workspace-write"',
          "--config",
          "sandbox_workspace_write.exclude_tmpdir_env_var=true",
          "--config",
          "sandbox_workspace_write.exclude_slash_tmp=true",
        ],
        "read-only": ["--config", 'sandbox_mode="read-only"'],
      },
      fastArgs: ["--config", 'service_tier="fast"'],
    },
    sessionIdentity: {
      eventDiscriminator: ["type", "thread.started"],
      eventIdField: "thread_id",
      environmentFields: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: false,
    },
    gui: { modelFamily: "codex-only", effort: "free", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "supported",
      approvalEvent: "unverified",
      effort: "supported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "agy",
    protocolFamily: "agy",
    displayName: "AGY (Gemini)",
    defaultProviderId: "google",
    executable: {
      command: "agy",
      configDirectory: ".agy",
      configHomeEnvironment: null,
      authFile: null,
      modelProbe: ["models"],
      modelProbeFormat: "tabular-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: { effort: "agy-effort" },
      publicFields: { effort: "effort" },
      publicDefaults: { effort: null },
    },
    auth: {
      shape: "subscription-only",
      modes: ["subscription"],
      subscriptionProbe: ["models"],
      subscriptionProbeTimeoutMs: 15_000,
    },
    isolation: { defaultState: "operator-environment", states: ["operator-environment"] },
    permissions: { available: false, defaultMode: "bypass" },
    launch: {
      input: "argument",
      streamFormat: "stream-json",
      resumeFlag: "--conversation",
      argumentTemplate: [
        "-p",
        "$prompt",
        "--output-format",
        "stream-json",
        "--model",
        "$model",
        "$permission",
        "$effort-flag",
        "$resume",
      ],
      permissionArgs: { bypass: ["--dangerously-skip-permissions"], "workspace-write": [], "read-only": [] },
    },
    sessionIdentity: {
      eventDiscriminator: ["event", "init"],
      eventIdField: "conversation_id",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: false,
    },
    gui: { modelFamily: "gemini-only", effort: "enum", effortValues: ["low", "medium", "high"] },
    capabilities: {
      ...sharedCapabilities,
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "unsupported",
      permissionVocabulary: "unverified",
      independentSandbox: "unverified",
      approvalEvent: "unsupported",
      effort: "unverified",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
] as const satisfies readonly RuntimeProviderDeclaration[];

export type RuntimeKindId = (typeof runtimeKinds)[number]["kindId"];
export type RuntimeProtocolFamily = (typeof runtimeKinds)[number]["protocolFamily"];
export type RuntimeKindInventory = (typeof runtimeKinds)[number] & RuntimeKind;
export const runtimeKindIds: readonly RuntimeKindId[] = runtimeKinds.map(({ kindId }) => kindId);
export const runtimeProtocolFamilies: readonly RuntimeProtocolFamily[] = runtimeKinds.map(
  ({ protocolFamily }) => protocolFamily,
);
export function isRuntimeKindId(value: unknown): value is RuntimeKindId {
  return typeof value === "string" && runtimeKindIds.some((kindId) => kindId === value);
}

export function runtimeKindForInstallation(installation: RuntimeInstallation): RuntimeKindInventory {
  const found = runtimeKinds.find((kind) => kind.protocolFamily === installation.protocolFamily);
  if (!found) throw new Error(`Unknown runtime protocol family: ${installation.protocolFamily}`);
  return found;
}
export function runtimeKindForId(kindId: string): RuntimeKindInventory {
  const found = runtimeKinds.find((kind) => kind.kindId === kindId);
  if (!found) throw new Error(`Unknown runtime kind: ${kindId}`);
  return found;
}

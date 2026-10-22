// Type-only: a value import would pull the effectful kernel barrel (stable-hash → node:crypto)
// into the GUI renderer bundle. runtimeKindIds is derived from the runtimeKinds catalog below.
import type { RuntimeInstallation, RuntimeKind, RuntimeKindId } from "@harness-anything/kernel";

import {
  type RuntimeAuthMode,
  type RuntimeCapabilitySupport,
  type RuntimeEndpointAvailability,
  type RuntimeProviderDeclaration,
} from "./runtime-inventory-types.ts";

export {
  type RuntimeAuthMode,
  type RuntimeCapabilitySupport,
  type RuntimeEndpointAvailability,
  type RuntimeProviderDeclaration,
};

const sharedCapabilities = {
  resume: "supported",
  streamingOutput: "supported",
  sessionIdEveryFrame: "unsupported",
  modelSelection: "supported",
  authentication: "supported",
} as const;

// ACP agents answer the protocol's `session/cancel` notification by ending the in-flight
// turn, so a steer keeps the session and reprompts in place instead of restarting a CLI.
const acpSteer = { strategy: "cancel-reprompt" } as const;

function acpKind<K extends RuntimeKindId>(
  kindId: K,
  displayName: string,
  command: string,
  argumentTemplate: readonly string[],
  configDirectory: string,
  auth: {
    shape: "subscription-only" | "separate";
    modes: readonly RuntimeAuthMode[];
    subscriptionProbe: readonly string[];
    subscriptionProbeTimeoutMs: number;
    acpAuthMethod?: string;
    acpCredentialKey?: string;
    endpoints?: { baseUrl: RuntimeEndpointAvailability };
  },
  modelFamily: "open" | "codex-only" | "gemini-only" = "open",
  authFile: string | null = null,
): RuntimeProviderDeclaration & { readonly kindId: K } {
  return {
    kindId,
    protocolFamily: "acp",
    displayName,
    defaultProviderId: kindId,
    executable: {
      command,
      configDirectory,
      configHomeEnvironment: null,
      authFile,
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: { fields: {}, publicFields: {}, publicDefaults: {} },
    auth: {
      shape: auth.shape,
      modes: auth.modes,
      subscriptionProbe: auth.subscriptionProbe,
      subscriptionProbeTimeoutMs: auth.subscriptionProbeTimeoutMs,
      endpoints: auth.endpoints ?? { baseUrl: "none" },
      ...(auth.acpAuthMethod ? { acpAuthMethod: auth.acpAuthMethod } : {}),
      ...(auth.acpCredentialKey ? { acpCredentialKey: auth.acpCredentialKey } : {}),
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate,
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily, effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "unverified",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  } as RuntimeProviderDeclaration & { readonly kindId: K };
}

// Codex spells the three permission modes differently for a fresh exec and for `exec resume`:
// resume is a subcommand with its own parser and rejects `--sandbox` outright (exit 2), accepting
// the bypass flag or `-c sandbox_mode=…` instead. Both blocks live here so launch
// (`agent-runtime-launch-config.ts`) and resume (`steer.resumeArgs` below) read one definition;
// a resume argv built from the fresh block dies before the provider ever sees the thread.
const codexFreshPermissionArgs = {
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
  } as const,
  codexResumePermissionArgs = {
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
      // Model aliases resolve inside the CLI, not here: a build older than this floor maps
      // the launch model to an id this catalog no longer selects. Which builds can honor the
      // launch contract is a precondition of it, so it is catalog data alongside the args.
      minimumVersion: "2.1.280",
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
      // The API override sets ANTHROPIC_BASE_URL; empty falls back to the official endpoint.
      endpoints: { baseUrl: "optional" },
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
        // Harness-dispatched workers commit under the repository identity; Claude Code's
        // default commit/PR attribution would violate that, so hide it via --settings.
        "--settings",
        '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
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
    steer: {
      strategy: "interrupt-resume",
      resumeArgs: (args, providerSessionId) => {
        const clean = [...args],
          index = clean.indexOf("--resume");
        if (index >= 0) clean.splice(index, 2);
        return [...clean, "--resume", providerSessionId];
      },
    },
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "session_id",
      environmentFields: ["CLAUDE_CODE_SESSION_ID"],
      transcriptReachability: "by_session_id",
      everyFrame: false,
    },
    // Installed parser 2.1.260 accepts low/medium/high/xhigh/max (capability matrix
    // dimension 12, E-level). `minimal` is deliberately absent: the launcher rewrites
    // it to `low` (agent-runtime-launch-config.ts), so offering it would let the GUI
    // submit a value that never reaches the provider as typed.
    gui: { modelFamily: "open", effort: "enum", effortValues: ["low", "medium", "high", "xhigh", "max"] },
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
        allowInsecureHttp: "boolean",
        wireApi: "identifier",
        requiresOpenAiAuth: "boolean",
        httpHeaders: "headers",
        credentialHeader: "header-name",
      },
      publicFields: {
        reasoningEffort: "reasoningEffort",
        fast: "fast",
        baseUrl: "baseUrl",
        baseUrlConfigured: "baseUrlConfigured",
        allowInsecureHttp: "allow_insecure_http",
        wireApi: "wire_api",
        requiresOpenAiAuth: "requires_openai_auth",
        httpHeaders: "http_headers",
        credentialHeader: "credential_header",
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
      apiKeyIsolation: "enforced",
      subscriptionProbe: ["login", "status"],
      subscriptionProbeTimeoutMs: 5_000,
      // API-key instances write model_providers.<id>.base_url into the generated
      // config.toml; absent means the provider's built-in endpoint.
      endpoints: { baseUrl: "optional" },
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
      permissionArgs: codexFreshPermissionArgs,
      resumePermissionArgs: codexResumePermissionArgs,
      fastArgs: ["--config", 'service_tier="fast"'],
    },
    steer: {
      strategy: "interrupt-resume",
      resumeArgs: (args, providerSessionId) => {
        // `codex exec resume` is a subcommand with its own parser: it rejects `--sandbox`, which is
        // how a fresh exec spells all three modes, and accepts the bypass flag or `-c sandbox_mode`
        // instead. Production argv always carries the launched block contiguously (`$permission` is
        // one template slot), so replace that block in place with the resume block of the same mode.
        // The mode is read back out of the argv rather than passed in: the argv is the only input
        // both call sites (steer, compaction continuation) share, and a separate parameter could
        // disagree with the mode the dispatch launched with. An argv already carrying the resume
        // block (a resumed dispatch steered again) needs no rewrite.
        const clean = [...args],
          execIndex = clean.indexOf("exec"),
          inputIndex = clean.lastIndexOf("-");
        if (execIndex < 0 || inputIndex < execIndex) throw new Error("Codex resume arguments lack exec stdin input.");
        if (clean[execIndex + 1] === "resume") {
          clean.splice(execIndex + 1, 1);
          clean.splice(clean.lastIndexOf("-") - 1, 1);
        }
        const mode = codexPermissionMode(clean);
        if (mode === null) throw new Error("Codex resume arguments carry no declared permission mode.");
        const freshBlock = codexFreshPermissionArgs[mode],
          freshIndex = contiguousIndex(clean, freshBlock);
        if (freshIndex >= 0) clean.splice(freshIndex, freshBlock.length, ...codexResumePermissionArgs[mode]);
        // Fail closed rather than spawn an argv the resume parser is known to reject: a block this
        // transform could not recognise would otherwise turn the dispatch into a `gate_red`.
        if (clean.includes("--sandbox"))
          throw new Error("Codex resume arguments still carry the fresh --sandbox flag.");
        const options = clean.slice(execIndex + 1, clean.lastIndexOf("-"));
        return [...clean.slice(0, execIndex + 1), "resume", ...options, providerSessionId, "-"];
      },
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
      // `agy models` boots a language server, resolves OAuth, then fetches the model
      // list: measured 5-22s end to end, so the probe budget must clear that tail.
      subscriptionProbe: ["models"],
      subscriptionProbeTimeoutMs: 60_000,
      endpoints: { baseUrl: "none" },
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
        "--print-timeout",
        "30m",
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
  {
    kindId: "zcode",
    protocolFamily: "zcode",
    displayName: "ZCode",
    defaultProviderId: "zai",
    executable: {
      command: "zcode",
      configDirectory: ".zcode",
      configHomeEnvironment: null,
      authFile: "v2/credentials.json",
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: { baseUrl: "url" },
      publicFields: { baseUrl: "baseUrl", baseUrlConfigured: "baseUrlConfigured" },
      publicDefaults: { baseUrl: null, baseUrlConfigured: false },
    },
    auth: {
      shape: "separate",
      modes: ["subscription", "api-key"],
      apiKeyIsolation: "enforced",
      subscriptionProbe: ["doctor"],
      subscriptionProbeTimeoutMs: 5_000,
      // API-key instances write provider options.baseURL into the generated
      // cli/config.json; absent means the provider's default endpoint (default: zai).
      endpoints: { baseUrl: "optional" },
    },
    isolation: { defaultState: "enforced", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "argument",
      streamFormat: "stream-json",
      resumeFlag: "--resume",
      // The launcher already executes in the requested cwd; its generic template has no $cwd token.
      argumentTemplate: ["--output-format", "stream-json", "$permission", "--prompt", "$prompt", "$resume"],
      permissionArgs: {
        bypass: ["--mode", "yolo"],
        "workspace-write": ["--mode", "edit"],
        "read-only": ["--mode", "plan"],
      },
    },
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    // ZCode has no catalog probe, so models remain explicit free-form instance configuration.
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "supported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unverified",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "devin",
    protocolFamily: "acp",
    displayName: "Devin",
    defaultProviderId: "devin",
    executable: {
      command: "devin",
      configDirectory: ".local/share/devin",
      configHomeEnvironment: null,
      authFile: "credentials.toml",
      // Requires authentication; exits non-zero when logged out, so a failed
      // probe simply yields no models.
      modelProbe: ["models", "list", "--format", "json"],
      modelProbeFormat: "json-families",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {},
      publicFields: {},
      publicDefaults: {},
    },
    auth: {
      shape: "separate",
      modes: ["subscription", "api-key"],
      // `devin auth status` exits 0 whether or not credentials exist (verified
      // 3000.10.21). The credential the ACP `authenticate` handshake actually
      // consumes is the windsurf_api_key entry in credentials.toml, so presence
      // of that key is the meaningful local readiness check.
      subscriptionProbe: { kind: "file-key" },
      subscriptionProbeTimeoutMs: 10_000,
      acpCredentialKey: "windsurf_api_key",
      // ACP local binary: the key rides authenticate's _meta.api_key; no endpoint exists.
      endpoints: { baseUrl: "none" },
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      // The prompt travels inside session/prompt; the permission mode is applied
      // through session/set_mode; resume is session/load. Only the model rides argv.
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate: ["acp", "--model", "$model"],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      // Every canonical ACP frame carries the session id, so no discriminator.
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "supported",
    },
  },
  {
    kindId: "cursor",
    protocolFamily: "acp",
    displayName: "Cursor",
    defaultProviderId: "cursor",
    executable: {
      command: "cursor-agent",
      configDirectory: ".cursor",
      configHomeEnvironment: null,
      // cli-config.json carries authInfo for `cursor-agent login`; linking it is
      // what makes the ACP `cursor_login` authenticate succeed for instances.
      authFile: "cli-config.json",
      // Models arrive on session/new (models.availableModels); the CLI exposes
      // no model-listing subcommand.
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {},
      publicFields: {},
      publicDefaults: {},
    },
    auth: {
      shape: "subscription-only",
      modes: ["subscription"],
      subscriptionProbe: ["status"],
      subscriptionProbeTimeoutMs: 10_000,
      // `cursor_login` consumes the linked cli-config.json and accepts an empty
      // api_key; it is the only advertised method anyway.
      acpAuthMethod: "cursor_login",
      endpoints: { baseUrl: "none" },
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate: ["acp"],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "codex-acp",
    protocolFamily: "acp",
    displayName: "Codex (ACP)",
    defaultProviderId: "openai",
    executable: {
      // npm bin of @agentclientprotocol/codex-acp; wraps the codex CLI and
      // reuses its CODEX_HOME login.
      command: "codex-acp",
      configDirectory: ".codex",
      configHomeEnvironment: "CODEX_HOME",
      authFile: "auth.json",
      // Models arrive on session/new (models.availableModels); the wrapper
      // exposes no model-listing subcommand.
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {},
      publicFields: {},
      publicDefaults: {},
    },
    auth: {
      shape: "subscription-only",
      modes: ["subscription"],
      // The wrapper has no login-status subcommand; version output is the
      // weakest available presence probe. The ACP `authenticate` handshake is
      // the authoritative check at launch time.
      subscriptionProbe: ["--version"],
      subscriptionProbeTimeoutMs: 10_000,
      // Advertised methods are ["api-key", "chat-gpt"]; the ChatGPT login in
      // the linked auth.json answers "chat-gpt" with an empty api_key.
      acpAuthMethod: "chat-gpt",
      endpoints: { baseUrl: "none" },
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate: [],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    // Reasoning effort is embedded in the session model selector, not a
    // separate launch surface.
    gui: { modelFamily: "codex-only", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "claude-acp",
    protocolFamily: "acp",
    displayName: "Claude (ACP)",
    defaultProviderId: "anthropic",
    executable: {
      // npm bin of @agentclientprotocol/claude-agent-acp; wraps the claude CLI
      // and reuses its CLAUDE_CONFIG_DIR credentials. The adapter advertises no
      // authMethods: the wrapped CLI authenticates from its own login.
      command: "claude-agent-acp",
      configDirectory: ".claude",
      configHomeEnvironment: "CLAUDE_CONFIG_DIR",
      authFile: ".credentials.json",
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {},
      publicFields: {},
      publicDefaults: {},
    },
    auth: {
      shape: "subscription-only",
      modes: ["subscription"],
      subscriptionProbe: ["--version"],
      subscriptionProbeTimeoutMs: 10_000,
      endpoints: { baseUrl: "none" },
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate: [],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      permissionVocabulary: "supported",
      independentSandbox: "unverified",
      approvalEvent: "supported",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  acpKind("copilot", "GitHub Copilot", "copilot", ["--acp"], ".copilot", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "copilot-login",
  }),
  acpKind("auggie", "Auggie CLI", "auggie", ["--acp"], ".auggie", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
  }),
  acpKind("droid", "Factory Droid", "droid", ["exec", "--output-format", "acp-daemon"], ".factory", {
    shape: "separate",
    modes: ["subscription", "api-key"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "factory-api-key",
    acpCredentialKey: "factory_api_key",
  }),
  acpKind("grok", "Grok Build", "grok", ["agent", "stdio"], ".grok", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "grok.com",
  }),
  acpKind("kimi", "Kimi CLI", "kimi", ["acp"], ".kimi", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 15_000,
  }),
  acpKind("qwen-code", "Qwen Code", "qwen", ["--acp"], ".qwen-code", {
    shape: "separate",
    modes: ["api-key"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "openai",
    acpCredentialKey: "openai_api_key",
  }),
  acpKind("minimax-code", "MiniMax Code", "mcode", ["acp"], ".minimax-code", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
  }),
  acpKind("mistral-vibe", "Mistral Vibe", "vibe-acp", [], ".vibe", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "browser-auth",
  }),
  acpKind("junie", "Junie", "junie", ["--acp=true"], ".junie", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
  }),
  acpKind("codebuddy", "Codebuddy Code", "codebuddy", ["--acp"], ".codebuddy", {
    shape: "subscription-only",
    modes: ["subscription"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
  }),
  acpKind("glm-acp", "GLM (ACP)", "glm-acp-agent", [], ".glm-acp-agent", {
    shape: "separate",
    modes: ["subscription", "api-key"],
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    acpAuthMethod: "z-ai-api-key",
  }),
  acpKind("agy-acp", "AGY (ACP)", "agy_acp_server", [], ".gemini", {
    shape: "separate",
    modes: ["subscription", "api-key"],
    subscriptionProbe: ["--notices"],
    subscriptionProbeTimeoutMs: 15_000,
    acpAuthMethod: "gemini-api-key",
  }),
  {
    kindId: "opencode",
    protocolFamily: "acp",
    displayName: "OpenCode",
    defaultProviderId: "opencode",
    executable: {
      // ACP mode needs opencode >= 1.18 (`opencode acp`); older brew builds
      // answer nothing on stdio.
      command: "opencode",
      configDirectory: ".local/share/opencode",
      configHomeEnvironment: null,
      authFile: "auth.json",
      // Models arrive on session/new configOptions; the CLI exposes no
      // model-listing subcommand.
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    declaredCapabilities: ["structured_witness", "resume", "attach", "session_identity"] as const,
    configuration: {
      fields: {},
      publicFields: {},
      publicDefaults: {},
    },
    auth: {
      shape: "subscription-only",
      modes: ["subscription"],
      subscriptionProbe: ["--version"],
      subscriptionProbeTimeoutMs: 10_000,
      // `opencode-login` consumes the linked auth.json and accepts an empty
      // api_key; it is the only advertised method.
      acpAuthMethod: "opencode-login",
      endpoints: { baseUrl: "none" },
    },
    isolation: { defaultState: "operator-environment", states: ["enforced", "operator-environment"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/load",
      argumentTemplate: ["acp"],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "supported",
      // session/new advertises configOptions but no permission modes, so no
      // permission vocabulary can be negotiated.
      permissionVocabulary: "unsupported",
      independentSandbox: "unverified",
      approvalEvent: "unverified",
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
  {
    kindId: "deepseek-harness",
    protocolFamily: "acp",
    displayName: "DeepSeek Harness",
    defaultProviderId: "deepseek",
    executable: {
      // The desktop App's bundled CLI (0.2.1-rc.2); `dsh --profile acp` serves ACP over stdio.
      // The App does not place `dsh` on PATH, so the catalog names the bundle path: discovery
      // resolves it against every PATH entry (path.resolve keeps an absolute command) and the
      // kindId+path key collapses the hits into one installation. Subscription instances reuse
      // the App's $DSH_HOME; API-key instances get a private DSH_HOME and provider patch.
      command: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
      configDirectory: ".dsh",
      configHomeEnvironment: "DSH_HOME",
      authFile: null,
      // The CLI exposes no model-listing subcommand. Subscription selectors are advertised
      // by account route; API-key models come from the instance's profile patch.
      modelProbe: null,
      modelProbeFormat: "json-models",
    },
    // No `resume`: initialize advertises sessionCapabilities.resume but no loadSession, and
    // the shared client speaks session/load only.
    declaredCapabilities: ["structured_witness", "attach", "session_identity"] as const,
    configuration: {
      fields: { baseUrl: "url", wireApi: "identifier" },
      choices: { wireApi: ["openai-completions", "openai-responses", "anthropic-messages"] },
      publicFields: { baseUrl: "baseUrl", baseUrlConfigured: "baseUrlConfigured", wireApi: "wireApi" },
      publicDefaults: { baseUrl: null, baseUrlConfigured: false, wireApi: null },
    },
    auth: {
      shape: "separate",
      modes: ["subscription", "api-key"],
      apiKeyIsolation: "enforced",
      subscriptionIsolation: "operator-environment",
      // initialize advertises authMethods: [] — the App's login is the whole credential story,
      // so presence (--version exits 0 in 0.2s) is the only local readiness check.
      subscriptionProbe: ["--version"],
      subscriptionProbeTimeoutMs: 10_000,
      endpoints: { baseUrl: "optional" },
    },
    // Subscription reuses the App's login. API-key calls use a separate profile and DSH_HOME.
    isolation: { defaultState: "operator-environment", states: ["operator-environment", "enforced"] },
    permissions: { available: true, defaultMode: "bypass" },
    launch: {
      input: "stdin",
      streamFormat: "jsonl",
      resumeFlag: "session/resume",
      argumentTemplate: ["--profile", "acp"],
      permissionArgs: { bypass: [], "workspace-write": [], "read-only": [] },
      // The acp profile has no session modes and takes no flags: its sandbox-policy and
      // user-approval plugins read DSH_PERMISSION_MODE (default workspace-write). Only
      // danger-full-access turns approval off; the other two keep approval=ask, which
      // arrives as session/request_permission and is answered from the permission mode.
      permissionEnvironment: {
        bypass: { DSH_PERMISSION_MODE: "danger-full-access" },
        "workspace-write": { DSH_PERMISSION_MODE: "workspace-write" },
        "read-only": { DSH_PERMISSION_MODE: "read-only" },
      },
    },
    steer: acpSteer,
    sessionIdentity: {
      eventDiscriminator: null,
      eventIdField: "sessionId",
      environmentFields: [],
      transcriptReachability: "dispatch_stream_only",
      everyFrame: true,
    },
    gui: { modelFamily: "open", effort: "none", effortValues: [] },
    capabilities: {
      ...sharedCapabilities,
      resume: "unsupported",
      sessionIdEveryFrame: "supported",
      toolAllowlist: "unsupported",
      toolDenylist: "unsupported",
      turnLimit: "unsupported",
      configurationIsolation: "unsupported",
      permissionVocabulary: "supported",
      // Measured 2026-10-18 (read-only dispatch): the write was denied by the DSH file sandbox
      // itself — "Operation not permitted [sandbox: file access denied under read-only mode]" —
      // with no permission round trip, so enforcement does not depend on the approval event.
      independentSandbox: "supported",
      approvalEvent: "unverified",
      // session/new offers a reasoning_effort selector (off/low/high/max); nothing drives it yet.
      effort: "unsupported",
      mcp: "unverified",
      cwdRestriction: "unverified",
      gracefulCancel: "unverified",
    },
  },
] as const satisfies readonly RuntimeProviderDeclaration[];

export type RuntimeProtocolFamily = (typeof runtimeKinds)[number]["protocolFamily"];
export type RuntimeKindInventory = (typeof runtimeKinds)[number] &
  RuntimeKind & {
    readonly steer?: RuntimeProviderDeclaration["steer"];
  };
export type { RuntimeKindId };
// Catalog-derived, mirroring runtimeProtocolFamilies below; the annotation keeps the
// catalog fail-closed against the kernel vocabulary (an extra kindId fails to compile).
export const runtimeKindIds: readonly RuntimeKindId[] = runtimeKinds.map(({ kindId }) => kindId);
export const runtimeProtocolFamilies: readonly RuntimeProtocolFamily[] = runtimeKinds.map(
  ({ protocolFamily }) => protocolFamily,
);
export function isRuntimeKindId(value: unknown): value is RuntimeKindId {
  return typeof value === "string" && runtimeKindIds.some((kindId) => kindId === value);
}

type CodexPermissionMode = keyof typeof codexFreshPermissionArgs;

const codexSandboxModes: Readonly<Record<string, CodexPermissionMode>> = {
  "danger-full-access": "bypass",
  "workspace-write": "workspace-write",
  "read-only": "read-only",
};

/** The mode an argv carries, whether it still has the fresh block or already the resume block. */
function codexPermissionMode(args: readonly string[]): CodexPermissionMode | null {
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "bypass";
  const sandboxIndex = args.indexOf("--sandbox");
  if (sandboxIndex >= 0) return codexSandboxModes[args[sandboxIndex + 1] ?? ""] ?? null;
  for (const token of args) {
    const match = /^sandbox_mode="(danger-full-access|workspace-write|read-only)"$/u.exec(
      token.startsWith("--config=") ? token.slice("--config=".length) : token,
    );
    if (match) return codexSandboxModes[match[1]!]!;
  }
  return null;
}

/** First index where `block` appears contiguously in `args`, or -1. */
function contiguousIndex(args: readonly string[], block: readonly string[]): number {
  if (block.length === 0) return -1;
  for (let index = 0; index + block.length <= args.length; index += 1)
    if (block.every((token, offset) => args[index + offset] === token)) return index;
  return -1;
}

export function runtimeKindForInstallation(installation: RuntimeInstallation): RuntimeKindInventory {
  // Several kinds can share one protocol family (multiple ACP agents), so the
  // witnessed kindId decides; protocolFamily remains the fallback for
  // installations witnessed before kindId was recorded.
  const found =
    runtimeKinds.find((kind) => kind.kindId === installation.kindId) ??
    runtimeKinds.find((kind) => kind.protocolFamily === installation.protocolFamily);
  if (!found) throw new Error(`Unknown runtime protocol family: ${installation.protocolFamily}`);
  return found;
}
export function runtimeKindForId(kindId: string): RuntimeKindInventory {
  const found = runtimeKinds.find((kind) => kind.kindId === kindId);
  if (!found) throw new Error(`Unknown runtime kind: ${kindId}`);
  return found;
}

/** The configuration key that stores this kind's reasoning effort ("effort" or
 * "reasoningEffort"), or undefined when the kind declares no effort field. The update
 * write path and the edit form both key off this instead of hard-coding kind lists. */
export function runtimeEffortField(kindId: string): string | undefined {
  return Object.entries(runtimeKindForId(kindId).configuration.fields).find(
    ([, shape]) => shape === "effort" || shape === "agy-effort",
  )?.[0];
}

/** Whether this kind delivers effort through its provider config system (a
 * $effort-config launch token) rather than a launch flag. Such kinds materialize the
 * stored effort into the provider config file at launch (writeCodexConfig writes
 * model_reasoning_effort), so their launch args carry only a request-level effort;
 * flag kinds have no other consumption channel and must re-deliver the stored value
 * on every launch. */
export function runtimeEffortRidesProviderConfig(kindId: string): boolean {
  // some() rather than includes(): the catalog's argument templates are literal tuples,
  // and includes() would type its parameter as one kind's token union only.
  return runtimeKindForId(kindId).launch.argumentTemplate.some((token) => token === "$effort-config");
}

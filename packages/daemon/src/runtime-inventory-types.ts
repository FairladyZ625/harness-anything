// The provider declaration contract: the shape every built-in runtime kind
// declares. Split from the runtime-inventory catalog so the contract and the
// data it constrains live in separately-scoped modules; the catalog file
// re-exports these for existing importers.
// Type-only: a value import would pull the effectful kernel barrel (stable-hash → node:crypto)
// into the GUI renderer bundle.
import type { RuntimeInstallation } from "@harness-anything/kernel";

export type RuntimeCapabilitySupport = "supported" | "unsupported" | "unverified";
export type RuntimeAuthMode = "subscription" | "api-key";
export type RuntimeEndpointAvailability = "none" | "optional" | "required";
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
    /** null means the provider exposes no model catalog; discovery leaves catalog fields unavailable. */
    readonly modelProbe: readonly string[] | null;
    readonly modelProbeFormat: "aliases-from-help" | "json-models" | "json-families" | "tabular-models";
  };
  readonly declaredCapabilities: RuntimeInstallation["effectiveCapabilities"];
  readonly configuration: {
    readonly fields: Readonly<
      Record<string, "identifier" | "url" | "effort" | "boolean" | "headers" | "header-name" | "agy-effort">
    >;
    readonly choices?: Readonly<Record<string, readonly string[]>>;
    readonly publicFields: Readonly<Record<string, string>>;
    readonly publicDefaults: Readonly<Record<string, unknown>>;
  };
  readonly auth: {
    readonly shape: "subscription-only" | "api-override" | "separate";
    readonly modes: readonly RuntimeAuthMode[];
    readonly apiKeyIsolation?: "enforced";
    readonly subscriptionIsolation?: "operator-environment";
    /** Command probes run the argv and judge by exit code. A file-key probe checks
     * that the declared `authFile` exists under the provider's config directory and
     * that the `acpCredentialKey` entry is non-empty — for CLIs whose status command
     * exits 0 whether or not credentials exist. */
    readonly subscriptionProbe: readonly string[] | { readonly kind: "file-key" };
    readonly subscriptionProbeTimeoutMs: number;
    /** ACP agents delegate authentication to the host: the client sends the key in
     * `authenticate`'s `_meta.api_key`. API-key instances carry the resolved secret on
     * the launch manifest; subscription instances read this TOML key inside the
     * provider's `configDirectory`/`authFile`. Absent on non-ACP kinds. */
    readonly acpCredentialKey?: string;
    /** ACP agents may advertise several authenticate methods; this picks the one
     * matching the instance's call path (e.g. "chat-gpt" over the advertised
     * "api-key"). Absent means the first advertised method is used. */
    readonly acpAuthMethod?: string;
    /** Endpoint configurability is a per-kind declaration, not derivable from `modes`:
     * an ACP kind can offer an api-key call path (the key rides `authenticate`'s
     * `_meta.api_key`) while having no endpoint concept at all. "required" means the
     * api-key call path cannot launch against a built-in default endpoint. */
    readonly endpoints: { readonly baseUrl: RuntimeEndpointAvailability };
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
    /** Environment the permission mode sets on the provider process, for kinds whose sandbox and
     * approval policy is read from the environment rather than from argv or `session/set_mode`. */
    readonly permissionEnvironment?: Readonly<
      Record<"bypass" | "workspace-write" | "read-only", Readonly<Record<string, string>>>
    >;
    readonly apiKeyArgs?: readonly string[];
    readonly fastArgs?: readonly string[];
  };
  /** How a live turn is redirected. "interrupt-resume" restarts a CLI that only accepts a
   * prompt at launch; "cancel-reprompt" keeps the session and uses the protocol's own cancel
   * notification, which every ACP agent answers by ending the in-flight turn. */
  readonly steer?:
    | {
        readonly strategy: "interrupt-resume";
        readonly resumeArgs: (args: readonly string[], providerSessionId: string) => readonly string[];
      }
    | { readonly strategy: "cancel-reprompt" };
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

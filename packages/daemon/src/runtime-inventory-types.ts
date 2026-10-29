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
    /** Credential path relative to `configDirectory`; a directory is allowed when the
     *  provider keeps its login state across several sibling files (mcode's `auth/`). */
    readonly authFile: string | null;
    /** The Node ABI (`process.versions.modules`) the provider's bundled native addon was
     *  built for, when its entry is a `#!/usr/bin/env node` script. A launch resolves a
     *  matching node from PATH and puts it first; the PATH node that happens to run the
     *  daemon must not decide the provider's ABI. Absent means the entry runs under the
     *  caller's PATH node unchanged. */
    readonly nodeAbi?: number;
    /** null means the provider exposes no model catalog; discovery leaves catalog fields unavailable. */
    readonly modelProbe: readonly string[] | null;
    readonly modelProbeFormat: "aliases-from-help" | "json-models" | "json-families" | "tabular-models";
    /** The oldest CLI build this kind's launch contract is valid against. Absent means the
     *  provider declares no floor. A witnessed build below it cannot be probed ready or
     *  launched: the model tokens and flags this catalog sends are only re-validated by the
     *  provider after it spawns, where the failure is already too late to route around. */
    readonly minimumVersion?: string;
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
     * exits 0 whether or not credentials exist. A json-auth-state probe reads the
     * provider's own login-state document and requires its status field to equal
     * `readyStatus` while its expiry field is still in the future: an exit-0 command
     * cannot tell "signed out" from "signed in" (mcode's `provider list` says
     * `managed login` in an empty HOME too). */
    readonly subscriptionProbe:
      | readonly string[]
      | { readonly kind: "file-key" }
      | {
          readonly kind: "json-auth-state";
          /** Path relative to the provider's config directory. */
          readonly file: string;
          readonly statusField: string;
          readonly readyStatus: string;
          readonly expiresAtField: string;
        };
    readonly subscriptionProbeTimeoutMs: number;
    /** The provider's own sign-in argv per action, for kinds whose CLI exposes a
     * top-level `login`/`logout` rather than `auth login`. Absent keeps the
     * `auth <action>` default. */
    readonly commands?: Readonly<Record<"login" | "logout", readonly string[]>>;
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
    /** What the `$resume`/`$resume-command` template tokens expand to on an argv-resume kind
     * (e.g. `exec resume`, `--resume`). Absent when the protocol itself carries resume: every
     * acp kind resumes through the shared client, which negotiates session/load vs
     * session/resume from the initialize response (runtime-worker-acp.ts). */
    readonly resumeFlag?: string;
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
        /** The provider argv for resuming `providerSessionId`, or null when this dispatch's argv
         * cannot be expressed as a resume command. Null is a settled answer, not an error: the
         * caller keeps the evidence it already has and records the refusal. */
        readonly resumeArgs: (args: readonly string[], providerSessionId: string) => readonly string[] | null;
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

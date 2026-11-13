import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { SettingsV1, AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { AgentRuntimeInstanceDto } from "./agent-runtime-contract.ts";
import { type RuntimeIsolationState, type RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeKindId, RuntimeWebSearchMode } from "./runtime-inventory.ts";

export type RuntimeInstanceKind = RuntimeKindId;

export type RuntimeInstanceAuth =
  | { readonly mode: "subscription" }
  | { readonly mode: "api-key"; readonly credentialRef: string };

export type HostingCredentialRefs = Readonly<{ readonly github?: string; readonly gitlab?: string }>;

export interface RuntimeInstanceCommon {
  readonly schemaVersion: 2;
  readonly instanceId: string;
  readonly name: string;
  readonly installationId: string;
  readonly installationIdentity?: "path-entry/v1";
  readonly providerId: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly enabled: boolean;
  readonly permissionMode?: RuntimePermissionMode;
  readonly isolationState: RuntimeIsolationState;
  readonly auth: RuntimeInstanceAuth;
  /** Disk-only previous-version residue; never used to authorize publication. Remove 2026-12-05. */
  readonly hostingCredentialRefs?: HostingCredentialRefs;
  readonly hostingCredentialRefsByRepo?: Readonly<Record<string, HostingCredentialRefs>>;
}

export interface ClaudeRuntimeInstanceConfig {
  readonly effort?: string;
  readonly baseUrl?: string;
}

export interface CodexRuntimeInstanceConfig {
  readonly reasoningEffort?: string;
  readonly fast?: boolean;
  /** Native hosted-search tier. Absent means disabled; launch always states it explicitly. */
  readonly webSearch?: RuntimeWebSearchMode;
  readonly baseUrl?: string;
  readonly allowInsecureHttp?: boolean;
  readonly wireApi?: string;
  readonly requiresOpenAiAuth?: boolean;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  /** Header name receiving the resolved API-key credential at launch time. */
  readonly credentialHeader?: string;
}

export interface AgyRuntimeInstanceConfig {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type RuntimeInstanceConfig = RuntimeInstanceCommon & {
  readonly kindId: RuntimeInstanceKind;
  readonly [field: string]: unknown;
};

export interface RuntimeProviderInstanceConfig {
  readonly [field: string]: unknown;
  readonly effort?: string;
  readonly reasoningEffort?: string;
  readonly fast?: boolean;
  readonly webSearch?: RuntimeWebSearchMode;
  readonly baseUrl?: string;
  readonly allowInsecureHttp?: boolean;
  readonly wireApi?: string;
  readonly requiresOpenAiAuth?: boolean;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  readonly credentialHeader?: string;
}

export function runtimeProviderConfig(config: RuntimeInstanceConfig): RuntimeProviderInstanceConfig {
  const value = config[config.kindId];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Runtime instance ${config.instanceId} has no ${config.kindId} configuration.`);
  return value as RuntimeProviderInstanceConfig;
}

export interface RuntimeInstallationWitness {
  readonly installationId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly executableEntryPath?: string;
  readonly executablePath: string;
  readonly version: string;
  readonly observedAt: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  /** Models whose provider catalog advertises native hosted search. Absent means the
   *  capability was not witnessed; an opt-in search tier fails closed on that absence. */
  readonly searchCapableModels?: readonly string[];
}

/** What a registry lookup needs from a witness: the two fields that identify an installation. */
export type RuntimeInstallationIdentity = Pick<RuntimeInstallationWitness, "installationId" | "kindId">;

/** A witness as the node records it. Host paths are not part of the record: the list receipt
 *  deliberately reports installations "without secrets or host paths", and no read needs the
 *  absolute executable of an observation that already happened. */
export type RecordedRuntimeInstallation = Pick<
  RuntimeInstallationWitness,
  "installationId" | "kindId" | "version" | "observedAt" | "models" | "defaultModel" | "searchCapableModels"
>;

export interface RuntimeAuthReadiness {
  readonly status: OperationalStatus.RuntimeAuthReadinessStatus;
  readonly code: string | null;
  readonly hint: string | null;
  /**
   * What a ready verdict observed. `"metadata"` means the local login record or credential
   * exists; `"provider"` means an authenticated request completed. Absent when nothing was
   * probed (and on the not-ready path).
   */
  readonly basis?: "metadata" | "provider";
}

export type RuntimeInstanceSummary = AgentRuntimeInstanceDto;

/** What a spawner asks the machine instance store to prepare for one runtime launch. */
export interface RuntimeLaunchRequest {
  readonly cwd: string;
  readonly prompt: string;
  /** One daemon-computed Unix callback endpoint authorized for this dispatch only. */
  readonly callbackRelayPath?: string;
  /** Effective project rules, resolved once for the selected agent by the common spawner. */
  readonly commandInterceptions?: SettingsV1["runtime"]["commandInterceptions"];
  readonly model?: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly providerSessionId?: string;
  readonly permissionMode?: string;
  readonly runtimeSessionId?: string;
  /**
   * The Settings `runtime.providerHandshakeTimeoutMs` value. It rides the launch to the ACP worker
   * host, whose process does not share the daemon's settings reader.
   */
  readonly handshakeTimeoutMs?: number;
  /** Attempt-scoped loopback relay credentials; the worker receives only this token. */
  readonly cloudRelay?: {
    readonly baseUrl: string;
    readonly token: string;
  };
}

export interface PreparedRuntimeLaunch {
  readonly definition: AgentDefinitionSnapshot;
  readonly installation: RuntimeInstallationWitness;
  readonly protocolFamily: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly prompt: string;
  readonly providerSessionId?: string;
  readonly permissionMode?: RuntimePermissionMode;
  /** Resolved API key delivered to the ACP client for `authenticate`; never enters the provider's environment. */
  readonly acpApiKey?: string;
  /** The caller's ACP handshake deadline; acp-family launches carry it to the worker host. */
  readonly handshakeTimeoutMs?: number;
  /** The selected model, delivered to ACP agents through `session/set_config_option`; argv-driven kinds carry it in `args`. */
  readonly model?: string;
  /**
   * Set when the operator's GitHub login could not be read. The launch proceeds without the
   * credential; the spawn receipt carries this sentence so the operator learns why the worker
   * cannot publish instead of meeting a credential error later at `ha task push`.
   */
  readonly githubCredentialNotice?: string;
}

export interface PreparedRuntimeAuthCommand {
  readonly instanceId: string;
  readonly name: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

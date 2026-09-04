import type { AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { AgentRuntimeInstanceDto } from "./agent-runtime-contract.ts";
import { type RuntimeIsolationState, type RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeKindId } from "./runtime-inventory.ts";

export type RuntimeInstanceKind = RuntimeKindId;

export type RuntimeInstanceAuth =
  | { readonly mode: "subscription" }
  | { readonly mode: "api-key"; readonly credentialRef: string };

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
  readonly githubCredentialRef?: string;
}

export interface ClaudeRuntimeInstanceConfig {
  readonly effort?: string;
  readonly baseUrl?: string;
}

export interface CodexRuntimeInstanceConfig {
  readonly reasoningEffort?: string;
  readonly fast?: boolean;
  readonly baseUrl?: string;
  readonly wireApi?: string;
  readonly requiresOpenAiAuth?: boolean;
  readonly httpHeaders?: Readonly<Record<string, string>>;
}

export interface AgyRuntimeInstanceConfig {
  readonly effort?: "low" | "medium" | "high";
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
  readonly baseUrl?: string;
  readonly wireApi?: string;
  readonly requiresOpenAiAuth?: boolean;
  readonly httpHeaders?: Readonly<Record<string, string>>;
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
}

export interface RuntimeAuthReadiness {
  readonly status: "ready" | "not-ready";
  readonly code: string | null;
  readonly hint: string | null;
}

export type RuntimeInstanceSummary = AgentRuntimeInstanceDto;

export interface PreparedRuntimeLaunch {
  readonly definition: AgentDefinitionSnapshot;
  readonly installation: RuntimeInstallationWitness;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly prompt: string;
  readonly providerSessionId?: string;
}

export interface PreparedRuntimeAuthCommand {
  readonly instanceId: string;
  readonly name: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

import { isCredentialReferenceText } from "./agent-runtime-credential-port.ts";
import type {
  AgyRuntimeInstanceConfig,
  ClaudeRuntimeInstanceConfig,
  CodexRuntimeInstanceConfig,
  RuntimeAuthReadiness,
  RuntimeInstanceAuth,
  RuntimeInstanceCommon,
  RuntimeInstanceConfig,
  RuntimeInstanceKind,
} from "./agent-runtime-instance-types.ts";
import { runtimeProviderConfig } from "./agent-runtime-instance-types.ts";
import { secureRuntimeBaseUrl } from "./agent-runtime-launch-config.ts";
import { runtimeIsolationState, runtimePermissionMode } from "./runtime-permissions.ts";
import {
  isRuntimeKindId,
  runtimeKindForId,
  runtimeKindIds,
  type RuntimeProviderDeclaration,
} from "./runtime-inventory.ts";

export type LegacyRuntimeInstanceConfig = {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly name: string;
  readonly kindId: RuntimeInstanceKind;
  readonly installationId: string;
  readonly providerId: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly baseUrl?: string;
  readonly auth: RuntimeInstanceAuth;
};

export type FlatRuntimeInstanceConfig = Omit<RuntimeInstanceCommon, "schemaVersion"> & {
  readonly schemaVersion: 2;
  readonly kindId: RuntimeInstanceKind;
  readonly reasoningEffort?: string;
  readonly baseUrl?: string;
};

export function runtimeInstanceConfig(value: unknown): RuntimeInstanceConfig {
  if (!isRuntimeInstanceRecord(value))
    throw runtimeInstanceError("invalid_runtime_instance", "Runtime instance must be an object.");
  const legacy = value.schemaVersion === 1,
    kindIdValue = value.kindId,
    flat = typeof kindIdValue !== "string" || value[kindIdValue] === undefined,
    allowed = legacy
      ? [
          "schemaVersion",
          "instanceId",
          "name",
          "kindId",
          "installationId",
          "installationIdentity",
          "providerId",
          "model",
          "reasoningEffort",
          "baseUrl",
          "auth",
        ]
      : [
          "schemaVersion",
          "instanceId",
          "name",
          "kindId",
          "installationId",
          "installationIdentity",
          "providerId",
          "models",
          "defaultModel",
          "enabled",
          "permissionMode",
          "isolationState",
          "reasoningEffort",
          "baseUrl",
          ...runtimeKindIds,
          "auth",
          "githubCredentialRef",
        ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    (value.installationIdentity !== undefined && value.installationIdentity !== "path-entry/v1") ||
    !isRuntimeKindId(value.kindId) ||
    !isRuntimeInstanceRecord(value.auth)
  )
    throw runtimeInstanceError("invalid_runtime_instance", "Runtime instance metadata is invalid.");
  const other = runtimeKindIds.find((candidate) => candidate !== value.kindId && value[candidate] !== undefined);
  if (other) {
    throw runtimeInstanceError(
      "invalid_runtime_kind_config",
      `${value.kindId} runtime instance cannot include ${other} configuration.`,
    );
  }
  const auth = (
    value.auth.mode === "subscription" && Object.keys(value.auth).length === 1
      ? { mode: "subscription" as const }
      : value.auth.mode === "api-key" && Object.keys(value.auth).every((key) => ["mode", "credentialRef"].includes(key))
        ? {
            mode: "api-key" as const,
            credentialRef: credentialReference(value.auth.credentialRef),
          }
        : null
  ) as RuntimeInstanceAuth | null;
  const declaration = runtimeKindForId(value.kindId);
  if (!auth || !declaration.auth.modes.some((mode) => mode === auth.mode))
    throw runtimeInstanceError(
      "invalid_runtime_auth",
      `${value.kindId} runtime instances do not support ${String(value.auth.mode)} authentication.`,
    );
  const models = legacy ? [requiredRuntimeInstanceText(value.model, "model")] : normalizeModels(value.models),
    defaultModel = legacy ? models[0]! : requiredRuntimeInstanceText(value.defaultModel, "defaultModel"),
    enabled = legacy ? true : requireBoolean(value.enabled, "enabled");
  if (!models.includes(defaultModel))
    throw runtimeInstanceError(
      "invalid_runtime_model",
      `Default model ${defaultModel} is not in the instance model set. Supported models: ${models.join(", ")}.`,
    );
  const kindId = String(value.kindId) as RuntimeInstanceKind,
    permissionMode = runtimePermissionMode(value.permissionMode, kindId),
    isolationState = runtimeIsolationState(value.isolationState, kindId);
  if (kindId === "codex" && auth.mode === "api-key" && isolationState === "operator-environment")
    throw runtimeInstanceError(
      "invalid_runtime_isolation",
      [
        "API-key codex instances require enforced isolation; the bearer token is ",
        "injected through the per-instance CODEX_HOME config, and the operator ",
        "environment would have to rewrite the operator's own config.toml.",
      ].join(""),
    );
  const common = {
    schemaVersion: 2 as const,
    instanceId: runtimeInstanceId(value.instanceId),
    name: requiredRuntimeInstanceText(value.name, "name"),
    installationId: identifier(value.installationId, "installationId"),
    ...(value.installationIdentity === "path-entry/v1" ? { installationIdentity: "path-entry/v1" as const } : {}),
    providerId: identifier(value.providerId, "providerId"),
    models,
    defaultModel,
    enabled,
    ...(permissionMode ? { permissionMode } : {}),
    isolationState,
    auth,
    ...(value.githubCredentialRef === undefined
      ? {}
      : { githubCredentialRef: credentialReference(value.githubCredentialRef, "githubCredentialRef") }),
  };
  const effortField = "reasoningEffort" in declaration.configuration.fields ? "reasoningEffort" : "effort",
    flatConfiguration = {
      ...(value.reasoningEffort === undefined ? {} : { [effortField]: value.reasoningEffort }),
      ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    },
    configuration = runtimeKindConfig(
      flat ? flatConfiguration : normalizeRuntimeInputAliases(value[value.kindId], declaration.configuration.fields),
      declaration.configuration.fields,
    );
  if (
    common.providerId === "openai" &&
    (configuration.wireApi !== undefined ||
      configuration.requiresOpenAiAuth !== undefined ||
      configuration.httpHeaders !== undefined)
  )
    throw runtimeInstanceError(
      "invalid_runtime_kind_config",
      [
        "The built-in openai provider cannot accept a custom wireApi, ",
        "requiresOpenAiAuth, or httpHeaders; use a distinct providerId.",
      ].join(""),
    );
  return { ...common, kindId, [kindId]: configuration } as RuntimeInstanceConfig;
}

function normalizeRuntimeInputAliases(
  value: unknown,
  fields: RuntimeProviderDeclaration["configuration"]["fields"],
): unknown {
  if (!isRuntimeInstanceRecord(value) || !("reasoningEffort" in fields) || value.effort === undefined) return value;
  const { effort, ...rest } = value;
  return { ...rest, reasoningEffort: effort };
}

function runtimeKindConfig(
  value: unknown,
  fields: Readonly<Record<string, "identifier" | "url" | "effort" | "boolean" | "headers" | "agy-effort">>,
): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!isRuntimeInstanceRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(fields, key)))
    throw runtimeInstanceError(
      "invalid_runtime_kind_config",
      `Runtime configuration accepts only ${Object.keys(fields).join(", ") || "no fields"}.`,
    );
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        const shape = fields[key]!;
        if (shape === "boolean") return [key, requireBoolean(item, key)];
        if (shape === "headers") return [key, runtimeHttpHeaders(item)];
        if (shape === "agy-effort") return [key, agyEffort(item)];
        if (shape === "url") return [key, secureRuntimeBaseUrl(item)];
        if (shape === "identifier") return [key, identifier(item, key)];
        return [key, runtimeEffort(item)];
      }),
  );
}

export function claudeRuntimeConfig(value: unknown): ClaudeRuntimeInstanceConfig {
  if (value === undefined) return {};
  if (!isRuntimeInstanceRecord(value) || Object.keys(value).some((key) => !["effort", "baseUrl"].includes(key)))
    throw runtimeInstanceError("invalid_runtime_kind_config", "claude configuration accepts only effort and baseUrl.");
  const effort = value.effort === undefined ? undefined : runtimeEffort(value.effort),
    baseUrl = value.baseUrl === undefined ? undefined : secureRuntimeBaseUrl(value.baseUrl);
  return {
    ...(effort ? { effort } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function codexRuntimeConfig(value: unknown): CodexRuntimeInstanceConfig {
  if (value === undefined) return {};
  if (
    !isRuntimeInstanceRecord(value) ||
    Object.keys(value).some(
      (key) => !["reasoningEffort", "fast", "baseUrl", "wireApi", "requiresOpenAiAuth", "httpHeaders"].includes(key),
    )
  )
    throw runtimeInstanceError(
      "invalid_runtime_kind_config",
      "codex configuration accepts only reasoningEffort, fast, baseUrl, wireApi, requiresOpenAiAuth, and httpHeaders.",
    );
  const effort = value.reasoningEffort === undefined ? undefined : runtimeEffort(value.reasoningEffort),
    fast = value.fast === undefined ? undefined : requireBoolean(value.fast, "fast"),
    baseUrl = value.baseUrl === undefined ? undefined : secureRuntimeBaseUrl(value.baseUrl),
    wireApi = value.wireApi === undefined ? undefined : identifier(value.wireApi, "wireApi"),
    requiresOpenAiAuth =
      value.requiresOpenAiAuth === undefined
        ? undefined
        : requireBoolean(value.requiresOpenAiAuth, "requiresOpenAiAuth"),
    httpHeaders = value.httpHeaders === undefined ? undefined : runtimeHttpHeaders(value.httpHeaders);
  return {
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(fast === undefined ? {} : { fast }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(wireApi ? { wireApi } : {}),
    ...(requiresOpenAiAuth === undefined ? {} : { requiresOpenAiAuth }),
    ...(httpHeaders ? { httpHeaders } : {}),
  };
}

export function agyRuntimeConfig(value: unknown): AgyRuntimeInstanceConfig {
  if (value === undefined) return {};
  if (!isRuntimeInstanceRecord(value) || Object.keys(value).some((key) => key !== "effort"))
    throw runtimeInstanceError("invalid_runtime_kind_config", "agy configuration accepts only effort.");
  return value.effort === undefined ? {} : { effort: agyEffort(value.effort) };
}

export function runtimeHttpHeaders(value: unknown): Readonly<Record<string, string>> {
  if (!isRuntimeInstanceRecord(value) || Object.keys(value).length === 0)
    throw runtimeInstanceError(
      "invalid_runtime_http_headers",
      "httpHeaders must be a non-empty object of non-secret HTTP headers.",
    );
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      /(?:authorization|api[-_]?key|cookie|credential|password|secret|token)/iu.test(name) ||
      typeof item !== "string" ||
      !item ||
      /[\r\n]/u.test(item)
    )
      throw runtimeInstanceError(
        "invalid_runtime_http_headers",
        "httpHeaders must contain valid non-secret header names and single-line values.",
      );
    result[name] = item;
  }
  return result;
}

export function needsRuntimeInstanceNormalization(value: unknown): boolean {
  return (
    isRuntimeInstanceRecord(value) &&
    (value.schemaVersion === 1 ||
      (typeof value.kindId === "string" && value[value.kindId] === undefined) ||
      value.reasoningEffort !== undefined ||
      value.baseUrl !== undefined ||
      value.permissionMode === undefined ||
      value.isolationState === undefined)
  );
}

export function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw runtimeInstanceError("invalid_runtime_model", "Runtime instance models must be a non-empty array.");
  const models = value.map((model) => requiredRuntimeInstanceText(model, "model")),
    unique = [...new Set(models)];
  if (unique.length !== models.length)
    throw runtimeInstanceError("invalid_runtime_model", "Runtime instance models must not contain duplicates.");
  return unique;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw runtimeInstanceError("invalid_runtime_instance", `${field} must be boolean.`);
  return value;
}

export function selectRuntimeModel(config: RuntimeInstanceConfig, requested?: string): string {
  const model = requested === undefined ? config.defaultModel : requiredRuntimeInstanceText(requested, "model");
  if (!config.models.includes(model))
    throw runtimeInstanceError(
      "invalid_runtime_model",
      [
        "Model ",
        `${model}`,
        " is not available on runtime instance ",
        `${config.instanceId}`,
        ". Supported models: ",
        `${config.models.join(", ")}`,
        ".",
      ].join(""),
    );
  return model;
}

export function selectRuntimeEffort(config: RuntimeInstanceConfig, requested?: string): string | null {
  const provider = runtimeProviderConfig(config),
    effort = requested ?? provider.reasoningEffort ?? provider.effort;
  if (effort === undefined) return null;
  const fields = runtimeKindForId(config.kindId).configuration.fields;
  if ("effort" in fields && fields.effort === "agy-effort") return agyEffort(effort);
  return runtimeEffort(effort);
}

export function selectRuntimeFast(config: RuntimeInstanceConfig, requested?: boolean): boolean {
  const fast = requested ?? runtimeProviderConfig(config).fast ?? false;
  if (!fast) return false;
  const fields = runtimeKindForId(config.kindId).configuration.fields;
  if (!("fast" in fields) || fields.fast !== "boolean")
    throw runtimeInstanceError(
      "invalid_runtime_fast",
      `Fast mode is not supported by ${config.kindId} runtime instances.`,
    );
  return true;
}

export function runtimeEffort(value: unknown): string {
  const effort = typeof value === "string" ? value.trim() : "";
  if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
    throw runtimeInstanceError(
      "invalid_runtime_effort",
      `Reasoning effort ${String(value)} is not supported; use minimal, low, medium, high, xhigh, or max.`,
    );
  return effort;
}

export function agyEffort(value: unknown): "low" | "medium" | "high" {
  const effort = typeof value === "string" ? value.trim() : "";
  if (!["low", "medium", "high"].includes(effort))
    throw runtimeInstanceError(
      "invalid_runtime_effort",
      `agy reasoning effort ${String(value)} is not supported; use low, medium, or high.`,
    );
  return effort as "low" | "medium" | "high";
}

export function runtimeInstanceId(value: unknown): string {
  const id = requiredRuntimeInstanceText(value, "instanceId");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id))
    throw runtimeInstanceError("invalid_runtime_instance_id", "instanceId must be lowercase kebab-case.");
  return id;
}

export function identifier(value: unknown, field: string): string {
  const text = requiredRuntimeInstanceText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(text))
    throw runtimeInstanceError("invalid_runtime_instance", `${field} is invalid.`);
  return text;
}

export function credentialReference(value: unknown, field = "credentialRef"): string {
  const text = requiredRuntimeInstanceText(value, field);
  if (!isCredentialReferenceText(text))
    throw runtimeInstanceError(
      "invalid_credential_reference",
      `${field} must be an opaque credential:v1 reference (legacy keychain: references resolve on macOS only).`,
    );
  return text;
}

export function requiredRuntimeInstanceText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length) return value.trim();
  throw runtimeInstanceError("invalid_runtime_instance", `${field} is required.`);
}

export function isRuntimeInstanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runtimeInstanceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function available(): RuntimeAuthReadiness {
  return { status: "ready", code: null, hint: null };
}

export function unavailable(code: string, hint: string): RuntimeAuthReadiness {
  return { status: "not-ready", code, hint };
}

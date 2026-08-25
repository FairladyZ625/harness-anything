import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { identifier, runtimeInstanceError, unavailable } from "./agent-runtime-instance-config.ts";
import type {
  RuntimeAuthReadiness,
  RuntimeInstallationWitness,
  RuntimeInstanceConfig,
  RuntimeInstanceKind,
  RuntimeInstanceSummary,
} from "./agent-runtime-instance-types.ts";

export function migrateLegacyInstallationIdentities(
  instances: readonly RuntimeInstanceConfig[],
  witnessed: readonly RuntimeInstallationWitness[],
): RuntimeInstanceConfig[] {
  return instances.map((config) => {
    if (config.installationIdentity === "path-entry/v1") return config;
    const candidates = witnessed.filter((installation) => installation.kindId === config.kindId);
    return candidates.length === 1
      ? {
          ...config,
          installationId: candidates[0]!.installationId,
          installationIdentity: "path-entry/v1",
        }
      : config;
  });
}

export function requireWitnessedInstallation(
  kindId: RuntimeInstanceKind,
  value: unknown,
  witnessed: readonly RuntimeInstallationWitness[],
): RuntimeInstallationWitness {
  const installationId = identifier(value, "installationId"),
    installation = witnessed.find(
      (candidate) => candidate.installationId === installationId && candidate.kindId === kindId,
    );
  if (installation) return installation;
  const candidates = witnessed.filter((candidate) => candidate.kindId === kindId),
    available = candidates.length
      ? ` Available ${kindId} installations: ${candidates.map(installationLabel).join(", ")}.`
      : ` No ${kindId} installation is currently witnessed.`;
  throw runtimeInstanceError(
    "runtime_installation_not_found",
    [
      "Runtime installation ",
      `${installationId}`,
      " is not currently witnessed for ",
      `${kindId}`,
      ".",
      `${available}`,
      " Run ha runtime instance list and retry with --installation ",
      "<installation-id>.",
    ].join(""),
  );
}

export function missingInstallationHint(
  config: RuntimeInstanceConfig,
  witnessed: readonly RuntimeInstallationWitness[],
): string {
  const prefix = `Runtime installation ${config.installationId} is no longer witnessed for ${config.kindId}.`,
    candidates = witnessed.filter((installation) => installation.kindId === config.kindId);
  if (candidates.length === 0)
    return [
      "",
      `${prefix}`,
      " Run ha runtime instance list; after a ",
      `${config.kindId}`,
      " installation is witnessed, run ha runtime instance update ",
      `${config.instanceId}`,
      " --installation <installation-id>.",
    ].join("");
  if (candidates.length === 1)
    return [
      "",
      `${prefix}`,
      " Witnessed candidate: ",
      `${installationLabel(candidates[0]!)}`,
      ". Run ha runtime instance update ",
      `${config.instanceId}`,
      " --installation ",
      `${candidates[0]!.installationId}`,
      ".",
    ].join("");
  const updateCommands = candidates
    .map(({ installationId }) => `ha runtime instance update ${config.instanceId} --installation ${installationId}`)
    .join("; ");
  return [
    "",
    `${prefix}`,
    " Witnessed candidates: ",
    `${candidates.map(installationLabel).join(", ")}`,
    ". Run one of: ",
    updateCommands,
    ".",
  ].join("");
}

export function installationLabel(installation: RuntimeInstallationWitness): string {
  return `${installation.installationId} (${installation.version})`;
}

export function publicConfig(
  config: RuntimeInstanceConfig,
  authReadiness: RuntimeAuthReadiness = unavailable(
    "runtime_auth_not_checked",
    "Authentication has not been verified in this daemon generation.",
  ),
): RuntimeInstanceSummary {
  const common = {
    schemaVersion: config.schemaVersion,
    instanceId: config.instanceId,
    name: config.name,
    installationId: config.installationId,
    providerId: config.providerId,
    models: config.models,
    defaultModel: config.defaultModel,
    enabled: config.enabled,
    permissionMode: config.permissionMode ?? null,
    authMode: config.auth.mode,
    authState:
      config.auth.mode === "api-key"
        ? ("configured" as const)
        : authReadiness.status === "ready"
          ? ("authenticated" as const)
          : authReadiness.code === "runtime_subscription_required"
            ? ("unauthenticated" as const)
            : ("unknown" as const),
    authReadiness,
    ...(config.githubCredentialRef === undefined ? {} : { githubCredentialState: "configured" as const }),
    isolationState: config.isolationState,
  };
  if (config.kindId === "claude")
    return {
      ...common,
      kindId: "claude",
      claude: {
        baseUrl: config.claude.baseUrl ?? null,
        baseUrlConfigured: config.claude.baseUrl !== undefined,
      },
    };
  if (config.kindId === "codex")
    return {
      ...common,
      kindId: "codex",
      codex: {
        reasoningEffort: config.codex.reasoningEffort ?? null,
        baseUrl: config.codex.baseUrl ?? null,
        baseUrlConfigured: config.codex.baseUrl !== undefined,
        wire_api: config.codex.wireApi ?? null,
        requires_openai_auth: config.codex.requiresOpenAiAuth ?? null,
        http_headers: config.codex.httpHeaders ?? null,
      },
    };
  return {
    ...common,
    kindId: "agy",
    agy: { effort: config.agy.effort ?? null },
  };
}

export function definitionSnapshot(
  config: RuntimeInstanceConfig,
  model: string,
  effort: string | null,
): AgentDefinitionSnapshot {
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: config.instanceId,
    installationId: config.installationId,
    kindId: config.kindId,
    providerId: config.providerId,
    model,
    reasoningEffort: effort,
    baseUrl: runtimeBaseUrl(config) ?? null,
    authMode: config.auth.mode,
  };
}

export function providerConfigDirectory(home: string, kindId: RuntimeInstanceKind): string {
  return path.join(home, kindId === "codex" ? ".codex" : kindId === "agy" ? ".agy" : ".claude");
}

// Operator-login reuse under enforced isolation, after Multica's per-task CODEX_HOME
// shape (fact F-8A1A2D66): the provider's credential file alone links back to the
// operator's shared provider home so login and token refreshes propagate, while the
// generated config and skill mounts stay inside the per-instance state root. Only
// subscription instances link: an api-key instance's credential is the broker key
// in the generated config (codex 0.147.0 sends that bearer even with auth.json
// present — a custom provider without one sends no Authorization header at all),
// so the operator's subscription file there would be dead weight and a footgun. A
// missing operator file is a no-op, leaving any instance-local login in place. The
// diagnosis surface is the file kind alone — lstat/readlink of runtime-instances/
// <id>/home/<kind>/<authFile> says symlink (with target) or copy; contents are never
// read into memory or logged, and the copy fallback streams file-to-file.
export function providerAuthFile(kindId: RuntimeInstanceKind): string | null {
  return kindId === "codex" ? "auth.json" : kindId === "claude" ? ".credentials.json" : null;
}

export function sharedProviderDirectory(
  env: NodeJS.ProcessEnv,
  kindId: RuntimeInstanceKind,
  platform: NodeJS.Platform,
): string | null {
  const explicit = kindId === "codex" ? env.CODEX_HOME : kindId === "claude" ? env.CLAUDE_CONFIG_DIR : undefined;
  if (explicit) return path.resolve(explicit);
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  return home ? providerConfigDirectory(path.resolve(home), kindId) : null;
}

// Ensures dst tracks the operator's src across re-ensures (create, update, auth
// probes, login, every launch): a correct symlink stays, anything else — a
// wrong-target link, or a stale copy left by a platform where symlinks fail — is
// dropped and re-created so a once-stale copy can never stick (Multica issue
// #2081). Symlink failure falls back to a 0600 copy (Windows without Developer
// Mode); if even that fails, sharing is best-effort skipped and the provider's own
// subscription probe reports the consequence instead of failing the launch.
export function ensureSharedAuthFile(src: string, dst: string): void {
  if (!existsSync(src)) return;
  const existing = lstatSync(dst, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && readlinkSync(dst) === src) return;
  try {
    if (existing) rmSync(dst, { force: true, maxRetries: 5, retryDelay: 20 });
    symlinkSync(src, dst);
  } catch (error) {
    consumeKnownError(error);
    try {
      copyFileSync(src, dst);
      chmodSync(dst, 0o600);
    } catch (copyError) {
      consumeKnownError(copyError);
    }
  }
}

export function runtimeBaseUrl(config: RuntimeInstanceConfig): string | undefined {
  return config.kindId === "codex"
    ? config.codex.baseUrl
    : config.kindId === "claude"
      ? config.claude.baseUrl
      : undefined;
}

export function writeCodexConfig(
  target: string,
  config: RuntimeInstanceConfig & { readonly kindId: "codex" },
  bearerToken?: string,
): void {
  const provider = config.codex,
    lines = [
      `model_provider = ${tomlString(config.providerId)}`,
      ...(provider.reasoningEffort ? [`model_reasoning_effort = ${tomlString(provider.reasoningEffort)}`] : []),
    ];
  if (config.providerId !== "openai" || bearerToken)
    lines.push(
      "",
      `[model_providers.${tomlString(config.providerId)}]`,
      `name = ${tomlString(config.providerId)}`,
      ...(provider.baseUrl ? [`base_url = ${tomlString(provider.baseUrl)}`] : []),
      ...(provider.wireApi ? [`wire_api = ${tomlString(provider.wireApi)}`] : []),
      ...(provider.requiresOpenAiAuth === undefined ? [] : [`requires_openai_auth = ${provider.requiresOpenAiAuth}`]),
      ...(provider.httpHeaders
        ? [
            [
              "http_headers = { ",
              `${Object.entries(provider.httpHeaders)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
                .join(", ")}`,
              " }",
            ].join(""),
          ]
        : []),
      ...(bearerToken ? [`experimental_bearer_token = ${tomlString(bearerToken)}`] : []),
    );
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, target);
  chmodSync(target, 0o600);
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { credentialPort } from "./agent-runtime-credential-port.ts";
import type { FlatRuntimeInstanceConfig, LegacyRuntimeInstanceConfig } from "./agent-runtime-instance-config.ts";
import {
  available,
  isRuntimeInstanceRecord,
  needsRuntimeInstanceNormalization,
  normalizeModels,
  requireBoolean,
  requiredRuntimeInstanceText,
  runtimeInstanceConfig,
  runtimeInstanceError,
  runtimeInstanceId,
  selectRuntimeEffort,
  selectRuntimeModel,
  unavailable,
} from "./agent-runtime-instance-config.ts";
import {
  definitionSnapshot,
  ensureSharedAuthFile,
  migrateLegacyInstallationIdentities,
  missingInstallationHint,
  providerAuthFile,
  providerConfigDirectory,
  publicConfig,
  requireWitnessedInstallation,
  runtimeBaseUrl,
  sharedProviderDirectory,
  writeCodexConfig,
} from "./agent-runtime-instance-storage.ts";
import type {
  PreparedRuntimeAuthCommand,
  PreparedRuntimeLaunch,
  RuntimeAuthReadiness,
  RuntimeInstallationWitness,
  RuntimeInstanceConfig,
  RuntimeInstanceKind,
  RuntimeInstanceSummary,
} from "./agent-runtime-instance-types.ts";
import {
  credentialHint,
  credentialUnavailableHint,
  isolatedEnvironment,
  launchArgs,
  providerSubscriptionReadiness,
} from "./agent-runtime-launch-config.ts";
import { runtimePermissionMode, type RuntimeIsolationState } from "./runtime-permissions.ts";

export function openRuntimeInstanceStore(input: {
  readonly userRoot: string;
  readonly discover: () => readonly RuntimeInstallationWitness[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveCredential?: (reference: string) => Promise<string>;
  readonly subscriptionReady?: (input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
  }) => RuntimeAuthReadiness;
}) {
  const platform = input.platform ?? process.platform,
    resolveCredential = input.resolveCredential ?? credentialPort(platform).resolve,
    target = path.join(input.userRoot, "runtime-instances.json"),
    instancesRoot = path.join(input.userRoot, "runtime-instances"),
    readiness = new Map<string, RuntimeAuthReadiness>();
  function create(
    candidate: RuntimeInstanceConfig | LegacyRuntimeInstanceConfig | FlatRuntimeInstanceConfig,
  ): RuntimeInstanceConfig {
    const witnessed = input.discover(),
      installationId = resolveRuntimeInstallation(candidate.kindId, candidate.installationId, witnessed),
      config = runtimeInstanceConfig({
        ...candidate,
        installationId,
        installationIdentity: "path-entry/v1",
      } as RuntimeInstanceConfig),
      instances = read();
    if (instances.some(({ instanceId }) => instanceId === config.instanceId))
      throw runtimeInstanceError("runtime_instance_exists", `Runtime instance ${config.instanceId} already exists.`);
    const installation = witnessed.find(({ installationId: witnessedId }) => witnessedId === config.installationId);
    if (!installation || installation.kindId !== config.kindId)
      throw runtimeInstanceError(
        "runtime_installation_not_found",
        `Runtime installation ${config.installationId} is not currently witnessed for ${config.kindId}.`,
      );
    if (config.isolationState === "enforced") ensureStateRoot(config);
    persist([...instances, config]);
    return config;
  }
  function resolveRuntimeInstallation(
    kindId: RuntimeInstanceKind,
    requested: string | undefined,
    witnessed: readonly RuntimeInstallationWitness[],
  ): string {
    if (requested !== undefined) return requiredRuntimeInstanceText(requested, "installationId");
    const candidates = witnessed.filter((installation) => installation.kindId === kindId);
    if (candidates.length === 1) return candidates[0]!.installationId;
    if (candidates.length === 0)
      throw runtimeInstanceError(
        "runtime_installation_not_found",
        `No witnessed ${kindId} installation is currently available.`,
      );
    throw runtimeInstanceError(
      "runtime_installation_ambiguous",
      [
        "Multiple witnessed ",
        `${kindId}`,
        " installations are available; specify --installation with one of: ",
        `${candidates.map(({ installationId, version }) => `${installationId} (${version})`).join(", ")}`,
        ".",
      ].join(""),
    );
  }
  function readOne(
    instanceId: string,
    witnessed?: readonly RuntimeInstallationWitness[],
  ): RuntimeInstanceConfig | null {
    return read(witnessed).find((config) => config.instanceId === runtimeInstanceId(instanceId)) ?? null;
  }
  function remove(instanceId: string): RuntimeInstanceConfig {
    const id = runtimeInstanceId(instanceId),
      instances = read(),
      config = instances.find((entry) => entry.instanceId === id);
    if (!config) throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${id} does not exist.`);
    persist(instances.filter((entry) => entry.instanceId !== id));
    readiness.delete(id);
    rmSync(path.join(instancesRoot, id), { recursive: true, force: true });
    return config;
  }
  async function authStatus(
    instanceId: string,
    snapshot?: {
      readonly witnessed: readonly RuntimeInstallationWitness[];
      readonly config: RuntimeInstanceConfig;
    },
  ): Promise<RuntimeAuthReadiness> {
    const witnessed = snapshot?.witnessed ?? input.discover(),
      config = snapshot?.config ?? readOne(instanceId, witnessed);
    if (!config)
      throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    const installation = witnessed.find(
      (entry) => entry.installationId === config.installationId && entry.kindId === config.kindId,
    );
    if (!installation)
      return rememberAuthReadiness(
        config.instanceId,
        unavailable("runtime_installation_not_found", missingInstallationHint(config, witnessed)),
      );
    if (config.isolationState === "enforced") ensureStateRoot(config);
    const env = authEnvironment(config);
    if (config.auth.mode === "subscription")
      return rememberAuthReadiness(config.instanceId, probeSubscription(installation, env, config.isolationState));
    try {
      const secret = await resolveCredential(config.auth.credentialRef);
      return rememberAuthReadiness(
        config.instanceId,
        secret ? available() : unavailable("runtime_credential_unavailable", credentialUnavailableHint),
      );
    } catch (error) {
      consumeKnownError(error);
      return rememberAuthReadiness(
        config.instanceId,
        unavailable("runtime_credential_unavailable", credentialHint(error)),
      );
    }
  }
  function prepareAuthCommand(instanceId: string, action: "login" | "logout"): PreparedRuntimeAuthCommand {
    const config = readOne(instanceId);
    if (!config)
      throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    if (config.kindId === "agy")
      throw runtimeInstanceError(
        "runtime_auth_interactive_only",
        "agy has no programmable login command; sign in by running agy in your terminal.",
      );
    if (config.auth.mode !== "subscription")
      throw runtimeInstanceError(
        "runtime_auth_mode_mismatch",
        "Provider-native sign-in is available only for subscription instances.",
      );
    const witnessed = input.discover(),
      installation = witnessed.find(
        (entry) => entry.installationId === config.installationId && entry.kindId === config.kindId,
      );
    if (!installation)
      throw runtimeInstanceError("runtime_installation_not_found", missingInstallationHint(config, witnessed));
    if (config.isolationState === "enforced") ensureStateRoot(config);
    else
      mkdirSync(path.join(instancesRoot, config.instanceId), {
        recursive: true,
        mode: 0o700,
      });
    rememberAuthReadiness(
      config.instanceId,
      unavailable("runtime_auth_in_progress", `Provider-native ${action} is running in this instance terminal.`),
    );
    const args = config.kindId === "codex" ? [action] : ["auth", action];
    return {
      instanceId: config.instanceId,
      name: config.name,
      executablePath: installation.executablePath,
      args,
      env: authEnvironment(config),
      cwd: path.join(instancesRoot, config.instanceId),
    };
  }
  async function prepareLaunch(
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ): Promise<PreparedRuntimeLaunch> {
    const config = readOne(instanceId);
    if (!config)
      throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    if (!config.enabled)
      throw runtimeInstanceError(
        "runtime_instance_disabled",
        `Runtime instance ${instanceId} is disabled; run ha runtime instance update ${instanceId} --enable.`,
      );
    const model = selectRuntimeModel(config, request.model),
      effort = selectRuntimeEffort(config, request.effort),
      permissionMode = runtimePermissionMode(request.permissionMode ?? config.permissionMode, config.kindId),
      witnessed = input.discover(),
      installation = witnessed.find(
        (entry) => entry.installationId === config.installationId && entry.kindId === config.kindId,
      );
    if (!installation) {
      const hint = missingInstallationHint(config, witnessed);
      rememberAuthReadiness(config.instanceId, unavailable("runtime_installation_not_found", hint));
      throw runtimeInstanceError("runtime_installation_not_found", hint);
    }
    if (!path.isAbsolute(request.cwd) || !request.prompt)
      throw runtimeInstanceError("invalid_runtime_launch", "Runtime cwd must be absolute and prompt is required.");
    if (config.isolationState === "enforced") ensureStateRoot(config);
    const env = authEnvironment(config),
      args = launchArgs(
        config,
        model,
        request.prompt,
        request.providerSessionId,
        request.effort === undefined ? null : effort,
        permissionMode,
      ),
      definition = definitionSnapshot(config, model, effort);
    if (config.auth.mode === "subscription") {
      const readiness = rememberAuthReadiness(
        config.instanceId,
        probeSubscription(installation, env, config.isolationState),
      );
      if (readiness.code !== null) throw runtimeInstanceError(readiness.code, readiness.hint!);
      return {
        definition,
        installation,
        executablePath: installation.executablePath,
        args,
        env,
        cwd: request.cwd,
        prompt: request.prompt,
        ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
      };
    }
    let secret: string;
    try {
      secret = await resolveCredential(config.auth.credentialRef);
    } catch (error) {
      consumeKnownError(error);
      rememberAuthReadiness(config.instanceId, unavailable("runtime_credential_unavailable", credentialHint(error)));
      throw runtimeInstanceError("runtime_credential_unavailable", credentialHint(error));
    }
    if (!secret) {
      rememberAuthReadiness(
        config.instanceId,
        unavailable("runtime_credential_unavailable", credentialUnavailableHint),
      );
      throw runtimeInstanceError("runtime_credential_unavailable", credentialUnavailableHint);
    }
    if (config.kindId === "codex") {
      const configPath = path.join(env.CODEX_HOME!, "config.toml");
      if (!codexConfigHasBearer(configPath)) writeCodexConfig(configPath, config, secret);
    } else env.ANTHROPIC_API_KEY = secret;
    rememberAuthReadiness(config.instanceId, available());
    return {
      definition,
      installation,
      executablePath: installation.executablePath,
      args,
      env,
      cwd: request.cwd,
      prompt: request.prompt,
      ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
    };
  }
  async function prepareWorkerGitEnvironment(instanceId: string): Promise<NodeJS.ProcessEnv | null> {
    const config = readOne(instanceId);
    if (!config)
      throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    if (config.githubCredentialRef === undefined) return null;
    let secret: string;
    try {
      secret = await resolveCredential(config.githubCredentialRef);
    } catch (error) {
      consumeKnownError(error);
      throw runtimeInstanceError("runtime_credential_unavailable", "The configured GitHub credential is unavailable.");
    }
    if (!secret)
      throw runtimeInstanceError("runtime_credential_unavailable", "The configured GitHub credential is unavailable.");
    return {
      HARNESS_GITHUB_TOKEN: secret,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
  function command(
    action: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const kind = String(action.kind),
      base = {
        schema: "command-receipt/v2",
        ok: true,
        command: kind,
        outcome: "applied",
        opId: `${kind}:${typeof action.instanceId === "string" ? action.instanceId : "all"}`,
        nextAction: null,
      };
    if (kind === "runtime-instance-create") {
      if (
        (action.kindId === "claude" && action.codex !== undefined) ||
        (action.kindId === "claude" && action.agy !== undefined) ||
        (action.kindId === "codex" && action.claude !== undefined) ||
        (action.kindId === "codex" && action.agy !== undefined) ||
        (action.kindId === "agy" && action.claude !== undefined) ||
        (action.kindId === "agy" && action.codex !== undefined)
      )
        throw runtimeInstanceError(
          "invalid_runtime_kind_config",
          `${String(action.kindId)} runtime instance cannot include another kind configuration.`,
        );
      if (
        !["subscription", "api-key"].includes(String(action.authMode)) ||
        (action.authMode === "subscription" && action.credentialRef !== undefined)
      )
        throw runtimeInstanceError(
          "invalid_runtime_auth",
          "Runtime instance auth must select exactly subscription or an opaque API-key reference.",
        );
      const auth =
          action.authMode === "subscription"
            ? { mode: "subscription" as const }
            : { mode: "api-key" as const, credentialRef: action.credentialRef },
        models = normalizeModels(action.models),
        defaultModel =
          action.defaultModel === undefined
            ? models[0]!
            : requiredRuntimeInstanceText(action.defaultModel, "defaultModel"),
        kindConfig =
          action.kindId === "codex"
            ? { codex: action.codex ?? {} }
            : action.kindId === "agy"
              ? { agy: action.agy ?? {} }
              : { claude: action.claude ?? {} },
        config = create({
          schemaVersion: 2,
          instanceId: action.instanceId,
          name: action.name,
          kindId: action.kindId,
          installationId: action.installationId,
          providerId: action.providerId,
          models,
          defaultModel,
          enabled: true,
          ...(action.permissionMode !== undefined ? { permissionMode: action.permissionMode } : {}),
          ...(action.isolationState !== undefined ? { isolationState: action.isolationState } : {}),
          ...kindConfig,
          auth,
          ...(action.githubCredentialRef === undefined ? {} : { githubCredentialRef: action.githubCredentialRef }),
        } as RuntimeInstanceConfig),
        instance = publicConfig(config, readiness.get(config.instanceId));
      return {
        ...base,
        instance,
        evidence: JSON.stringify(instance),
        summary: `runtime-instance-create: ${config.instanceId}`,
      };
    }
    if (kind === "runtime-instance-list") {
      const all = action.all === true,
        witnessed = input.discover(),
        instances = read(witnessed)
          .filter((config) => all || config.enabled)
          .map((config) => publicConfig(config, readiness.get(config.instanceId))),
        installations = witnessed.map(
          ({ executableEntryPath: _entry, executablePath: _path, ...installation }) => installation,
        ),
        summary = [
          "ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS",
          ...instances.map((instance) =>
            [
              "",
              `${instance.instanceId}`,
              "\t",
              `${instance.name}`,
              "\t",
              `${instance.kindId}`,
              "\t",
              `${instance.models.join(",")}`,
              "\t",
              `${instance.enabled ? "enabled" : "disabled"}`,
              "\t",
              `${instance.authMode}`,
              "\t",
              authReadinessLabel(instance.authReadiness),
              "",
            ].join(""),
          ),
          "",
          "INSTALLATION\tKIND\tVERSION\tOBSERVED AT",
          ...installations.map(
            ({ installationId, kindId, version, observedAt }) =>
              `${installationId}\t${kindId}\t${version}\t${observedAt}`,
          ),
        ].join("\n");
      return {
        ...base,
        instances,
        installations,
        evidence: JSON.stringify({ instances, installations }),
        summary,
      };
    }
    const instanceId = requiredRuntimeInstanceText(action.instanceId, "instanceId");
    if (kind === "runtime-instance-github-credential-set" || kind === "runtime-instance-github-credential-unset") {
      const current = readOne(instanceId);
      if (!current)
        throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
      const { githubCredentialRef: _githubCredentialRef, ...withoutGithubCredential } = current,
        updated = runtimeInstanceConfig(
          kind === "runtime-instance-github-credential-set"
            ? { ...current, githubCredentialRef: action.githubCredentialRef }
            : withoutGithubCredential,
        ),
        instance = publicConfig(updated, readiness.get(updated.instanceId));
      persist(read().map((entry) => (entry.instanceId === current.instanceId ? updated : entry)));
      return {
        ...base,
        instance,
        evidence: JSON.stringify(instance),
        summary: `${kind}: ${instanceId}`,
      };
    }
    if (kind === "runtime-instance-update") {
      const current = readOne(instanceId);
      if (!current)
        throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
      const hasName = action.name !== undefined,
        hasInstallation = action.installationId !== undefined,
        hasModels = action.models !== undefined,
        hasDefault = action.defaultModel !== undefined,
        hasEnabled = action.enabled !== undefined,
        hasPermission = action.permissionMode !== undefined,
        hasIsolation = action.isolationState !== undefined;
      if (!hasName && !hasInstallation && !hasModels && !hasDefault && !hasEnabled && !hasPermission && !hasIsolation)
        throw runtimeInstanceError(
          "invalid_runtime_instance_update",
          [
            "Runtime instance update requires --name, --installation, --model, ",
            "--default-model, --permission-mode, --isolation, --enable, or --disable.",
          ].join(""),
        );
      const installationId = hasInstallation
          ? requireWitnessedInstallation(current.kindId, action.installationId, input.discover()).installationId
          : current.installationId,
        models = hasModels ? normalizeModels(action.models) : [...current.models],
        defaultModel = hasDefault
          ? requiredRuntimeInstanceText(action.defaultModel, "defaultModel")
          : current.defaultModel,
        enabled = hasEnabled ? requireBoolean(action.enabled, "enabled") : current.enabled;
      if (!models.includes(defaultModel))
        throw runtimeInstanceError(
          "invalid_runtime_model",
          `Default model ${defaultModel} is not in the instance model set. Supported models: ${models.join(", ")}.`,
        );
      const updated = runtimeInstanceConfig({
        ...current,
        name: hasName ? action.name : current.name,
        installationId,
        ...(hasInstallation ? { installationIdentity: "path-entry/v1" } : {}),
        models,
        defaultModel,
        enabled,
        ...(hasPermission ? { permissionMode: action.permissionMode } : {}),
        ...(hasIsolation ? { isolationState: action.isolationState } : {}),
      });
      persist(read().map((entry) => (entry.instanceId === current.instanceId ? updated : entry)));
      if (hasInstallation) readiness.delete(updated.instanceId);
      if (updated.isolationState === "enforced") ensureStateRoot(updated);
      return {
        ...base,
        instance: publicConfig(updated, readiness.get(updated.instanceId)),
        evidence: JSON.stringify(publicConfig(updated, readiness.get(updated.instanceId))),
        summary: `runtime-instance-update: ${instanceId}`,
      };
    }
    if (kind === "runtime-instance-show") {
      const witnessed = action.probe === true ? input.discover() : undefined,
        config = readOne(instanceId, witnessed);
      if (!config)
        throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
      if (action.probe === true)
        return authStatus(instanceId, { witnessed: witnessed!, config }).then((status) => {
          const instance = publicConfig(config, status);
          return {
            ...base,
            instance,
            evidence: JSON.stringify(instance),
            summary: `runtime-instance-show: ${instanceId}`,
          };
        });
      const instance = publicConfig(config, readiness.get(config.instanceId));
      return {
        ...base,
        instance,
        evidence: JSON.stringify(instance),
        summary: `runtime-instance-show: ${instanceId}`,
      };
    }
    if (kind === "runtime-instance-delete") {
      remove(instanceId);
      return {
        ...base,
        deletedInstanceId: instanceId,
        evidence: `runtime-instance-deleted:${instanceId}`,
        summary: `runtime-instance-delete: ${instanceId}`,
      };
    }
    throw runtimeInstanceError("unsupported_command", `Unsupported runtime instance command: ${kind}.`);
  }
  return {
    create,
    list: read,
    listPublic: (): readonly RuntimeInstanceSummary[] =>
      read()
        .filter((config) => config.enabled)
        .map((config) => publicConfig(config, readiness.get(config.instanceId))),
    read: readOne,
    delete: remove,
    authStatus,
    prepareAuthCommand,
    prepareLaunch,
    prepareWorkerGitEnvironment,
    command,
  };
  function read(witnessed?: readonly RuntimeInstallationWitness[]): RuntimeInstanceConfig[] {
    if (!existsSync(target)) return [];
    chmodSync(target, 0o600);
    const value: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (
      !isRuntimeInstanceRecord(value) ||
      value.schema !== "runtime-instances/v1" ||
      !Array.isArray(value.instances) ||
      Object.keys(value).some((key) => !["schema", "instances"].includes(key))
    )
      throw runtimeInstanceError("invalid_runtime_instance_store", "Runtime instance metadata is invalid.");
    const normalized = value.instances.map((entry) => runtimeInstanceConfig(entry)),
      requiresInstallationMigration = normalized.some((config) => config.installationIdentity !== "path-entry/v1"),
      migrated = requiresInstallationMigration
        ? migrateLegacyInstallationIdentities(normalized, witnessed ?? input.discover())
        : normalized,
      installationMigrated = migrated.some((entry, index) => entry !== normalized[index]),
      instances = migrated.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    if (value.instances.some(needsRuntimeInstanceNormalization) || installationMigrated) persist(instances);
    return instances;
  }
  function persist(instances: readonly RuntimeInstanceConfig[]): void {
    mkdirSync(input.userRoot, { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.tmp`,
      value = JSON.stringify(
        {
          schema: "runtime-instances/v1",
          instances: [...instances].sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        },
        null,
        2,
      );
    writeFileSync(temp, ["", value, "\n"].join(""), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
    chmodSync(target, 0o600);
  }
  function ensureStateRoot(config: RuntimeInstanceConfig): void {
    const root = path.join(instancesRoot, config.instanceId),
      home = path.join(root, "home"),
      provider = providerConfigDirectory(home, config.kindId);
    for (const directory of [root, home, ...["tmp", "run"].map((name) => path.join(root, name)), provider]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    // Materialize the non-secret config at instance creation. API-key launches add
    // the bearer once after credential resolution and preserve it for same-instance
    // workers; rewriting it here would expose an unauthenticated window.
    if (config.kindId === "codex") {
      const configPath = path.join(provider, "config.toml");
      if (config.auth.mode === "subscription" || !existsSync(configPath)) writeCodexConfig(configPath, config);
    }
    if (config.auth.mode === "subscription") {
      const authFile = providerAuthFile(config.kindId),
        shared = sharedProviderDirectory(input.env ?? process.env, config.kindId, platform);
      if (authFile && shared) ensureSharedAuthFile(path.join(shared, authFile), path.join(provider, authFile));
    }
  }
  function authEnvironment(config: RuntimeInstanceConfig): NodeJS.ProcessEnv {
    const env =
      config.isolationState === "enforced"
        ? isolatedEnvironment(
            input.env ?? process.env,
            path.join(instancesRoot, config.instanceId),
            config.kindId,
            platform,
          )
        : { ...(input.env ?? process.env) };
    if (platform === "darwin" && config.kindId === "claude" && config.isolationState === "operator-environment")
      env.USER = userInfo().username;
    const baseUrl = runtimeBaseUrl(config);
    if (baseUrl && (config.kindId === "claude" || config.providerId === "openai"))
      env[config.kindId === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"] = baseUrl;
    return env;
  }
  function rememberAuthReadiness(instanceId: string, state: RuntimeAuthReadiness): RuntimeAuthReadiness {
    readiness.set(instanceId, state);
    return state;
  }
  function probeSubscription(
    installation: RuntimeInstallationWitness,
    env: NodeJS.ProcessEnv,
    isolationState: RuntimeIsolationState,
  ): RuntimeAuthReadiness {
    try {
      return (
        input.subscriptionReady ?? ((probe) => providerSubscriptionReadiness({ ...probe, isolationState }, platform))
      )({ installation, env });
    } catch (error) {
      consumeKnownError(error);
      return unavailable("runtime_auth_probe_failed", "Provider authentication probe could not determine readiness.");
    }
  }
}

function codexConfigHasBearer(configPath: string): boolean {
  return existsSync(configPath) && /^\s*experimental_bearer_token\s*=/mu.test(readFileSync(configPath, "utf8"));
}

function authReadinessLabel(readiness: RuntimeAuthReadiness): string {
  return readiness.code === "runtime_auth_not_checked" ? "not-checked" : readiness.status;
}

import {
  commandInterceptionNeedsFiles,
  compileCommandInterceptionFiles,
} from "./runtime-command-interception-files.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { writeFileDurably } from "../../storage/src/durable-file.ts";
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
  selectRuntimeFast,
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
  runtimeInstanceKindConfig,
  sharedProviderDirectory,
  deepseekHarnessAcpModelOption,
  deepseekHarnessApiKeyEnvironment,
  writeDeepseekHarnessPatch,
  writeCodexConfig,
  writeZcodeConfig,
} from "./agent-runtime-instance-storage.ts";
import type {
  PreparedRuntimeAuthCommand,
  PreparedRuntimeLaunch,
  RecordedRuntimeInstallation,
  RuntimeAuthReadiness,
  RuntimeInstallationIdentity,
  RuntimeInstallationWitness,
  RuntimeInstanceConfig,
  RuntimeInstanceKind,
  RuntimeInstanceSummary,
  RuntimeLaunchRequest,
} from "./agent-runtime-instance-types.ts";
import { runtimeProviderConfig } from "./agent-runtime-instance-types.ts";
import {
  credentialHint,
  credentialUnavailableHint,
  isolatedEnvironment,
  launchArgs,
  providerSubscriptionReadiness,
} from "./agent-runtime-launch-config.ts";
import {
  resolveRuntimeMcpPolicy,
  runtimeMcpPolicy,
  runtimePermissionMode,
  runtimeSupportsMcpPolicy,
  type RuntimeIsolationState,
} from "./runtime-permissions.ts";
import { applyGithubLaunchCredential } from "./runtime-github-credentials.ts";
import {
  runtimeAuthArgs,
  runtimeEffortField,
  runtimeEffortRidesProviderConfig,
  runtimeKindForId,
  runtimeKindIds,
  type RuntimeProviderDeclaration,
} from "./runtime-inventory.ts";
import { hostingCredentialReference } from "./runtime-hosting-credentials.ts";
import { runtimeVersionGate, runtimeWebSearchVersionGate } from "./runtime-version.ts";
import {
  readCodexManagedPolicyTexts,
  runtimeWebSearchGatewayProbeRequired,
  runtimeWebSearchModelGate,
  runtimeWebSearchPolicyConflict,
  verifyRuntimeWebSearchGateway,
} from "./agent-runtime-web-search.ts";
import { CloudDispatchRelay, relayPriceOf } from "./runtime/cloud-dispatch-relay.ts";

/** Runtime session ids the spawner mints (`runtime_<24 hex>`). The per-run temp directory joins
 *  this id into a filesystem path that settlement recursively deletes, so the shape is pinned
 *  here: adopted dispatch-stream headers read the id back from disk, and the stream write
 *  boundary does not validate it. */
const runtimeTempSessionPattern = /^runtime_[0-9a-f]{24}$/u;

/** The receipt's installation row: a witness minus the host paths the command contract keeps
 *  out of every runtime-instance reply. */
function withoutHostPaths({
  executableEntryPath: _entry,
  executablePath: _path,
  ...installation
}: RuntimeInstallationWitness): RecordedRuntimeInstallation {
  return installation;
}

function requiredRuntimeSessionId(runtimeSessionId: string | undefined): string {
  if (!runtimeSessionId || !runtimeTempSessionPattern.test(runtimeSessionId))
    throw runtimeInstanceError(
      "invalid_runtime_session_id",
      "A per-run temp directory requires the spawner-minted runtime session id shape runtime_<24 hex>.",
    );
  return runtimeSessionId;
}

function runtimeTempDirectory(instancesRoot: string, instanceId: string, runtimeSessionId: string): string {
  return path.join(instancesRoot, instanceId, "tmp", requiredRuntimeSessionId(runtimeSessionId));
}

/** One entry the settled-session sweep could not reclaim; the daemon logs these and retries
 *  on its next start. */
export type RuntimeTempReclaimFailure = {
  readonly instanceId: string;
  readonly runtimeSessionId: string;
  readonly error: Error;
};

export function openRuntimeInstanceStore(input: {
  readonly userRoot: string;
  readonly discover: () => readonly RuntimeInstallationWitness[];
  readonly refreshDiscovery?: () => Promise<readonly RuntimeInstallationWitness[]>;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveCredential?: (reference: string) => Promise<string>;
  /**
   * Reads the operator's GitHub token for one launch. The daemon host supplies this (its own
   * `gh` login); a store opened without it injects no GitHub credential, so tests and embedded
   * stores never read the machine's login as a side effect of preparing a launch.
   */
  readonly resolveGithubToken?: (environment: NodeJS.ProcessEnv) => Promise<string | null>;
  readonly subscriptionReady?: (input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
  }) => RuntimeAuthReadiness | Promise<RuntimeAuthReadiness>;
  /** Test/embedded seam for Codex's managed requirements. Production reads the host's
   *  administrator policy through the same default source Codex loads. */
  readonly managedPolicyTexts?: () => readonly string[] | Promise<readonly string[]>;
  /** Test/embedded seam for the one real gateway verification an opt-in search tier on a
   *  custom base URL needs. Production uses the process fetch. */
  readonly webSearchFetch?: typeof fetch;
}) {
  const platform = input.platform ?? process.platform,
    resolveCredential = input.resolveCredential ?? credentialPort(platform).resolve,
    // The operator environment is the daemon's own, never an instance state root: this is the
    // one place a launch reads a GitHub credential, and it reads the operator's own login.
    operatorEnvironment = input.env ?? process.env,
    resolveGithubToken = input.resolveGithubToken,
    managedPolicyTexts = input.managedPolicyTexts ?? (() => readCodexManagedPolicyTexts(platform)),
    webSearchFetch = input.webSearchFetch ?? fetch,
    target = path.join(input.userRoot, "runtime-instances.json"),
    installationsTarget = path.join(input.userRoot, "runtime-installations.json"),
    instancesRoot = path.join(input.userRoot, "runtime-instances"),
    readiness = new Map<string, RuntimeAuthReadiness>();
  let cachedInstances: readonly RuntimeInstanceConfig[] | null = null,
    recordedInstallationsCache: readonly RecordedRuntimeInstallation[] | null = null,
    recordedInstallationsRead = false;
  function buildCreate(
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
    return config;
  }
  function commitCreate(config: RuntimeInstanceConfig): RuntimeInstanceConfig {
    if (config.isolationState === "enforced") ensureStateRoot(config);
    persist([...read(), config]);
    return config;
  }
  function create(
    candidate: RuntimeInstanceConfig | LegacyRuntimeInstanceConfig | FlatRuntimeInstanceConfig,
  ): RuntimeInstanceConfig {
    const config = buildCreate(candidate);
    // A custom gateway can only be admitted by the command write path, which performs the
    // one real verification before this commit. The direct builder stays closed so no
    // in-process caller can turn on an unverified tier by skipping that step.
    if (runtimeWebSearchGatewayProbeRequired(config))
      throw runtimeInstanceError(
        "runtime_web_search_gateway_unverified",
        [
          `Runtime instance ${config.instanceId} requests webSearch on a custom gateway, which is verified once `,
          `by the update command. Create it with webSearch=disabled, then run ` +
            `\`ha runtime instance update ${config.instanceId} --web-search live\`.`,
        ].join(""),
      );
    return commitCreate(config);
  }
  /** The one write-boundary verification for an opt-in tier on a custom base URL. */
  async function assertGatewaySearchVerified(config: RuntimeInstanceConfig): Promise<void> {
    if (!runtimeWebSearchGatewayProbeRequired(config)) return;
    if (config.auth.mode !== "api-key")
      throw runtimeInstanceError(
        "runtime_web_search_gateway_unverified",
        [
          `Native web search on ${config.instanceId}'s custom gateway is verified with the instance's API key; `,
          "this instance uses subscription authentication. Recreate it with api-key authentication or set webSearch=disabled.",
        ].join(""),
      );
    const provider = runtimeProviderConfig(config);
    await verifyRuntimeWebSearchGateway(
      {
        baseUrl: provider.baseUrl!,
        model: selectRuntimeModel(config),
        credentialRef: config.auth.credentialRef,
        ...(provider.credentialHeader === undefined ? {} : { credentialHeader: provider.credentialHeader }),
        ...(provider.httpHeaders === undefined ? {} : { httpHeaders: provider.httpHeaders }),
        ...(provider.wireApi === undefined ? {} : { wireApi: provider.wireApi }),
      },
      resolveCredential,
      webSearchFetch,
    );
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
    /* @gate-identity state-store/runtime-instance.store */ rmSync(path.join(instancesRoot, id), {
      recursive: true,
      force: true,
    });
    return config;
  }
  async function authStatus(
    instanceId: string,
    snapshot?: {
      readonly witnessed: readonly RuntimeInstallationWitness[];
      readonly config: RuntimeInstanceConfig;
    },
  ): Promise<RuntimeAuthReadiness> {
    const witnessed = snapshot?.witnessed ?? (await refreshInstallations()),
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
    // The provider's own version floor outranks authentication: a build that cannot honor
    // this kind's launch contract is not "ready with a valid login", and reporting it as
    // ready is what let a dispatch spend a spawn on it.
    const versionRefusal = runtimeVersionGate(installation.kindId, installation.version);
    if (versionRefusal)
      return rememberAuthReadiness(config.instanceId, unavailable(versionRefusal.code, versionRefusal.hint));
    const webSearchRefusal = runtimeWebSearchVersionGate(config, installation.version);
    if (webSearchRefusal)
      return rememberAuthReadiness(config.instanceId, unavailable(webSearchRefusal.code, webSearchRefusal.hint));
    const modelSearchRefusal = runtimeWebSearchModelGate(config, selectRuntimeModel(config), installation);
    if (modelSearchRefusal)
      return rememberAuthReadiness(config.instanceId, unavailable(modelSearchRefusal.code, modelSearchRefusal.hint));
    const policyRefusal = await runtimeWebSearchPolicyConflict(config, managedPolicyTexts);
    if (policyRefusal)
      return rememberAuthReadiness(config.instanceId, unavailable(policyRefusal.code, policyRefusal.hint));
    if (config.isolationState === "enforced") ensureStateRoot(config);
    const env = authEnvironment(config);
    if (config.auth.mode === "subscription") {
      const codexProbe =
        !input.subscriptionReady && config.kindId === "codex"
          ? {
              config,
              cwd: path.join(instancesRoot, config.instanceId),
              model: selectRuntimeModel(config),
              effort: selectRuntimeEffort(config),
              fast: selectRuntimeFast(config),
              permissionMode: "read-only" as const,
            }
          : undefined;
      if (codexProbe)
        /* @gate-identity state-store/runtime-instance.store */ mkdirSync(codexProbe.cwd, {
          recursive: true,
          mode: 0o700,
        });
      return rememberAuthReadiness(
        config.instanceId,
        await probeSubscription(installation, env, config.isolationState, codexProbe),
      );
    }
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
      /* @gate-identity state-store/runtime-instance.store */ mkdirSync(path.join(instancesRoot, config.instanceId), {
        recursive: true,
        mode: 0o700,
      });
    rememberAuthReadiness(
      config.instanceId,
      unavailable("runtime_auth_in_progress", `Provider-native ${action} is running in this instance terminal.`),
    );
    const args = runtimeAuthArgs(config.kindId, action);
    return {
      instanceId: config.instanceId,
      name: config.name,
      executablePath: installation.executablePath,
      args,
      env: authEnvironment(config),
      cwd: path.join(instancesRoot, config.instanceId),
    };
  }
  async function prepareLaunch(instanceId: string, request: RuntimeLaunchRequest): Promise<PreparedRuntimeLaunch> {
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
      fast = selectRuntimeFast(config, request.fast),
      permissionMode = runtimePermissionMode(request.permissionMode ?? config.permissionMode, config.kindId),
      mcpPolicy = resolveRuntimeMcpPolicy({
        kindId: config.kindId,
        dispatchMcpPolicy: request.mcpPolicy,
        instanceMcpPolicy: config.mcpPolicy,
      });
    let witnessed = input.discover(),
      installation = findInstallation(config, witnessed);
    if (!installation || !installationEntryMatches(installation)) {
      witnessed = await refreshInstallations();
      installation = findInstallation(config, witnessed);
    }
    if (!installation) {
      const hint = missingInstallationHint(config, witnessed);
      rememberAuthReadiness(config.instanceId, unavailable("runtime_installation_not_found", hint));
      throw runtimeInstanceError("runtime_installation_not_found", hint);
    }
    // Refuse an unusable build before anything is read for it: no credential lookup, no
    // secret written into an isolated HOME, no spawn. The dispatch precheck and the probe
    // share this one comparison, so neither can report ready while the other refuses.
    const versionRefusal = runtimeVersionGate(installation.kindId, installation.version);
    if (versionRefusal) {
      rememberAuthReadiness(config.instanceId, unavailable(versionRefusal.code, versionRefusal.hint));
      throw runtimeInstanceError(versionRefusal.code, versionRefusal.hint);
    }
    const webSearchRefusal = runtimeWebSearchVersionGate(config, installation.version);
    if (webSearchRefusal) {
      rememberAuthReadiness(config.instanceId, unavailable(webSearchRefusal.code, webSearchRefusal.hint));
      throw runtimeInstanceError(webSearchRefusal.code, webSearchRefusal.hint);
    }
    const modelSearchRefusal = runtimeWebSearchModelGate(config, model, installation);
    if (modelSearchRefusal) {
      rememberAuthReadiness(config.instanceId, unavailable(modelSearchRefusal.code, modelSearchRefusal.hint));
      throw runtimeInstanceError(modelSearchRefusal.code, modelSearchRefusal.hint);
    }
    const policyRefusal = await runtimeWebSearchPolicyConflict(config, managedPolicyTexts);
    if (policyRefusal) {
      rememberAuthReadiness(config.instanceId, unavailable(policyRefusal.code, policyRefusal.hint));
      throw runtimeInstanceError(policyRefusal.code, policyRefusal.hint);
    }
    if (!path.isAbsolute(request.cwd) || !request.prompt)
      throw runtimeInstanceError("invalid_runtime_launch", "Runtime cwd must be absolute and prompt is required.");
    if (config.isolationState === "enforced") ensureStateRoot(config);
    const declaration = runtimeKindForId(config.kindId),
      launch: RuntimeProviderDeclaration["launch"] = declaration.launch,
      protocolFamily = declaration.protocolFamily,
      launchTempDirectory =
        config.isolationState === "enforced" && request.runtimeSessionId !== undefined
          ? runtimeTempDirectory(instancesRoot, config.instanceId, request.runtimeSessionId)
          : null,
      env: NodeJS.ProcessEnv = {
        ...authEnvironment(config, launchTempDirectory ?? undefined),
        ...(permissionMode ? launch.permissionEnvironment?.[permissionMode] : undefined),
        ...(config.kindId === "claude" && request.commandInterceptions?.length
          ? { CLAUDE_CODE_SIMPLE: undefined }
          : {}),
      },
      nativeInterceptionFiles =
        request.commandInterceptions?.length && commandInterceptionNeedsFiles(config.kindId)
          ? compileCommandInterceptionFiles(
              config.kindId,
              request.commandInterceptions,
              path.join(instancesRoot, config.instanceId, "hooks", requiredRuntimeSessionId(request.runtimeSessionId)),
            )
          : null,
      args = launchArgs(
        config,
        model,
        request.prompt,
        request.providerSessionId,
        request.effort === undefined && runtimeEffortRidesProviderConfig(config.kindId) ? null : effort,
        permissionMode,
        fast,
        request.callbackRelayPath,
        platform,
        request.commandInterceptions,
        nativeInterceptionFiles?.args,
        mcpPolicy,
      ),
      definition = definitionSnapshot(config, model, effort, fast, mcpPolicy),
      // ACP agents take the model through the session handshake (a configOptions selector),
      // so it rides the launch manifest; argv-driven kinds already carry it in `args`.
      acpLaunch =
        protocolFamily === "acp"
          ? {
              model: deepseekHarnessAcpModelOption(config, model),
              ...(effort !== null ? { effort } : {}),
              ...(request.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: request.handshakeTimeoutMs } : {}),
            }
          : {},
      // The one GitHub injection point for both isolation states and both auth modes. DSH removes
      // credential-shaped names before spawning tools, so its workers do not receive the helper;
      // settlement pushes from the daemon. Other `env` values are already resolved (isolated HOME
      // or the operator environment). A store without a resolver injects nothing and owes no notice.
      githubCredentialNotice =
        resolveGithubToken && config.kindId !== "deepseek-harness"
          ? applyGithubLaunchCredential(env, await resolveGithubToken(operatorEnvironment))
          : undefined;
    // The three auth paths finish through the same per-launch scratch port. No
    // rejected credential probe leaves an unowned policy directory behind.
    const finishLaunch = (launch: PreparedRuntimeLaunch): PreparedRuntimeLaunch => {
      if (launchTempDirectory)
        /* @gate-identity non-state/environment-io.11ea73f113a7658b */ mkdirSync(launchTempDirectory, {
          recursive: true,
          mode: 0o700,
        });
      for (const file of nativeInterceptionFiles?.files ?? []) writeFileDurably(file.path, file.body, 0o600);
      return launch;
    };
    if (config.auth.mode === "subscription") {
      const readiness = rememberAuthReadiness(
        config.instanceId,
        await probeSubscription(installation, env, config.isolationState),
      );
      if (readiness.code !== null) throw runtimeInstanceError(readiness.code, readiness.hint!);
      return finishLaunch({
        definition,
        installation,
        protocolFamily,
        executablePath: installation.executablePath,
        args,
        env,
        cwd: request.cwd,
        prompt: request.prompt,
        authMode: config.auth.mode,
        ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(runtimeSupportsMcpPolicy(config.kindId) ? { mcpPolicy } : {}),
        ...(githubCredentialNotice ? { githubCredentialNotice } : {}),
        ...acpLaunch,
      });
    }
    if (request.cloudRelay) {
      if (config.kindId !== "codex" || config.auth.mode !== "api-key")
        throw runtimeInstanceError(
          "invalid_runtime_launch",
          "Cloud relay launches require a Codex API-key runtime instance.",
        );
      const configPath = path.join(env.CODEX_HOME!, "config.toml");
      writeCodexConfig(configPath, config, request.cloudRelay.token, request.cloudRelay.baseUrl, platform);
      rememberAuthReadiness(config.instanceId, available());
      return finishLaunch({
        definition,
        installation,
        protocolFamily,
        executablePath: installation.executablePath,
        args,
        env,
        cwd: request.cwd,
        prompt: request.prompt,
        authMode: config.auth.mode,
        ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(runtimeSupportsMcpPolicy(config.kindId) ? { mcpPolicy } : {}),
        ...(githubCredentialNotice ? { githubCredentialNotice } : {}),
        ...acpLaunch,
      });
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
      writeCodexConfig(configPath, config, secret, undefined, platform);
    } else if (config.kindId === "zcode") {
      const home = env.HOME ?? env.USERPROFILE;
      if (!home)
        throw runtimeInstanceError("invalid_runtime_launch", "ZCode launch environment has no home directory.");
      writeZcodeConfig(path.join(home, ".zcode", "cli", "config.json"), config, secret);
    } else if (config.kindId === "deepseek-harness") {
      env[deepseekHarnessApiKeyEnvironment] = secret;
    } else if (protocolFamily !== "acp") env.ANTHROPIC_API_KEY = secret;
    rememberAuthReadiness(config.instanceId, available());
    return finishLaunch({
      definition,
      installation,
      protocolFamily,
      executablePath: installation.executablePath,
      args,
      env,
      cwd: request.cwd,
      prompt: request.prompt,
      authMode: config.auth.mode,
      ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(runtimeSupportsMcpPolicy(config.kindId) ? { mcpPolicy } : {}),
      ...(githubCredentialNotice ? { githubCredentialNotice } : {}),
      // ACP agents authenticate through the client handshake, so the key rides the
      // launch manifest rather than the provider's environment.
      ...(protocolFamily === "acp" && config.kindId !== "deepseek-harness" ? { acpApiKey: secret } : {}),
      ...acpLaunch,
    });
  }

  async function prepareCloudRelay(request: {
    readonly instanceId: string;
    readonly attemptId: string;
    readonly model: string;
    readonly budgetMicros: number;
    readonly maxGenerations?: number;
  }): Promise<{
    readonly baseUrl: string;
    readonly token: string;
    readonly close: () => Promise<void>;
  } | null> {
    const config = readOne(request.instanceId);
    if (!config || config.kindId !== "codex" || config.auth.mode !== "api-key") return null;
    const targetBaseUrl = runtimeBaseUrl(config);
    if (!targetBaseUrl) return null;
    const target = new URL(targetBaseUrl);
    if (target.protocol !== "https:" || target.pathname.replace(/\/$/u, "") !== "/v1") return null;
    if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(request.model)) return null;
    const credentialRef = config.auth.credentialRef;
    const price = relayPriceOf(request.model);
    const relay = new CloudDispatchRelay({ allowedHosts: [target.hostname] });
    await relay.start();
    const registration = relay.register({
      attemptId: request.attemptId,
      targetBaseUrl,
      model: request.model,
      keyFor: () => resolveCredential(credentialRef),
      price,
      budgetMicros: request.budgetMicros,
      ...(request.maxGenerations === undefined ? {} : { maxGenerations: request.maxGenerations }),
    });
    return { ...registration, close: () => relay.close() };
  }
  async function prepareDaemonGitEnvironment(
    instanceId: string,
    provider: "github" | "gitlab",
    repoId: string,
  ): Promise<NodeJS.ProcessEnv | null> {
    const config = readOne(instanceId);
    if (!config)
      throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
    const reference = hostingCredentialReference(config, provider, repoId);
    if (reference === undefined) return null;
    let secret: string;
    try {
      secret = await resolveCredential(reference);
    } catch (error) {
      consumeKnownError(error);
      throw runtimeInstanceError(
        "runtime_credential_unavailable",
        `The configured ${provider} credential is unavailable.`,
      );
    }
    if (!secret)
      throw runtimeInstanceError(
        "runtime_credential_unavailable",
        `The configured ${provider} credential is unavailable.`,
      );
    return {
      ...(provider === "github"
        ? { GH_TOKEN: secret, HARNESS_GITHUB_TOKEN: secret }
        : { GITLAB_TOKEN: secret, HARNESS_GITLAB_TOKEN: secret }),
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
      };
    if (kind === "runtime-instance-create") {
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
        kindConfig = Object.fromEntries(
          runtimeKindIds
            .filter((candidate) => action[candidate] !== undefined || candidate === action.kindId)
            .map((candidate) => [candidate, action[candidate] ?? {}]),
        ),
        config = buildCreate({
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
          ...(action.mcpPolicy !== undefined ? { mcpPolicy: action.mcpPolicy } : {}),
          ...(action.isolationState !== undefined ? { isolationState: action.isolationState } : {}),
          ...kindConfig,
          auth,
          ...(action.hostingCredentialRefsByRepo === undefined
            ? {}
            : { hostingCredentialRefsByRepo: action.hostingCredentialRefsByRepo }),
        } as RuntimeInstanceConfig),
        receipt = () => {
          const instance = publicConfig(config, readiness.get(config.instanceId));
          return {
            ...base,
            instance,
            evidence: JSON.stringify(instance),
            summary: `runtime-instance-create: ${config.instanceId}`,
          };
        };
      if (runtimeWebSearchGatewayProbeRequired(config))
        return assertGatewaySearchVerified(config).then(() => {
          commitCreate(config);
          return receipt();
        });
      commitCreate(config);
      return receipt();
    }
    if (kind === "runtime-instance-list") {
      // A probe is the caller saying "observe this machine now", so it reads the live snapshot the
      // host just refreshed. Every other list reads this node's recorded observations: the read
      // never runs a provider CLI, and what it reports is what has actually been witnessed.
      const all = action.all === true,
        probe = action.probe === true,
        recorded = probe ? null : recordedInstallations(),
        // The live snapshot is only consulted when there is no record to read, or when the caller
        // asked to probe; both are the daemon's own memory, never a new observation.
        live = recorded === null ? input.discover() : null,
        configs = read(recorded ?? live ?? []).filter((config) => all || config.enabled),
        installations = recorded ?? (live ?? []).map(withoutHostPaths);
      const listed = (instances: readonly RuntimeInstanceSummary[]) => {
        const summary = [
          "ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS\tPERMISSION MODE\tMCP POLICY",
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
              "\t",
              `${instance.permissionMode}`,
              "\t",
              `${instance.mcpPolicy ?? "unsupported"}`,
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
      };
      if (probe)
        return Promise.all(
          configs.map(async (config) =>
            publicConfig(config, await authStatus(config.instanceId, { witnessed: live ?? [], config })),
          ),
        ).then(listed);
      const instances = configs.map((config) => publicConfig(config, readiness.get(config.instanceId)));
      return listed(instances);
    }
    const instanceId = requiredRuntimeInstanceText(action.instanceId, "instanceId");
    if (kind === "runtime-instance-hosting-credential-set" || kind === "runtime-instance-hosting-credential-unset") {
      const current = readOne(instanceId);
      if (!current)
        throw runtimeInstanceError("runtime_instance_not_found", `Runtime instance ${instanceId} does not exist.`);
      const provider = action.provider === "gitlab" || action.provider === "github" ? action.provider : null;
      if (!provider) throw runtimeInstanceError("invalid_command", "Hosting credential requires --provider.");
      const repoId = requiredRuntimeInstanceText(action.repoId, "repoId"),
        byRepo = current.hostingCredentialRefsByRepo ?? {},
        existingRefs = Object.hasOwn(byRepo, repoId) ? byRepo[repoId]! : {},
        refs = kind.endsWith("-set")
          ? { ...existingRefs, [provider]: action.credentialRef }
          : Object.fromEntries(Object.entries(existingRefs).filter(([candidate]) => candidate !== provider)),
        updated = runtimeInstanceConfig({
          ...current,
          hostingCredentialRefsByRepo: {
            ...Object.fromEntries(Object.entries(byRepo).filter(([candidate]) => candidate !== repoId)),
            ...(Object.keys(refs).length === 0 ? {} : { [repoId]: refs }),
          },
        }),
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
        hasMcpPolicy = action.mcpPolicy !== undefined,
        hasIsolation = action.isolationState !== undefined,
        hasFast = action.fast !== undefined,
        hasWebSearch = action.webSearch !== undefined,
        hasBaseUrl = action.baseUrl !== undefined,
        hasEffort = action.effort !== undefined,
        hasCredential = action.credentialRef !== undefined;
      if (hasCredential && current.auth.mode !== "api-key")
        throw runtimeInstanceError("runtime_auth_mode_mismatch", "Subscription instances cannot replace an API key.");
      if (
        !hasName &&
        !hasInstallation &&
        !hasModels &&
        !hasDefault &&
        !hasEnabled &&
        !hasPermission &&
        !hasMcpPolicy &&
        !hasIsolation &&
        !hasFast &&
        !hasWebSearch &&
        !hasBaseUrl &&
        !hasEffort &&
        !hasCredential
      )
        throw runtimeInstanceError(
          "invalid_runtime_instance_update",
          [
            "Runtime instance update requires --name, --installation, --model, ",
            "--default-model, --web-search, --base-url, --effort, --permission-mode, --mcp-policy, --isolation, --fast, --enable, --disable, or a new API key.",
          ].join(""),
        );
      if (hasMcpPolicy && !runtimeSupportsMcpPolicy(current.kindId))
        throw runtimeInstanceError(
          "invalid_runtime_mcp_policy",
          `${runtimeKindForId(current.kindId).displayName} does not support host MCP policy configuration.`,
        );
      if (hasBaseUrl && current.kindId === "agy")
        throw runtimeInstanceError(
          "invalid_runtime_kind_config",
          "agy runtime instances support subscription OAuth only and have no base URL.",
        );
      if (hasFast && current.kindId !== "codex")
        throw runtimeInstanceError("invalid_runtime_fast", "Fast mode is supported only by Codex runtime instances.");
      if (hasWebSearch && !("webSearch" in runtimeKindForId(current.kindId).configuration.fields))
        throw runtimeInstanceError(
          "invalid_runtime_web_search",
          `web search updates are not supported by ${current.kindId} runtime instances.`,
        );
      if (hasEffort && runtimeEffortField(current.kindId) === undefined)
        throw runtimeInstanceError(
          "invalid_runtime_effort",
          `Reasoning effort updates are not supported by ${current.kindId} runtime instances.`,
        );
      const installationId = hasInstallation
          ? requireWitnessedInstallation(current.kindId, action.installationId, input.discover()).installationId
          : current.installationId,
        models = hasModels ? normalizeModels(action.models) : [...current.models],
        defaultModel = hasDefault
          ? requiredRuntimeInstanceText(action.defaultModel, "defaultModel")
          : current.defaultModel,
        enabled = hasEnabled ? requireBoolean(action.enabled, "enabled") : current.enabled,
        // Base URL edit on the existing instance: a non-empty value replaces the current
        // endpoint (same secure validation as create); an explicit empty string clears it
        // back to the official endpoint. Omitted leaves it untouched. Effort follows the
        // same rule on every plane that declares an effort field, under that field's name.
        baseUrl = hasBaseUrl ? String(action.baseUrl).trim() : undefined,
        effort = hasEffort ? String(action.effort).trim() : undefined,
        webSearch = hasWebSearch ? String(action.webSearch).trim() : undefined,
        kindConfig = runtimeInstanceKindConfig(
          current,
          baseUrl,
          hasFast ? requireBoolean(action.fast, "fast") : undefined,
          effort,
          webSearch,
        );
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
        ...(hasMcpPolicy
          ? {
              mcpPolicy:
                String(action.mcpPolicy).trim() === ""
                  ? undefined
                  : runtimeMcpPolicy(String(action.mcpPolicy).trim(), current.kindId),
            }
          : {}),
        ...(hasIsolation ? { isolationState: action.isolationState } : {}),
        ...kindConfig,
        ...(hasCredential ? { auth: { mode: "api-key", credentialRef: action.credentialRef } } : {}),
      });
      const finish = () => {
        if (updated.isolationState === "enforced") ensureStateRoot(updated);
        persist(read().map((entry) => (entry.instanceId === current.instanceId ? updated : entry)));
        if (hasInstallation || hasBaseUrl || hasCredential) readiness.delete(updated.instanceId);
        const instance = publicConfig(updated, readiness.get(updated.instanceId));
        return {
          ...base,
          instance,
          evidence: JSON.stringify(instance),
          summary: `runtime-instance-update: ${instanceId}`,
        };
      };
      // An opt-in tier on a custom gateway is admitted by the one real verification, and
      // only when the update itself touches the search endpoint, mode or credential.
      if ((hasWebSearch || hasBaseUrl || hasCredential) && runtimeWebSearchGatewayProbeRequired(updated))
        return assertGatewaySearchVerified(updated).then(finish);
      return finish();
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
            summary: `runtime-instance-show: ${instanceId}\nmodels: ${instance.models.join(", ")}\nauth: ${authReadinessLabel(instance.authReadiness)}\npermissionMode: ${instance.permissionMode}\nmcpPolicy: ${instance.mcpPolicy ?? "unsupported"}`,
          };
        });
      const instance = publicConfig(config, readiness.get(config.instanceId));
      return {
        ...base,
        instance,
        evidence: JSON.stringify(instance),
        summary: `runtime-instance-show: ${instanceId}\nmodels: ${instance.models.join(", ")}\nauth: ${authReadinessLabel(instance.authReadiness)}\npermissionMode: ${instance.permissionMode}\nmcpPolicy: ${instance.mcpPolicy ?? "unsupported"}`,
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
  /** Reclaims one runtime session's per-run temp directory. Returns the filesystem failure
   *  instead of throwing, so terminal settlement can record it; a session id outside the
   *  spawner-minted shape is a no-op. Operator instances own only hook scratch, never operator TMPDIR. */
  function reclaimRuntimeTempDirectory(instanceId: string, runtimeSessionId: string): Error | null {
    if (!runtimeTempSessionPattern.test(runtimeSessionId)) return null;
    const config = read().find((entry) => entry.instanceId === instanceId);
    if (!config) return null;
    try {
      for (const namespace of ["hooks", ...(config.isolationState === "enforced" ? ["tmp"] : [])]) {
        /* @gate-identity non-state/environment-io.53e36032a7e7b1b3 */
        rmSync(path.join(instancesRoot, config.instanceId, namespace, runtimeSessionId), {
          recursive: true,
          force: true,
        });
      }
      return null;
    } catch (error) {
      // The next daemon start's settled-session sweep (below) retries this directory.
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Names the local per-run temp directories. The startup sweep point-reads these names so
   *  its cost follows local directories instead of every session the repository ever ran. */
  function listRuntimeTempSessionIds(): string[] {
    const runtimeSessionIds = new Set<string>();
    for (const config of read()) {
      for (const namespace of ["hooks", ...(config.isolationState === "enforced" ? ["tmp"] : [])]) {
        const instanceTmpRoot = path.join(instancesRoot, config.instanceId, namespace);
        if (!existsSync(instanceTmpRoot)) continue;
        for (const entry of readdirSync(instanceTmpRoot, { withFileTypes: true }))
          if (entry.isDirectory() && runtimeTempSessionPattern.test(entry.name)) runtimeSessionIds.add(entry.name);
      }
    }
    return [...runtimeSessionIds].sort();
  }

  /** Reclaims only directories named by the caller's repository-scoped terminal session set.
   *  Unknown ids may belong to another repository sharing this node's instances; directory
   *  absence from one repository's session table is never evidence of an orphan. Enumerating
   *  directories still retries settled runs after their dispatch streams are archived. */
  function reclaimSettledRuntimeTempDirectories(
    settledRuntimeSessionIds: readonly string[],
  ): RuntimeTempReclaimFailure[] {
    const failures: RuntimeTempReclaimFailure[] = [],
      settled = new Set(settledRuntimeSessionIds);
    for (const config of read()) {
      for (const namespace of ["hooks", ...(config.isolationState === "enforced" ? ["tmp"] : [])]) {
        const instanceTmpRoot = path.join(instancesRoot, config.instanceId, namespace);
        if (!existsSync(instanceTmpRoot)) continue;
        for (const entry of readdirSync(instanceTmpRoot, { withFileTypes: true })) {
          // Only spawner-minted session ids name per-run directories; anything else an operator
          // or provider left in the instance tmp root stays untouched.
          if (!entry.isDirectory() || !runtimeTempSessionPattern.test(entry.name)) continue;
          if (!settled.has(entry.name)) continue;
          const error = reclaimRuntimeTempDirectory(config.instanceId, entry.name);
          if (error) failures.push({ instanceId: config.instanceId, runtimeSessionId: entry.name, error });
        }
      }
    }
    return failures;
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
    prepareCloudRelay,
    reclaimRuntimeTempDirectory,
    listRuntimeTempSessionIds,
    reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment,
    refreshInstallations,
    recordedInstallations,
    command,
  };
  async function refreshInstallations(): Promise<readonly RuntimeInstallationWitness[]> {
    const witnessed = input.refreshDiscovery ? await input.refreshDiscovery() : input.discover();
    recordInstallations(witnessed);
    return witnessed;
  }
  /** The installation observations this node last recorded, or null when it has never recorded
   *  any. Obtaining a witness means executing each provider CLI (`--version`, then its model
   *  probe), so an observation cannot be produced by a read; the record is what a read reports.
   *  The caller decides whether "never recorded" is worth one observation — this read never
   *  spawns. */
  function recordedInstallations(): readonly RecordedRuntimeInstallation[] | null {
    if (recordedInstallationsRead) return recordedInstallationsCache;
    recordedInstallationsRead = true;
    if (!existsSync(installationsTarget)) return null;
    const value: unknown = JSON.parse(readFileSync(installationsTarget, "utf8"));
    if (
      !isRuntimeInstanceRecord(value) ||
      value.schema !== "runtime-installations/v1" ||
      !Array.isArray(value.installations) ||
      Object.keys(value).some((key) => !["schema", "installations"].includes(key))
    )
      throw runtimeInstanceError("invalid_runtime_installation_store", "Recorded runtime installations are invalid.");
    recordedInstallationsCache = value.installations as readonly RecordedRuntimeInstallation[];
    return recordedInstallationsCache;
  }
  function recordInstallations(witnessed: readonly RuntimeInstallationWitness[]): void {
    const installations = witnessed.map(withoutHostPaths);
    writeFileDurably(
      installationsTarget,
      `${JSON.stringify({ schema: "runtime-installations/v1", installations }, null, 2)}\n`,
      0o600,
    );
    recordedInstallationsCache = installations;
    recordedInstallationsRead = true;
  }
  function findInstallation(
    config: RuntimeInstanceConfig,
    witnessed: readonly RuntimeInstallationWitness[],
  ): RuntimeInstallationWitness | undefined {
    return witnessed.find((entry) => entry.installationId === config.installationId && entry.kindId === config.kindId);
  }
  function installationEntryMatches(installation: RuntimeInstallationWitness): boolean {
    if (!installation.executableEntryPath) return true;
    // A vanished entry reads as undefined rather than throwing; any other failure stays loud.
    const entry = statSync(installation.executableEntryPath, { throwIfNoEntry: false });
    return (
      entry !== undefined &&
      entry.isFile() &&
      (process.platform === "win32" || (entry.mode & 0o111) !== 0) &&
      realpathSync.native(installation.executableEntryPath) === installation.executablePath
    );
  }
  function read(witnessed?: readonly RuntimeInstallationIdentity[]): RuntimeInstanceConfig[] {
    if (cachedInstances) {
      if (existsSync(target)) chmodSync(target, 0o600);
      return [...cachedInstances];
    }
    if (!existsSync(target)) {
      cachedInstances = [];
      return [];
    }
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
    cachedInstances = instances;
    return [...instances];
  }
  function persist(instances: readonly RuntimeInstanceConfig[]): void {
    /* @gate-identity state-store/runtime-instance.store */ mkdirSync(input.userRoot, {
      recursive: true,
      mode: 0o700,
    });
    const temp = `${target}.${process.pid}.tmp`,
      value = JSON.stringify(
        {
          schema: "runtime-instances/v1",
          instances: [...instances].sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        },
        null,
        2,
      );
    try {
      /* @gate-identity state-store/runtime-instance.store */ writeFileSync(temp, ["", value, "\n"].join(""), {
        encoding: "utf8",
        mode: 0o600,
      });
      /* @gate-identity state-store/runtime-instance.store */ renameSync(temp, target);
    } catch (error) {
      /* @gate-identity state-store/runtime-instance.store */ rmSync(temp, { force: true });
      throw error;
    }
    cachedInstances = [...instances].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }
  function ensureStateRoot(config: RuntimeInstanceConfig): void {
    const root = path.join(instancesRoot, config.instanceId),
      home = path.join(root, "home"),
      provider = providerConfigDirectory(home, config.kindId);
    for (const directory of [root, home, ...["tmp", "run"].map((name) => path.join(root, name)), provider]) {
      /* @gate-identity state-store/runtime-instance.store */ mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    if (config.kindId === "zcode") {
      const cli = path.join(provider, "cli");
      /* @gate-identity state-store/runtime-instance.store */ mkdirSync(cli, { recursive: true, mode: 0o700 });
      chmodSync(cli, 0o700);
    }
    if (config.kindId === "deepseek-harness" && config.auth.mode === "api-key")
      writeDeepseekHarnessPatch(path.join(provider, "profiles", "acp", "cordis.patch.yml"), config);
    // Materialize non-secret defaults at creation. Each API-key launch atomically
    // publishes the current resolved bearer; metadata edits keep the previous
    // complete native config until that launch is ready.
    if (config.kindId === "codex") {
      const configPath = path.join(provider, "config.toml");
      if (config.auth.mode === "subscription" || !existsSync(configPath))
        writeCodexConfig(configPath, config, undefined, undefined, platform);
    }
    if (config.auth.mode === "subscription") {
      const authFile = providerAuthFile(config.kindId),
        shared = sharedProviderDirectory(input.env ?? process.env, config.kindId, platform);
      if (authFile && shared) ensureSharedAuthFile(path.join(shared, authFile), path.join(provider, authFile));
    }
  }
  function authEnvironment(config: RuntimeInstanceConfig, tempDirectory?: string): NodeJS.ProcessEnv {
    const env =
      config.isolationState === "enforced"
        ? isolatedEnvironment(
            input.env ?? process.env,
            path.join(instancesRoot, config.instanceId),
            config.kindId,
            platform,
            tempDirectory,
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
  async function probeSubscription(
    installation: RuntimeInstallationWitness,
    env: NodeJS.ProcessEnv,
    isolationState: RuntimeIsolationState,
    codexProbe?: NonNullable<Parameters<typeof providerSubscriptionReadiness>[0]["codexProbe"]>,
  ): Promise<RuntimeAuthReadiness> {
    try {
      if (input.subscriptionReady) return await input.subscriptionReady({ installation, env });
      return await providerSubscriptionReadiness(
        { installation, env, isolationState, ...(codexProbe ? { codexProbe } : {}) },
        platform,
      );
    } catch (error) {
      consumeKnownError(error);
      return unavailable("runtime_auth_probe_failed", "Provider authentication probe could not determine readiness.");
    }
  }
}

function authReadinessLabel(readiness: RuntimeAuthReadiness): string {
  if (readiness.code === "runtime_auth_not_checked") return "not-checked";
  return readiness.status === "ready" && readiness.basis === "metadata" ? "ready (metadata)" : readiness.status;
}

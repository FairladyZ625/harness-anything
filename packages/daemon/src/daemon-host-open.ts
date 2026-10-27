import { readHomeOverview } from "./home/home-overview-read.ts";
import { readFleetCenterConfig } from "./fleet-center-config.ts";
import {
  keycloakNodeRegistry,
  prepareFleetCenterAdmission,
  startFleetCenterAdmission,
} from "./fleet-center-admission.ts";
import {
  authenticateRuntimeExecutionCredential,
  executionCredentialRejected,
  runtimeExecutionActor,
} from "./runtime-execution-credential.ts";
/** @daemon-transport-authority Host composition and RepoCell ownership. */
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  consumeKnownError,
  validateScheduleV1,
  readDaemonRegistry,
  registerDaemonRepo,
  type DaemonRepoMode,
} from "@harness-anything/kernel";
import type { CommandTopology } from "@harness-anything/preset/internal/preset-command-contract";
import {
  discoverRuntimeInstallations,
  openRuntimeInstanceStore,
  type RuntimeInstallationWitness,
} from "./agent-runtime-instances.ts";
import { daemonBuildStamp, observeDaemonBuild } from "./build-identity.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { createEdgeJoinProgressTap, joinFleetEdge } from "./fleet/edge-join-client.ts";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import {
  admitHostMode as admitHostModeImpl,
  requireHostMode as requireHostModeImpl,
  settleControl as settleControlImpl,
} from "./daemon-host-admission.ts";
import { binding as deriveBinding, localSystemBinding } from "./daemon-host-binding.ts";
import { createDaemonHostControlApi } from "./daemon-host-control-api.ts";
import {
  attachBudgetError,
  code,
  daemonErrorMessage,
  diagnosticForError,
  failedConfigureVerify,
  hostCodedError,
  makeWarmingSettlement,
  recoverableRunId,
  rejectHostAction,
  rejectPresetRun,
} from "./daemon-host-errors.ts";
import { createDaemonHostLifecycleApi } from "./daemon-host-lifecycle-api.ts";
import {
  attachInitial as attachInitialImpl,
  attemptHostRecovery as attemptHostRecoveryImpl,
  startInitialAttachments as startInitialAttachmentsImpl,
  waitForWarming as waitForWarmingImpl,
} from "./daemon-host-recovery.ts";
import {
  closeCell as closeCellImpl,
  openRegistered as openRegisteredImpl,
  performOpenRegistered as performOpenRegisteredImpl,
  pruneMissingRoot as pruneMissingRootImpl,
  raceAttachBudget as raceAttachBudgetImpl,
  refreshRegistry as refreshRegistryImpl,
} from "./daemon-host-registry.ts";
import { createDaemonHostRepositoryApi } from "./daemon-host-repository-api.ts";
import { createDaemonHostRuntimeApi } from "./daemon-host-runtime-api.ts";
import {
  invalidRegistryStatus,
  invalidRegistrySystemRow,
  invalidRepoId,
  localOnly,
  publicRegistryRepo,
  requiredCell,
  requiredText,
} from "./daemon-host-status.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import { openDaemonWriterEpochs } from "./daemon-host-writer-epoch.ts";
import { requireAuthorizedFleetAction, requireAuthorizedHostAction } from "./host-action-authorization.ts";
import { openFleetEdgeRuntime, type FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import { applyFleetMirrorCut } from "./fleet-edge-mirror.ts";
import type { FleetTlsCenter } from "./fleet/center.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { canonicalRoot, workspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { openDaemonRuntimePorts } from "./daemon-runtime-ports.ts";
import { causeClassOf, latchReprobeThrottleMs, openRepoCell, type RepoCell, type RepoCellStatus } from "./repo-cell.ts";
import { type RepoModeAdmission } from "./repo-mode.ts";
import type { RuntimeLauncher } from "./runtime-spawn.ts";
import { makeScheduleScheduler } from "./schedule-scheduler.ts";
import type { DaemonAuthenticationContext, KeycloakCenterAuthority } from "./transport/auth-context.ts";
import type { DaemonHostApiContext, DaemonHostRegistryContext } from "./daemon-host-context.ts";
import { openRemoteProxyManager } from "./remote-proxy.ts";
import { credentialPort, type CredentialPort } from "./agent-runtime-credential-port.ts";
import { runtimeInstanceCredentialService } from "./runtime-instance-credentials.ts";
import { openDecisionProviderService } from "./decision-provider.ts";
import { openDecisionPointExecutorFactory } from "./decision-point-executor.ts";
import { AccessAdminService } from "./access-admin-service.ts";
import type { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import { accessAdminOperations } from "./protocol/daemon-protocol.contract.ts";
import { ManagedRbacService } from "./managed-rbac-service.ts";
import { OidcSessionService } from "./oidc-session-service.ts";
import { runFleetReplicaSync, waitForFleetReplicaReady } from "./fleet/replica-sync.ts";
export interface DaemonHostOpenInput {
  readonly daemonId: string;
  readonly userRoot: string;
  readonly endpoint?: string;
  readonly startedAt?: string;
  readonly now?: () => string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeDiscover?: () =>
    | readonly RuntimeInstallationWitness[]
    | Promise<readonly RuntimeInstallationWitness[]>;
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  /** Reads the operator's GitHub token for a launch; tests substitute it so no host login is read. */
  readonly runtimeGithubToken?: (environment: NodeJS.ProcessEnv) => Promise<string | null>;
  readonly runtimeCredentialPort?: CredentialPort;
  readonly runtimeFile?: string;
  readonly shutdownRequested?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  readonly buildDraining?: () => boolean;
  readonly onRepoStatusChange?: () => void;
  /** The daemon's one OIDC session service; the transport binds requests through the same instance. */
  readonly oidc?: OidcSessionService;
  /** The managed identity center's lifecycle; a hermetic host substitutes it to stage its resume. */
  readonly managedRbac?: Pick<ManagedRbacService, "run" | "resume" | "stop" | "loginListenerCertificate">;
  readonly attachTimeoutMs?: number;
  readonly openCell?: (
    input: Parameters<typeof openRepoCell>[0] & { readonly onStatus?: (status: RepoCellStatus) => void },
  ) => Promise<RepoCell>;
  readonly sshTunnels?: EdgeJoinSshTunnelManager;
  readonly edgeJoins?: ReturnType<typeof createEdgeJoinStore>;
}

export async function openDaemonHost(input: DaemonHostOpenInput): Promise<DaemonHost> {
  const cells = new Map<string, RepoCell>(),
    warming = new Map<string, RepoCellStatus>(),
    warmingSettlements = new Map<string, ReturnType<typeof makeWarmingSettlement>>(),
    openings = new Map<string, Promise<void>>(),
    attachTimeoutMs = input.attachTimeoutMs ?? 60_000,
    openCell = input.openCell ?? openRepoCell,
    runtimeDaemonRoute = {
      userRoot: input.userRoot,
      daemonId: input.daemonId,
      endpoint: input.endpoint ?? localUserDaemonEndpoint(input.userRoot, input.daemonId),
    },
    remoteProxy = openRemoteProxyManager(input.userRoot),
    replicaSyncControllers = new Map<string, { readonly controller: AbortController; readonly config: string }>();
  const unavailable = new Map<string, RepoCellStatus>(),
    unavailableProbes = new Map<string, ReturnType<typeof makeRecoveryProbe>>(),
    controls = new Map<string, DaemonControlReceipt>(),
    runtimeDiscovery = input.runtimeDiscover ?? (() => discoverRuntimeInstallations());
  let discoveredInstallations: readonly RuntimeInstallationWitness[] = [],
    discoveryInFlight: Promise<readonly RuntimeInstallationWitness[]> | null = null;
  const refreshDiscovery = (): Promise<readonly RuntimeInstallationWitness[]> => {
      if (discoveryInFlight) return discoveryInFlight;
      const active = Promise.resolve(runtimeDiscovery()).then((witnessed) => {
        discoveredInstallations = witnessed;
        return witnessed;
      });
      discoveryInFlight = active;
      void active.then(
        () => {
          if (discoveryInFlight === active) discoveryInFlight = null;
        },
        () => {
          if (discoveryInFlight === active) discoveryInFlight = null;
        },
      );
      return active;
    },
    discover = () => discoveredInstallations,
    vault = input.runtimeCredentialPort ?? credentialPort(),
    instanceStore = openRuntimeInstanceStore({
      userRoot: input.userRoot,
      discover,
      refreshDiscovery,
      env: input.runtimeEnv,
      resolveCredential: vault.resolve,
      // Resolved by the resident daemon entry (the one process that owns the operator login);
      // host constructors that supply nothing inject no GitHub credential.
      resolveGithubToken: input.runtimeGithubToken,
    }),
    instances = { ...instanceStore, ...runtimeInstanceCredentialService(instanceStore, vault) },
    decisionProviders = openDecisionProviderService({
      userRoot: input.userRoot,
      vault,
      isCredentialInUse: (reference) =>
        instanceStore
          .list()
          .some(
            (config) =>
              (config.auth.mode === "api-key" && config.auth.credentialRef === reference) ||
              Object.values(config.hostingCredentialRefs ?? {}).includes(reference),
          ),
    }),
    runtimePorts = openDaemonRuntimePorts({ userRoot: input.userRoot, instances }),
    startedAt = input.startedAt ?? new Date().toISOString(),
    now = input.now ?? (() => new Date().toISOString()),
    initialRegistry = readDaemonRegistry({ userRoot: input.userRoot }),
    buildObserver = observeDaemonBuild(input.runtimeFile),
    fleetEdgeRuntimes = new Map<string, ReturnType<typeof openFleetEdgeRuntime>>();
  const oidc = input.oidc ?? new OidcSessionService(input.userRoot),
    {
      writerEpochLease,
      writerEpochFence,
      writerEpochHighWatermark,
      retireWriterEpoch,
      closeDaemonWriterEpoch,
      daemonWriterBinding,
    } = openDaemonWriterEpochs({ userRoot: input.userRoot, daemonId: input.daemonId, now });
  // Assigned once the managed identity center's resume is fired below; every center consultation
  // awaits it, so a center still resuming reads as a slow startup instead of a broken repo (a
  // build-superseded successor's first attach lost exactly that race and latched its repo).
  let rbacResumed: Promise<void> = Promise.resolve();
  const keycloakCenter: KeycloakCenterAuthority = async (rejectedAccessToken) => {
    await rbacResumed;
    return { ...(await oidc.center(rejectedAccessToken)), clientId: "harness-center" };
  };
  const keycloakSession = async () => {
    await rbacResumed;
    const principal = (await oidc.bind({ transportKind: "unix-socket" })).oidcPrincipal;
    if (!principal) throw hostCodedError("authentication_required", "Sign in before continuing a runtime.");
    return { personId: principal.personId, accessToken: principal.accessToken, ...principal.authority };
  };
  // The automatic disposition launches through the same local session source as a manual
  // `ha agent run`: the persisted dispatch binding has no credential of its own.
  const decisionPointExecutorFor = openDecisionPointExecutorFactory({
    providers: { list: decisionProviders.list, port: decisionProviders.port },
    now,
    keycloakSession,
  });
  const hostBinding: DaemonHostApiContext["binding"] = async (
    rootDir,
    auth,
    executor = null,
    writerRepoId,
    replicaRead = false,
  ) => {
    // Session authorization also consults Keycloak, without using the center supplier.
    await rbacResumed;
    const execution = auth.executionCredential
      ? await authenticateRuntimeExecutionCredential(await keycloakCenter(), auth.executionCredential)
      : auth.executionPrincipal;
    if (execution) {
      if (
        auth.nodePrincipal &&
        (typeof execution.source !== "object" ||
          execution.source.kind !== "node" ||
          execution.source.nodeId !== auth.nodePrincipal.nodeId ||
          execution.personId !== auth.nodePrincipal.personId)
      )
        throw executionCredentialRejected();
      const cell = cells.get(execution.repoId);
      if (!cell || path.resolve(cell.status().rootDir) !== path.resolve(rootDir))
        throw hostCodedError(
          "execution_credential_rejected",
          "Execution credential belongs to a different repository.",
        );
      const deviceSession = await deriveBinding(rootDir, await oidc.bind(auth));
      if (deviceSession.actor.principal.personId !== execution.personId) throw executionCredentialRejected();
      const base = {
        actor: runtimeExecutionActor(execution),
        source: execution.source,
        executionPrincipal: execution,
        writerEpoch: auth.writerEpoch,
        withWriterEpochFence: auth.withWriterEpochFence,
        writerEpochFence: auth.writerEpochFence,
        ...(cell.status().mode === "remote-edge"
          ? {}
          : {
              keycloakAuthorization: { ...deviceSession.keycloakAuthorization, center: keycloakCenter },
            }),
      };
      return writerRepoId ? daemonWriterBinding(writerRepoId, base) : base;
    }
    const edge = readDaemonRegistry({ userRoot: input.userRoot }).repos.some(
        (repo) => repo.canonicalRoot === rootDir && repo.mode === "remote-edge",
      ),
      principal =
        edge && replicaRead
          ? await deriveBinding(rootDir, { ...(await oidc.bind(auth, true)), keycloakCenter }, executor, true)
          : await deriveBinding(rootDir, { ...(await oidc.bind(auth)), keycloakCenter }, executor),
      base = edge
        ? principal
        : {
            ...principal,
            keycloakAuthorization: { ...principal.keycloakAuthorization, center: keycloakCenter },
          };
    return writerRepoId ? daemonWriterBinding(writerRepoId, base) : base;
  };
  const edgeRuntimeFor = (request: FleetEdgeRuntimeRequest["payload"]) => {
      const key = `${request.repoId}\0${request.nodeId}\0${request.host}\0${request.port}`,
        runtime =
          fleetEdgeRuntimes.get(key) ??
          openFleetEdgeRuntime({
            request,
            readBinding: async () => {
              const binding = await hostBinding(request.workspaceRoot, { transportKind: "unix-socket" });
              return { ...binding, source: { kind: "node", nodeId: request.nodeId } };
            },
            daemonGeneration: Date.now() * 1000 + (process.pid % 1000),
            daemonRoute: runtimeDaemonRoute,
            ports: runtimePorts,
            waitForReplicaReady: () =>
              waitForFleetReplicaReady({
                viewRoot: path.isAbsolute(request.viewRoot)
                  ? request.viewRoot
                  : path.resolve(request.workspaceRoot, request.viewRoot),
                repoId: request.repoId,
                nodeId: request.nodeId,
              }),
            ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
            now,
          });
      fleetEdgeRuntimes.set(key, runtime);
      return runtime;
    },
    scheduleScheduler = makeScheduleScheduler({
      cells,
      now,
      localBinding: async (repoId, rootDir, action) => {
        const system = localSystemBinding(rootDir);
        if (action.kind === "schedule-list") return system;
        const cell = cells.get(repoId);
        if (!cell) throw hostCodedError("repo_unavailable", `Schedule repository ${repoId} is unavailable.`);
        const receipt = await cell.run({ kind: "schedule-show", scheduleId: action.scheduleId }, system),
          schedule = (receipt as unknown as { readonly schedule?: import("@harness-anything/kernel").ScheduleV1 })
            .schedule;
        if (!schedule || validateScheduleV1(schedule).length)
          throw hostCodedError("invalid_schedule", "Schedule execution requires its canonical creator identity.");
        const current = await hostBinding(rootDir, { transportKind: "unix-socket" });
        if (current.actor.principal.personId !== schedule.createdBy.principal.personId)
          throw hostCodedError("authentication_required", "The schedule creator must sign in on this device.");
        return daemonWriterBinding(repoId, current);
      },
      remoteEdgeAction: async (repoId, rootDir, action) => {
        const config = readFleetEdgeConfig(rootDir);
        if (!config || config.repoId !== repoId)
          throw hostCodedError(
            "fleet_edge_config_invalid",
            `Remote-edge Schedule ${repoId} requires a matching fleet-edge.json.`,
          );
        const request: FleetEdgeRuntimeRequest["payload"] = {
          ...config,
          repoId,
          workspaceRoot: rootDir,
          method: "repo.schedule.run",
          action,
        };
        return edgeRuntimeFor(request).run(request.method, action);
      },
    });
  let latestControl: DaemonControlReceipt | null = null;
  let fleetCenter: FleetTlsCenter | null = null;
  let initialAttachments: Promise<void> | null = null,
    initialAttachmentsSettled = false,
    replicaSyncStartQueued = false,
    closing = false;
  // An unavailable row reports no writer generation or queue: the cell that would own them
  // never opened, so a zero would be a fabricated measurement rather than an unknown.
  const unavailableStatus = (
    repoId: string,
    rootDir: string,
    mode: DaemonRepoMode,
    error: unknown,
  ): RepoCellStatus => ({
    repoId,
    rootDir,
    mode,
    state: "unavailable",
    generation: null,
    queueDepth: null,
    recoveryMs: null,
    materialization: null,
    lastError: daemonErrorMessage(error),
    causeClass: causeClassOf(error),
  });
  const warmingStatus = (repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly mode: DaemonRepoMode;
  }): RepoCellStatus => ({
    repoId: repo.repoId,
    rootDir: repo.canonicalRoot,
    mode: repo.mode,
    state: "warming",
    generation: null,
    queueDepth: null,
    recoveryMs: null,
    materialization: null,
    lastError: null,
    causeClass: null,
    attach: {
      phase: "opening",
      applied: null,
      total: null,
      watermark: null,
    },
  });
  const warmingMessage = (repoId: string): string => {
    const status = warming.get(repoId),
      attach = status?.attach;
    if (attach?.phase === "catching-up" && attach.applied !== null && attach.total !== null)
      return `Repository ${repoId} is still warming; waiting for projection catch-up (${attach.applied}/${attach.total} events applied).`;
    return `Repository ${repoId} is still warming; waiting for ${attach?.phase ?? "background attachment"} to complete.`;
  };
  const markWarming = (repoId: string, status: RepoCellStatus): void => {
    warming.set(repoId, status);
    if (!warmingSettlements.has(repoId)) warmingSettlements.set(repoId, makeWarmingSettlement());
  };
  const settleWarming = (repoId: string): void => {
    warming.delete(repoId);
    const settlement = warmingSettlements.get(repoId);
    warmingSettlements.delete(repoId);
    settlement?.resolve();
  };
  const latchUnavailable = (repoId: string, status: RepoCellStatus): void => {
    settleWarming(repoId);
    unavailable.set(repoId, status);
    const probe = makeRecoveryProbe(latchReprobeThrottleMs);
    probe.latch();
    unavailableProbes.set(repoId, probe);
  };
  for (const repo of initialRegistry.invalidRepos)
    if (repo.state !== "disabled") latchUnavailable(invalidRepoId(repo), invalidRegistryStatus(repo));
  const repos = initialRegistry.repos.filter(
    (
      repo,
    ): repo is typeof repo & {
      readonly canonicalRoot: string;
      readonly authoredBranch: string;
    } =>
      repo.state === "enabled" &&
      repo.mode !== "remote-proxy" &&
      repo.canonicalRoot !== null &&
      repo.authoredBranch !== null,
  );
  for (const repo of repos) markWarming(repo.repoId, warmingStatus(repo));
  const extracted: DaemonHostRegistryContext = {
    cells,
    input,
    settleWarming,
    unavailable,
    openings,
    performOpenRegistered,
    raceAttachBudget,
    attachTimeoutMs,
    attachBudgetError,
    openCell,
    writerEpochFence,
    runtimePorts,
    decisionPointExecutorFor,
    runtimeDaemonRoute,
    keycloakCenter,
    keycloakSession,
    scheduleScheduler,
    edgeRuntimeFor,
    invalidRepoId,
    closeCell,
    unavailableProbes,
    warming,
    latchUnavailable,
    invalidRegistryStatus,
    pruneMissingRoot,
    markWarming,
    warmingStatus,
    openRegistered,
    unavailableStatus,
    waitForWarming,
    now,
    warmingSettlements,
    startInitialAttachments,
    get initialAttachments() {
      return initialAttachments;
    },
    set initialAttachments(value) {
      initialAttachments = value;
    },
    attachInitial,
    repos,
    get closing() {
      return closing;
    },
    set closing(value) {
      closing = value;
    },
    admitHostMode,
    hostCodedError,
    get point() {
      return point;
    },
    code,
    daemonErrorMessage,
    diagnosticForError,
    controls,
    get latestControl() {
      return latestControl;
    },
    set latestControl(value) {
      latestControl = value;
    },
  };

  const attach = async (rootDir: string, repoId: string, mode?: DaemonRepoMode) => {
    const root = canonicalRoot(rootDir),
      id = workspaceId(repoId);
    const registered = registerDaemonRepo({
      canonicalRoot: root,
      repoId,
      mode,
      userRoot: input.userRoot,
      createConvenienceLinks: false,
    });
    const loaded = cells.get(repoId);
    if (loaded && loaded.status().mode !== registered.repo.mode) await closeCell(repoId);
    if (registered.repo.authoredBranch === null || registered.repo.canonicalRoot === null)
      throw hostCodedError(
        "registry_repo_invalid",
        `Workspace repository ${repoId} has no authored branch or canonical root.`,
      );
    // The registry row, not the caller's path, is what the attach is opened against: registering a
    // subdirectory records the enclosing harness root, and publication re-reads that same row.
    const registeredRoot = canonicalRoot(registered.repo.canonicalRoot);
    if (!cells.has(repoId))
      try {
        markWarming(
          repoId,
          warmingStatus({
            ...registered.repo,
            repoId: id,
            canonicalRoot: registeredRoot,
          }),
        );
        await openRegistered({
          ...registered.repo,
          repoId: id,
          canonicalRoot: registeredRoot,
          authoredBranch: registered.repo.authoredBranch,
        });
      } catch (error) {
        consumeKnownError(error);
        latchUnavailable(repoId, unavailableStatus(repoId, registeredRoot, registered.repo.mode, error));
      }
    startReplicaSyncs();
    return registered;
  };
  const point = () => ({
    daemonId: input.daemonId,
    pid: process.pid,
    startedAt,
  });
  const home = async (auth: DaemonAuthenticationContext) => {
    localOnly(auth);
    return readHomeOverview({ context: hostContext, auth });
  };
  const system = (auth: DaemonAuthenticationContext): JsonObject => {
    localOnly(auth);
    const registry = readDaemonRegistry({ userRoot: input.userRoot }),
      observedAt = new Date().toISOString(),
      validRows = registry.repos.map((repo) => {
        const status = cells.get(repo.repoId)?.status() ?? warming.get(repo.repoId) ?? unavailable.get(repo.repoId),
          disabled = repo.state === "disabled",
          proxy = repo.mode === "remote-proxy",
          attached = status?.state === "attached",
          warmingUp = status?.state === "warming";
        return {
          repoId: repo.repoId,
          displayName: repo.displayName,
          canonicalRoot: repo.canonicalRoot,
          authoredBranch: repo.authoredBranch,
          registrationState: repo.state,
          connectionId: repo.connectionId,
          mode: repo.mode,
          cellState: disabled || proxy ? "not_loaded" : attached ? "attached" : warmingUp ? "warming" : "unavailable",
          generation: disabled ? null : (status?.generation ?? null),
          queueDepth: disabled ? null : (status?.queueDepth ?? null),
          lockState: disabled || proxy ? "not_applicable" : attached ? "held" : "unknown",
          recoveryMs: disabled ? null : (status?.recoveryMs ?? null),
          lastError: disabled ? null : (status?.lastError ?? null),
          unavailableReason:
            disabled || proxy || attached || warmingUp ? null : (status?.lastError ?? "unknown / not projected"),
        };
      }),
      invalidRows = registry.invalidRepos.map(invalidRegistrySystemRow);
    return {
      schema: "gui-system-status/v1",
      ok: true,
      observedAt,
      daemon: {
        ...point(),
        protocolVersion: currentDaemonProtocolVersion,
        uptimeMs: Math.max(0, Date.parse(observedAt) - Date.parse(startedAt)),
        endpoint: input.endpoint ?? auth.endpoint ?? "local-unix-socket",
        build: {
          version: process.env.npm_package_version ?? "0.0.0",
          commitSha: daemonBuildStamp().commit,
        },
        activeControl: latestControl
          ? {
              kind: latestControl.kind,
              operationId: latestControl.operationId,
              phase: latestControl.phase,
              requestedAt: latestControl.requestedAt,
              error: latestControl.error,
            }
          : null,
      },
      repos: [...validRows, ...invalidRows].sort((a, b) => a.repoId.localeCompare(b.repoId)),
    };
  };
  const accessAdminRef: { current: AccessAdminService | null } = { current: null };
  const managedRbac = input.managedRbac ?? new ManagedRbacService(input.userRoot);
  const hostContext: DaemonHostApiContext = {
    remoteProxy,
    cells,
    unavailable,
    input,
    runtimePorts,
    decisionPointExecutorFor,
    failedConfigureVerify,
    hostCodedError,
    binding: hostBinding,
    keycloakCenter,
    keycloakSession,
    oidc,
    loginListenerCertificate: () => managedRbac.loginListenerCertificate(),
    get accessAdmin() {
      return accessAdminRef.current!;
    },
    writerEpochFence,
    writerEpochLease,
    writerEpochHighWatermark,
    retireWriterEpoch,
    closeDaemonWriterEpoch,
    attach,
    localOnly,
    settleWarming,
    markWarming,
    warmingStatus,
    latchUnavailable,
    unavailableStatus,
    openCell,
    closeCell,
    publicRegistryRepo,
    admitHostMode,
    rejectHostAction,
    attemptHostRecovery,
    warming,
    warmingMessage,
    code,
    daemonErrorMessage,
    diagnosticForError,
    requiredCell,
    rejectPresetRun,
    recoverableRunId,
    requireHostMode,
    get fleetCenter() {
      return fleetCenter;
    },
    set fleetCenter(value) {
      fleetCenter = value;
    },
    fleetEdgeRuntimes,
    runtimeDaemonRoute,
    scheduleScheduler,
    edgeRuntimeFor,
    instances,
    decisionProviders,
    requiredText,
    point,
    controls,
    get latestControl() {
      return latestControl;
    },
    set latestControl(value) {
      latestControl = value;
    },
    refreshRegistry,
    // Declared below; resolved when an edge sync calls it.
    startReplicaSyncs: () => startReplicaSyncs(),
    settleControl,
    buildObserver,
    startInitialAttachments,
    waitForWarming,
    get closing() {
      return closing;
    },
    set closing(value) {
      closing = value;
    },
    get initialAttachments() {
      return initialAttachments;
    },
    get host() {
      return host;
    },
    system,
    home,
    now,
    startedAt,
  };
  // A node removal settles in the access-admin queue; the fleet center owns the node's
  // live TLS sessions, so the settled cut is handed from one to the other here.
  const accessAdmin = new AccessAdminService(oidc, input.userRoot, {
    daemonId: input.daemonId,
    onNodeRemoved: (nodeId) => hostContext.fleetCenter?.disconnectNode(nodeId),
    ...(input.sshTunnels ? { sshTunnels: input.sshTunnels } : {}),
    ...(input.edgeJoins ? { edgeJoins: input.edgeJoins } : {}),
  });
  accessAdminRef.current = accessAdmin;
  const lifecycle = createDaemonHostLifecycleApi(hostContext);
  // The resume failure is recorded, not surfaced: a center that cannot come back still fails
  // every consultation honestly through oidc.center(), without a second error shape.
  rbacResumed = managedRbac.resume().catch((error: unknown) =>
    input.recordLifecycle?.({
      event: "rbac_resume_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const parkedWaitController = new AbortController(),
    edgeJoinProgress = createEdgeJoinProgressTap();
  const host: DaemonHost = {
    remoteProxy,
    home,
    keycloakCenter,
    sessionPrincipal: async (auth) => {
      await rbacResumed;
      return (await oidc.bind(auth)).oidcPrincipal;
    },
    parkedWaitSignal: parkedWaitController.signal,
    ...createDaemonHostRepositoryApi(hostContext),
    ...createDaemonHostRuntimeApi(hostContext),
    ...createDaemonHostControlApi(hostContext),
    ...lifecycle,
    manageRbac: (request, auth) => {
      localOnly(auth);
      return (async () => {
        if (request.operation === "edge-join-progress")
          return { ok: true, command: "edge-join", ...edgeJoinProgress.read() };
        if (request.operation === "edge-join")
          return joinFleetEdge(
            {
              link: String(request.link ?? ""),
              ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
              ...(request.quotaBytes === undefined ? {} : { quotaBytes: request.quotaBytes }),
            },
            {
              session: async () => (await oidc.bind(auth)).oidcPrincipal,
              beginLogin: (authority) => oidc.beginDevice(undefined, authority),
              register: (rootDir, repoId) =>
                host.admin({ kind: "register", rootDir, repoId, mode: "remote-edge" }, auth),
              sync: (payload) => host.fleet.edgeSync(payload, auth),
              onProgress: edgeJoinProgress.record,
            },
          );
        if (request.mode === "external") return oidc.configureAuthority(() => managedRbac.run(request));
        const loginTarget =
          request.rootDir ??
          (request.repoId
            ? (readDaemonRegistry({ userRoot: input.userRoot }).repos.find((repo) => repo.repoId === request.repoId)
                ?.canonicalRoot ?? undefined)
            : undefined);
        if (request.repoId && !loginTarget)
          throw hostCodedError("repo_namespace_unknown", "Select a registered repository for login.");
        if (
          (request.operation === "health" || request.operation === "bootstrap-status") &&
          loginTarget &&
          readFleetEdgeConfig(loginTarget)
        )
          return oidc
            .bindingHealth(loginTarget)
            .then((health) => (request.operation === "bootstrap-status" ? { ...health, required: false } : health));
        if (request.operation === "login")
          return oidc.beginDevice(
            loginTarget,
            request.loginUrl && request.loginRealm && request.loginClientId
              ? { url: request.loginUrl, realm: request.loginRealm, clientId: request.loginClientId }
              : undefined,
          );
        if (request.operation === "login-poll") return oidc.pollDevice();
        if (request.operation === "login-begin") {
          if (!request.redirectUri) throw hostCodedError("oidc_redirect_required", "Login requires redirectUri.");
          return oidc.begin(request.redirectUri, loginTarget);
        }
        if (request.operation === "login-complete") {
          if (!request.code || !request.state)
            throw hostCodedError("oidc_callback_invalid", "Login completion requires code and state.");
          return oidc.complete(request.code, request.state);
        }
        if (request.operation === "device-approval") return oidc.deviceApproval(request.code ?? "");
        if (request.operation === "session") return oidc.status();
        if (request.operation === "logout") return oidc.logout();
        if (request.operation === "bootstrap-status") return oidc.bootstrapStatus();
        if (request.operation === "bootstrap-admin") {
          const required = [request.username, request.email, request.displayName, request.password, request.personId];
          if (required.some((value) => typeof value !== "string" || value.trim() === ""))
            throw hostCodedError("bootstrap_admin_invalid", "First administrator fields must be non-empty strings.");
          return oidc.bootstrapAdmin({
            username: request.username!,
            email: request.email!,
            displayName: request.displayName!,
            password: request.password!,
            personId: request.personId!,
          });
        }
        if (request.operation === "invite") {
          const required = [request.username, request.email, request.displayName, request.personId];
          if (required.some((value) => typeof value !== "string" || value.trim() === ""))
            throw hostCodedError("invite_invalid", "Invitation fields must be non-empty strings.");
          return oidc.invite({
            username: request.username!,
            email: request.email!,
            displayName: request.displayName!,
            personId: request.personId!,
          });
        }
        if ((accessAdminOperations as readonly string[]).includes(request.operation ?? "bootstrap")) {
          const accessAction =
            request.operation === "permission-request-create"
              ? "permission-request-create"
              : request.operation === "permission-request-decide"
                ? "permission-request-decide"
                : request.operation === "permission-request-withdraw"
                  ? "permission-request-withdraw"
                  : undefined;
          if (accessAction)
            await requireAuthorizedFleetAction({
              kind: accessAction,
              userRoot: input.userRoot,
              auth,
              actionId: `${accessAction}:${request.requestId ?? request.operationId ?? "request"}`,
              evaluatedAtCut: "keycloak:current",
              ...(request.repoId ? { repoId: request.repoId } : {}),
            });
          return accessAdmin.run(request, auth.executionPrincipal?.personId);
        }
        if (request.operation === "listener-set") return oidc.configureAuthority(() => managedRbac.run(request));
        return requireAuthorizedHostAction({
          kind: "rbac-bootstrap",
          // Lifecycle bootstrap is the sole socket-owner exception: it can install/start the
          // identity authority before an OIDC session exists, but it cannot run repository actions.
          binding: localSystemBinding(input.userRoot),
          actionId: `rbac-bootstrap:${request.operation ?? "bootstrap"}`,
          evaluatedAtCut: "daemon-rbac:current",
        }).then(() => managedRbac.run(request));
      })();
    },
    close: async () => {
      parkedWaitController.abort();
      for (const { controller } of replicaSyncControllers.values()) controller.abort();
      replicaSyncControllers.clear();
      await rbacResumed;
      await accessAdmin.close();
      await managedRbac.stop();
      await lifecycle.close();
    },
  };
  const startReplicaSyncs = (): void => {
    // A registry refresh can arrive while the initial attach fan-out is still opening cells. Starting
    // a remote-edge stream here races the cell's publication boundary and exposes sync failures
    // before the host reports attachment. Defer that refresh until the same initial barrier used by
    // attachmentsSettled(); calls made after startup remain immediate.
    if (initialAttachments && !initialAttachmentsSettled) {
      if (!replicaSyncStartQueued) {
        replicaSyncStartQueued = true;
        void initialAttachments.then(() => {
          replicaSyncStartQueued = false;
          startReplicaSyncs();
        });
      }
      return;
    }
    const registered = readDaemonRegistry({ userRoot: input.userRoot }).repos,
      activeRemoteEdges = new Set<string>();
    for (const repo of registered) {
      if (repo.state !== "enabled" || repo.mode !== "remote-edge" || repo.canonicalRoot === null) continue;
      const rootDir = repo.canonicalRoot,
        config = readFleetEdgeConfig(rootDir);
      if (!config || config.repoId !== repo.repoId) continue;
      activeRemoteEdges.add(repo.repoId);
      // A stream follows its fleet-edge.json: an edge sync that changed the connection restarts it.
      const running = replicaSyncControllers.get(repo.repoId),
        connection = JSON.stringify(config);
      if (running?.config === connection) continue;
      running?.controller.abort();
      const controller = new AbortController();
      replicaSyncControllers.set(repo.repoId, { controller, config: connection });
      const viewRoot = path.isAbsolute(config.viewRoot) ? config.viewRoot : path.resolve(rootDir, config.viewRoot);
      const caPath = path.isAbsolute(config.caPath) ? config.caPath : path.resolve(rootDir, config.caPath);
      void runFleetReplicaSync({
        readAccessToken: async () => {
          const auth = await oidc.bind({ transportKind: "unix-socket" });
          // Resolve the current session token at request time so refreshes are observed.
          return auth.localSessionAccessToken ? await auth.localSessionAccessToken() : auth.oidcPrincipal?.accessToken;
        },
        hostname: config.host,
        port: config.port,
        ca: readFileSync(caPath),
        ...(config.servername ? { servername: config.servername } : {}),
        nodeId: config.nodeId,
        credential: config.credential,
        ...(config.humanClientId ? { humanClientId: config.humanClientId } : {}),
        repoId: config.repoId,
        viewRoot,
        diskQuotaBytes: config.quotaBytes,
        signal: controller.signal,
        onConfirmed: async (changedPaths) => {
          applyFleetMirrorCut(viewRoot, config.repoId, rootDir, "pull", { changedPaths });
          await edgeRuntimeFor({
            ...config,
            caPath,
            viewRoot,
            workspaceRoot: rootDir,
            method: "repo.squad.control",
            action: {},
          }).reconcile();
        },
        onConfirmedFailure: (error) =>
          input.recordLifecycle?.({
            event: "replica_confirm_failed",
            repoId: repo.repoId,
            error: error instanceof Error ? error.message : String(error),
          }),
        onFailure: (error) =>
          input.recordLifecycle?.({
            event: "replica_sync_failed",
            repoId: repo.repoId,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
    }
    for (const [repoId, { controller }] of replicaSyncControllers) {
      if (activeRemoteEdges.has(repoId)) continue;
      controller.abort();
      replicaSyncControllers.delete(repoId);
    }
  };
  // Restore only a previously authorized successful start, after every callback's captured
  // host and service has been initialized. No user session is stored or replayed here.
  try {
    const config = readFleetCenterConfig(input.userRoot, input.daemonId);
    if (config) {
      const authorityRepo = readDaemonRegistry({ userRoot: input.userRoot }).repos.find(
        (repo) =>
          repo.repoId === config.repoId &&
          repo.state === "enabled" &&
          repo.mode !== "remote-proxy" &&
          repo.canonicalRoot !== null,
      );
      if (!authorityRepo)
        throw hostCodedError("repo_namespace_unknown", "Saved fleet center authority repository is not enabled.");
      const started = await startFleetCenterAdmission(
        await prepareFleetCenterAdmission({
          host,
          buildDraining: input.buildDraining,
          onDeliverySettled: input.onRepoStatusChange,
          userRoot: input.userRoot,
          writerEpochLease: hostContext.writerEpochLease,
          payload: config,
          nodes: {
            ...keycloakNodeRegistry(hostContext.keycloakCenter),
            loginAuthority: (nodeId) => oidc.discovery(nodeId),
            revokeDeviceSessions: (nodeId) => oidc.revokeDeviceSessions(nodeId),
            deviceLoginNotice: (nodeId, personId, notice) => oidc.receiveDeviceNotice(nodeId, personId, notice),
            verifyHuman: (auth) => oidc.bind(auth),
            edgeJoin: (input) =>
              accessAdmin.admitEdgeJoin({
                joinId: input.joinId,
                inviteToken: input.inviteToken,
                accessToken: input.accessToken ?? "",
              }),
          },
        }),
      );
      fleetCenter = started.center;
      await accessAdmin.resumeEdgeJoinTunnels(started.center.port);
    }
  } catch (error) {
    input.recordLifecycle?.({
      event: "fleet_center_restore_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    // The local control daemon remains available to repair the listener with an authorized start.
    return host;
  }
  return host;
  async function closeCell(repoId: string): Promise<void> {
    return closeCellImpl(extracted, repoId);
  }
  function pruneMissingRoot(repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly registeredAt: string;
  }): boolean {
    return pruneMissingRootImpl(extracted, repo);
  }
  function openRegistered(
    repo: {
      readonly repoId: string;
      readonly canonicalRoot: string;
      readonly authoredBranch: string;
      readonly mode: DaemonRepoMode;
    },
    progress?: { readonly attachIndex: number; readonly attachTotal: number },
  ): Promise<void> {
    return openRegisteredImpl(extracted, repo, progress);
  }
  function raceAttachBudget(
    opening: Promise<void>,
    repoId: string,
    progress?: { readonly attachIndex: number; readonly attachTotal: number },
  ): Promise<void> {
    return raceAttachBudgetImpl(extracted, opening, repoId, progress);
  }
  async function performOpenRegistered(
    repo: {
      readonly repoId: string;
      readonly canonicalRoot: string;
      readonly authoredBranch: string;
      readonly mode: DaemonRepoMode;
    },
    progress?: { readonly attachIndex: number; readonly attachTotal: number },
  ): Promise<void> {
    return performOpenRegisteredImpl(extracted, repo, progress);
  }
  async function refreshRegistry(): Promise<void> {
    await refreshRegistryImpl(extracted);
    startReplicaSyncs();
  }
  async function attemptHostRecovery(repoId: string): Promise<void> {
    return attemptHostRecoveryImpl(extracted, repoId);
  }
  async function waitForWarming(repoId: string): Promise<void> {
    return waitForWarmingImpl(extracted, repoId);
  }
  function startInitialAttachments(): Promise<void> {
    return startInitialAttachmentsImpl(extracted).then(() => {
      initialAttachmentsSettled = true;
      startReplicaSyncs();
      return scheduleScheduler.start();
    });
  }
  async function attachInitial(): Promise<void> {
    return attachInitialImpl(extracted);
  }
  function admitHostMode(
    repoId: string,
    command: CommandTopology,
    auth: DaemonAuthenticationContext,
  ): RepoModeAdmission {
    return admitHostModeImpl(extracted, repoId, command, auth);
  }
  function requireHostMode(repoId: string, command: CommandTopology, auth: DaemonAuthenticationContext): void {
    return requireHostModeImpl(extracted, repoId, command, auth);
  }
  function settleControl(pending: DaemonControlReceipt, ok: boolean, error?: unknown): void {
    return settleControlImpl(extracted, pending, ok, error);
  }
}

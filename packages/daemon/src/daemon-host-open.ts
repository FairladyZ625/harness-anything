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
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import {
  admitHostMode as admitHostModeImpl,
  requireHostMode as requireHostModeImpl,
  settleControl as settleControlImpl,
} from "./daemon-host-admission.ts";
import { binding as deriveBinding, localSystemBinding, withDaemonWriterEpochFence } from "./daemon-host-binding.ts";
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
import { requireAuthorizedHostAction } from "./host-action-authorization.ts";
import { openFleetEdgeRuntime, type FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import type { FleetTlsCenter } from "./fleet/center.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { canonicalRoot, workspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { causeClassOf, latchReprobeThrottleMs, openRepoCell, type RepoCell, type RepoCellStatus } from "./repo-cell.ts";
import { type RepoModeAdmission } from "./repo-mode.ts";
import type { RuntimeLauncher } from "./runtime-spawn.ts";
import { makeScheduleScheduler } from "./schedule-scheduler.ts";
import type { DaemonAuthenticationContext, KeycloakCenterAuthority } from "./transport/auth-context.ts";
import type { DaemonHostApiContext, DaemonHostRegistryContext } from "./daemon-host-context.ts";
import { openRemoteProxyManager } from "./remote-proxy.ts";
import { credentialPort, type CredentialPort } from "./agent-runtime-credential-port.ts";
import { runtimeInstanceCredentialService } from "./runtime-instance-credentials.ts";
import {
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  type PersistentWriterEpoch,
  type WriterEpochLease,
} from "./writer-epoch.ts";
import { AccessAdminService, accessAdminOperations } from "./access-admin-service.ts";
import { ManagedRbacService } from "./managed-rbac-service.ts";
import { OidcSessionService } from "./oidc-session-service.ts";
import { FleetReplicaSessionPool, runFleetReplicaSync } from "./fleet/edge-replica-sync.ts";

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
  readonly runtimeCredentialPort?: CredentialPort;
  readonly runtimeFile?: string;
  readonly shutdownRequested?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  readonly onRepoStatusChange?: () => void;
  /** The daemon's one OIDC session service; the transport binds requests through the same instance. */
  readonly oidc?: OidcSessionService;
  /** The managed identity center's lifecycle; a hermetic host substitutes it to stage its resume. */
  readonly managedRbac?: Pick<ManagedRbacService, "run" | "resume" | "stop">;
  readonly attachTimeoutMs?: number;
  readonly openCell?: (
    input: Parameters<typeof openRepoCell>[0] & { readonly onStatus?: (status: RepoCellStatus) => void },
  ) => Promise<RepoCell>;
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
    replicaSessionPool = new FleetReplicaSessionPool(),
    replicaSyncControllers = new Map<string, AbortController>();
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
    }),
    instances = { ...instanceStore, ...runtimeInstanceCredentialService(instanceStore, vault) },
    runtimePorts = {
      runtimeInstances: instances.listPublic,
      prepareRuntimeLaunch: instances.prepareLaunch,
      prepareWorkerGitEnvironment: instances.prepareWorkerGitEnvironment,
    },
    startedAt = input.startedAt ?? new Date().toISOString(),
    now = input.now ?? (() => new Date().toISOString()),
    initialRegistry = readDaemonRegistry({ userRoot: input.userRoot }),
    buildObserver = observeDaemonBuild(input.runtimeFile),
    fleetEdgeRuntimes = new Map<string, ReturnType<typeof openFleetEdgeRuntime>>();
  let daemonWriterEpoch: PersistentWriterEpoch | null = null;
  const oidc = input.oidc ?? new OidcSessionService(input.userRoot),
    daemonWriterLeases = new Map<string, WriterEpochLease>(),
    writerEpochLease = (repoId: string, rootDir?: string) => {
      daemonWriterEpoch ??= openPersistentWriterEpoch({
        stateRoot: path.join(input.userRoot, "fleet"),
        holderId: `local-daemon:${input.daemonId}:${process.pid}`,
        now,
      });
      const existing = daemonWriterLeases.get(repoId);
      if (existing) return existing;
      const repo = readDaemonRegistry({ userRoot: input.userRoot }).repos.find((entry) => entry.repoId === repoId);
      // The lease database allocates epochs above the accepting ledger's enforced fence floor. Init
      // takes its lease before the registry row exists, so the caller passes the root it will write.
      const lease = daemonWriterEpoch.acquire(repoId, readLedgerWriterEpoch(repoId, repo?.canonicalRoot ?? rootDir));
      daemonWriterLeases.set(repoId, lease);
      return lease;
    },
    writerEpochFence = (repoId: string, rootDir?: string) => {
      const lease = writerEpochLease(repoId, rootDir);
      return {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot: path.join(input.userRoot, "fleet"),
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      };
    },
    writerEpochHighWatermark = (repoId: string) => {
      daemonWriterEpoch ??= openPersistentWriterEpoch({
        stateRoot: path.join(input.userRoot, "fleet"),
        holderId: `local-daemon:${input.daemonId}:${process.pid}`,
        now,
      });
      return daemonWriterEpoch.highWatermark(repoId);
    },
    retireWriterEpoch = (repoId: string) => {
      daemonWriterEpoch ??= openPersistentWriterEpoch({
        stateRoot: path.join(input.userRoot, "fleet"),
        holderId: `local-daemon:${input.daemonId}:${process.pid}`,
        now,
      });
      daemonWriterEpoch.retireCurrent(repoId);
      daemonWriterLeases.delete(repoId);
    },
    daemonWriterBinding = (repoId: string, base: ReturnType<typeof localSystemBinding>) => {
      if (base.writerEpochFence) return base;
      return withDaemonWriterEpochFence(base, writerEpochFence(repoId));
    };
  // Assigned once the managed identity center's resume is fired below; every center consultation
  // awaits it, so a center still resuming reads as a slow startup instead of a broken repo (a
  // build-superseded successor's first attach lost exactly that race and latched its repo).
  let rbacResumed: Promise<void> = Promise.resolve();
  const keycloakCenter: KeycloakCenterAuthority = async () => {
    await rbacResumed;
    return { ...(await oidc.center()), clientId: "harness-center" };
  };
  const hostBinding: DaemonHostApiContext["binding"] = async (
      rootDir,
      auth,
      executor = null,
      writerRepoId,
      replicaRead = false,
    ) => {
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
        // An edge holds no center authority; its reads authorize against the replica owner instead.
        const base = {
          actor: runtimeExecutionActor(execution),
          source: execution.source,
          executionPrincipal: execution,
          writerEpoch: auth.writerEpoch,
          withWriterEpochFence: auth.withWriterEpochFence,
          writerEpochFence: auth.writerEpochFence,
          ...(cell.status().mode === "remote-edge"
            ? {}
            : { keycloakAuthorization: { center: await keycloakCenter() } }),
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
              keycloakAuthorization: { ...principal.keycloakAuthorization, center: await keycloakCenter() },
            };
      return writerRepoId ? daemonWriterBinding(writerRepoId, base) : base;
    },
    closeDaemonWriterEpoch = () => {
      daemonWriterEpoch?.close();
      daemonWriterEpoch = null;
      daemonWriterLeases.clear();
    };
  void refreshDiscovery().catch(consumeKnownError);
  const edgeRuntimeFor = (request: FleetEdgeRuntimeRequest["payload"]) => {
      const key = `${request.repoId}\0${request.nodeId}\0${request.host}\0${request.port}`,
        runtime =
          fleetEdgeRuntimes.get(key) ??
          openFleetEdgeRuntime({
            request,
            daemonGeneration: Date.now() * 1000 + (process.pid % 1000),
            daemonRoute: runtimeDaemonRoute,
            ports: runtimePorts,
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
        return daemonWriterBinding(repoId, {
          actor: { principal: schedule.createdBy.principal, executor: null },
          source: "local",
          keycloakAuthorization: { center: await keycloakCenter() },
        });
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
  const warmingMessage = (repoId: string): string =>
    `Repository ${repoId} is still warming; wait for its background attachment to complete.`;
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
    runtimeDaemonRoute,
    keycloakCenter,
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
    return registered;
  };
  const point = () => ({
    daemonId: input.daemonId,
    pid: process.pid,
    startedAt,
  });
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
  const hostContext: DaemonHostApiContext = {
    remoteProxy,
    cells,
    unavailable,
    input,
    runtimePorts,
    failedConfigureVerify,
    hostCodedError,
    binding: hostBinding,
    keycloakCenter,
    oidc,
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
    now,
    startedAt,
  };
  const managedRbac = input.managedRbac ?? new ManagedRbacService(input.userRoot),
    // A node removal settles in the access-admin queue; the fleet center owns that node's
    // live TLS sessions, so the settled cut is handed from one to the other here.
    accessAdmin = new AccessAdminService(oidc, input.userRoot, {
      onNodeRemoved: (nodeId) => hostContext.fleetCenter?.disconnectNode(nodeId),
    }),
    lifecycle = createDaemonHostLifecycleApi(hostContext);
  // The resume failure is recorded, not surfaced: a center that cannot come back still fails
  // every consultation honestly through oidc.center(), without a second error shape.
  rbacResumed = managedRbac.resume().catch((error: unknown) =>
    input.recordLifecycle?.({
      event: "rbac_resume_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const parkedWaitController = new AbortController();
  const host: DaemonHost = {
    remoteProxy,
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
      if (request.operation === "login") return oidc.beginDevice(loginTarget);
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
      if ((accessAdminOperations as readonly string[]).includes(request.operation ?? "bootstrap"))
        return accessAdmin.run(request);
      if (request.operation === "listener-set") return oidc.configureAuthority(() => managedRbac.run(request));
      return requireAuthorizedHostAction({
        kind: "rbac-bootstrap",
        // Lifecycle bootstrap is the sole socket-owner exception: it can install/start the
        // identity authority before an OIDC session exists, but it cannot run repository actions.
        binding: localSystemBinding(input.userRoot),
        actionId: `rbac-bootstrap:${request.operation ?? "bootstrap"}`,
        evaluatedAtCut: "daemon-rbac:current",
      }).then(() => managedRbac.run(request));
    },
    close: async () => {
      parkedWaitController.abort();
      for (const controller of replicaSyncControllers.values()) controller.abort();
      replicaSyncControllers.clear();
      replicaSessionPool.close();
      await managedRbac.stop();
      await lifecycle.close();
    },
  };
  const startReplicaSyncs = (): void => {
    for (const repo of repos) {
      if (repo.mode !== "remote-edge" || replicaSyncControllers.has(repo.repoId)) continue;
      const config = readFleetEdgeConfig(repo.canonicalRoot);
      if (!config || config.repoId !== repo.repoId) continue;
      const controller = new AbortController();
      replicaSyncControllers.set(repo.repoId, controller);
      const viewRoot = path.isAbsolute(config.viewRoot)
        ? config.viewRoot
        : path.resolve(repo.canonicalRoot, config.viewRoot);
      const caPath = path.isAbsolute(config.caPath) ? config.caPath : path.resolve(repo.canonicalRoot, config.caPath);
      void runFleetReplicaSync({
        hostname: config.host,
        port: config.port,
        ca: readFileSync(caPath),
        ...(config.servername ? { servername: config.servername } : {}),
        nodeId: config.nodeId,
        credential: config.credential,
        repoId: config.repoId,
        viewRoot,
        diskQuotaBytes: config.quotaBytes,
        sessionPool: replicaSessionPool,
        signal: controller.signal,
        onConfirmed: () =>
          edgeRuntimeFor({
            ...config,
            caPath,
            viewRoot,
            workspaceRoot: repo.canonicalRoot,
            method: "repo.squad.control",
            action: {},
          }).reconcile(),
        onFailure: (error) =>
          input.recordLifecycle?.({
            event: "replica_sync_failed",
            repoId: repo.repoId,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
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
          userRoot: input.userRoot,
          writerEpochLease: hostContext.writerEpochLease,
          payload: config,
          nodes: {
            ...keycloakNodeRegistry(hostContext.keycloakCenter),
            loginAuthority: (nodeId) => oidc.discovery(nodeId),
            verifyHuman: (auth) => oidc.bind(auth),
          },
        }),
      );
      fleetCenter = started.center;
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
    return refreshRegistryImpl(extracted);
  }
  async function attemptHostRecovery(repoId: string): Promise<void> {
    return attemptHostRecoveryImpl(extracted, repoId);
  }
  async function waitForWarming(repoId: string): Promise<void> {
    return waitForWarmingImpl(extracted, repoId);
  }
  function startInitialAttachments(): Promise<void> {
    return startInitialAttachmentsImpl(extracted).then(() => {
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

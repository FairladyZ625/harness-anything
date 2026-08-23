/** @daemon-transport-authority Host composition and RepoCell ownership. */
import {
  consumeKnownError,
  readDaemonRegistry,
  registerDaemonRepo,
  type DaemonRepoMode,
} from "../../kernel/src/index.ts";
import {
  discoverRuntimeInstallations,
  openRuntimeInstanceStore,
  type RuntimeInstallationWitness,
} from "./agent-runtime-instances.ts";
import { daemonBuildStamp, observeDaemonBuild } from "./build-identity.ts";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import {
  admitHostMode as admitHostModeImpl,
  localCenterProjectionRepair as localCenterProjectionRepairImpl,
  requireHostMode as requireHostModeImpl,
  settleControl as settleControlImpl,
} from "./daemon-host-admission.ts";
import { binding, declaredExecutor, localRepairBinding } from "./daemon-host-binding.ts";
import { createDaemonHostControlApi } from "./daemon-host-control-api.ts";
import {
  attachBudgetError,
  code,
  daemonErrorMessage,
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
import { openFleetEdgeRuntime } from "./fleet-edge-runtime.ts";
import type { FleetTlsCenter } from "./fleet/center.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { canonicalRoot, workspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { causeClassOf, latchReprobeThrottleMs, openRepoCell, type RepoCell, type RepoCellStatus } from "./repo-cell.ts";
import { type RepoModeAdmission } from "./repo-mode.ts";
import type { RuntimeLauncher } from "./runtime-spawn.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export async function openDaemonHost(input: {
  readonly daemonId: string;
  readonly userRoot: string;
  readonly endpoint?: string;
  readonly startedAt?: string;
  readonly now?: () => string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeDiscover?: () => readonly RuntimeInstallationWitness[];
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  readonly runtimeFile?: string;
  readonly shutdownRequested?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  readonly attachTimeoutMs?: number;
  readonly openCell?: typeof openRepoCell;
}): Promise<DaemonHost> {
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
    };
  const unavailable = new Map<string, RepoCellStatus>(),
    unavailableProbes = new Map<string, ReturnType<typeof makeRecoveryProbe>>(),
    controls = new Map<string, DaemonControlReceipt>(),
    discover = input.runtimeDiscover ?? (() => discoverRuntimeInstallations()),
    instances = openRuntimeInstanceStore({
      userRoot: input.userRoot,
      discover,
      env: input.runtimeEnv,
    }),
    runtimePorts = {
      runtimeInstances: instances.listPublic,
      prepareRuntimeLaunch: instances.prepareLaunch,
    },
    startedAt = input.startedAt ?? new Date().toISOString(),
    now = input.now ?? (() => new Date().toISOString()),
    initialRegistry = readDaemonRegistry({ userRoot: input.userRoot }),
    buildObserver = observeDaemonBuild(input.runtimeFile),
    fleetEdgeRuntimes = new Map<string, ReturnType<typeof openFleetEdgeRuntime>>();
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
    lastError: null,
    causeClass: null,
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
  const repos = initialRegistry.repos.filter((repo) => repo.state === "enabled");
  for (const repo of repos) markWarming(repo.repoId, warmingStatus(repo));
  const extracted = {
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
    runtimePorts,
    runtimeDaemonRoute,
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
    if (!cells.has(repoId))
      try {
        markWarming(
          repoId,
          warmingStatus({
            ...registered.repo,
            repoId: id,
            canonicalRoot: root,
          }),
        );
        await openRegistered({
          ...registered.repo,
          repoId: id,
          canonicalRoot: root,
        });
      } catch (error) {
        consumeKnownError(error);
        latchUnavailable(repoId, unavailableStatus(repoId, root, registered.repo.mode, error));
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
          attached = status?.state === "attached",
          warmingUp = status?.state === "warming";
        return {
          repoId: repo.repoId,
          displayName: repo.displayName,
          canonicalRoot: repo.canonicalRoot,
          authoredBranch: repo.authoredBranch,
          registrationState: repo.state,
          cellState: disabled ? "not_loaded" : attached ? "attached" : warmingUp ? "warming" : "unavailable",
          generation: disabled ? null : (status?.generation ?? null),
          queueDepth: disabled ? null : (status?.queueDepth ?? null),
          lockState: disabled ? "not_applicable" : attached ? "held" : "unknown",
          recoveryMs: disabled ? null : (status?.recoveryMs ?? null),
          lastError: disabled ? null : (status?.lastError ?? null),
          unavailableReason:
            disabled || attached || warmingUp ? null : (status?.lastError ?? "unknown / not projected"),
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
  const hostContext = {
    cells,
    unavailable,
    input,
    runtimePorts,
    failedConfigureVerify,
    hostCodedError,
    binding,
    attach,
    localOnly,
    settleWarming,
    closeCell,
    publicRegistryRepo,
    localCenterProjectionRepair,
    admitHostMode,
    rejectHostAction,
    attemptHostRecovery,
    warming,
    warmingMessage,
    declaredExecutor,
    localRepairBinding,
    code,
    daemonErrorMessage,
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
  const host: DaemonHost = {
    ...createDaemonHostRepositoryApi(hostContext),
    ...createDaemonHostRuntimeApi(hostContext),
    ...createDaemonHostControlApi(hostContext),
    ...createDaemonHostLifecycleApi(hostContext),
  };
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
    return startInitialAttachmentsImpl(extracted);
  }
  async function attachInitial(): Promise<void> {
    return attachInitialImpl(extracted);
  }
  function admitHostMode(
    repoId: string,
    commandClass: DaemonCommandClass,
    auth: DaemonAuthenticationContext,
  ): RepoModeAdmission {
    return admitHostModeImpl(extracted, repoId, commandClass, auth);
  }
  function localCenterProjectionRepair(repoId: string, actionKind: string, auth: DaemonAuthenticationContext): boolean {
    return localCenterProjectionRepairImpl(extracted, repoId, actionKind, auth);
  }
  function requireHostMode(repoId: string, commandClass: DaemonCommandClass, auth: DaemonAuthenticationContext): void {
    return requireHostModeImpl(extracted, repoId, commandClass, auth);
  }
  function settleControl(pending: DaemonControlReceipt, ok: boolean, error?: unknown): void {
    return settleControlImpl(extracted, pending, ok, error);
  }
}

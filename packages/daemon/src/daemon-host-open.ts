import type { IdentityManagementPort } from "@harness-anything/kernel";
import type { IdentitySessionPort } from "@harness-anything/kernel";
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
import { registerDaemonRepo } from "@harness-anything/storage";
import {
  consumeKnownError,
  validateScheduleV1,
  readDaemonRegistry,
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
import { parseAssignmentExpiry } from "@harness-anything/kernel";
import { readClaimableTasks } from "./task-claimable-read.ts";
import {
  openNodeAutoClaimLoop,
  type NodeAutoClaimAssignment,
  type NodeAutoClaimDiagnosticRow,
} from "./node-auto-claim.ts";
import {
  readNodeAutoClaimDiagnostics,
  readNodeAutoClaimPolicy,
  parseNodeAutoClaimPolicy,
  recordNodeAutoClaimDiagnostic,
  writeNodeAutoClaimPolicy,
  type NodeAutoClaimPolicy,
} from "./node-auto-claim-config.ts";
import { createEdgeJoinProgressTap, joinFleetEdge } from "./fleet/edge-join-client.ts";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import {
  admitHostMode as admitHostModeImpl,
  requireHostMode as requireHostModeImpl,
  settleControl as settleControlImpl,
} from "./daemon-host-admission.ts";
import {
  binding as deriveBinding,
  isDaemonSocketOwner,
  localDefaultBinding,
  localSystemActionBinding,
  localSystemBinding,
} from "./daemon-host-binding.ts";
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
import { canonicalRoot, jsonRpcMethodContracts, workspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { openDaemonRuntimePorts } from "./daemon-runtime-ports.ts";
import {
  causeClassOf,
  latchReprobeThrottleMs,
  type RepoCell,
  type RepoCellBinding,
  type RepoCellStatus,
} from "./repo-cell.ts";
import { openRepoCell } from "./repo-cell-open.ts";
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
import { createNodeRetirement } from "./fleet/node-retirement.ts";
import { AccessAdminService } from "./access-admin-service.ts";
import type { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import { accessAdminOperations } from "./protocol/daemon-protocol.contract.ts";
import { createIdentityManagement } from "./authorization-provider.ts";
import { createIdentitySession } from "./authorization-provider.ts";
import type { SkillEvalCaseView, SkillEvalRecord, SkillEvalRunner } from "./skill-eval-runner.ts";
import { openSkillEvalProduction, type SkillEvalProductionInput } from "./skill-eval-production.ts";
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
  readonly oidc?: IdentitySessionPort;
  /** The managed identity center's lifecycle; a hermetic host substitutes it to stage its resume. */
  readonly managedRbac?: Pick<IdentityManagementPort, "run" | "resume" | "stop" | "loginListenerCertificate">;
  readonly attachTimeoutMs?: number;
  readonly openCell?: (
    input: Parameters<typeof openRepoCell>[0] & { readonly onStatus?: (status: RepoCellStatus) => void },
  ) => Promise<RepoCell>;
  readonly sshTunnels?: EdgeJoinSshTunnelManager;
  readonly edgeJoins?: ReturnType<typeof createEdgeJoinStore>;
  /** Optional deployment overrides; the daemon composes the default catalog, policy, runtime and slot queue. */
  readonly skillEval?: Omit<SkillEvalProductionInput, "userRoot" | "runner">;
  /** Test/deployment replacement for the composed runner. */
  readonly skillEvalRunner?: SkillEvalRunner;
}

export async function openDaemonHost(input: DaemonHostOpenInput): Promise<DaemonHost> {
  const skillEvalProduction = openSkillEvalProduction({
    userRoot: input.userRoot,
    ...input.skillEval,
    ...(input.skillEvalRunner ? { runner: input.skillEvalRunner } : {}),
  });
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
  const oidc = input.oidc ?? createIdentitySession(input.userRoot),
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
  const keycloakSession = async (rootDir: string) => {
    await rbacResumed;
    const principal = (await oidc.bind({ transportKind: "unix-socket" }, rootDir)).oidcPrincipal;
    if (!principal) throw hostCodedError("authentication_required", "Sign in before continuing a runtime.");
    return {
      provider: principal.provider,
      personId: principal.personId,
      accessToken: principal.accessToken,
      ...principal.authority,
    };
  };
  // The automatic disposition launches through the same local session source as a manual
  // `ha agent run`: the persisted dispatch binding has no credential of its own.
  const decisionPointExecutorFor = openDecisionPointExecutorFactory({
    providers: { list: decisionProviders.list, port: decisionProviders.port },
    now,
    keycloakSession,
    keycloakCenter,
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
      const deviceSession = await deriveBinding(rootDir, await oidc.bind(auth, rootDir));
      if (deviceSession.actor.principal.personId !== execution.personId) throw executionCredentialRejected();
      const base = {
        actor: runtimeExecutionActor(execution),
        source: execution.source,
        sourceNodeId:
          typeof execution.source === "object" && execution.source.kind === "node"
            ? execution.source.nodeId
            : `local:${input.daemonId}`,
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
          ? await deriveBinding(rootDir, { ...(await oidc.bind(auth, rootDir, true)), keycloakCenter }, executor, true)
          : await deriveBinding(rootDir, { ...(await oidc.bind(auth, rootDir)), keycloakCenter }, executor),
      base = edge
        ? principal
        : {
            ...principal,
            sourceNodeId:
              typeof principal.source === "object" && principal.source.kind === "node"
                ? principal.source.nodeId
                : `local:${input.daemonId}`,
            keycloakAuthorization: { ...principal.keycloakAuthorization, center: keycloakCenter },
          };
    return writerRepoId ? daemonWriterBinding(writerRepoId, base) : base;
  };
  type AutoClaimRepo = {
    readonly repoId: string;
    readonly rootDir: string;
    readonly mode: DaemonRepoMode;
    readonly cell: RepoCell;
  };
  const autoClaimBinding = async (repo: AutoClaimRepo): Promise<RepoCellBinding | null> => {
    if (repo.mode !== "remote-edge") return null;
    const config = readFleetEdgeConfig(repo.rootDir);
    if (!config || config.repoId !== repo.repoId) return null;
    const binding = await hostBinding(repo.rootDir, { transportKind: "unix-socket" }),
      center = await keycloakCenter(),
      node = await center.provider.readNode(center.accessToken, config.nodeId);
    if (!node || node.state !== "active" || node.personId !== binding.actor.principal.personId)
      throw hostCodedError("authentication_required", "The signed-in person is not the registered node owner.");
    return {
      ...binding,
      source: { kind: "node", nodeId: config.nodeId },
      keycloakAuthorization: {
        ...(binding.keycloakAuthorization ?? {}),
        center: keycloakCenter,
      },
    };
  };
  const autoClaimLoop = openNodeAutoClaimLoop<
    AutoClaimRepo,
    {
      readonly taskId: string;
      readonly assignment: {
        readonly assignee: {
          readonly kind: string;
          readonly personId?: string;
          readonly nodeId?: string;
          readonly teamId?: string;
        };
        readonly expiresAt: string;
      } | null;
      readonly autoAssignment: NodeAutoClaimAssignment | null;
    }
  >({
    userRoot: input.userRoot,
    now,
    repos: () =>
      [...cells.entries()]
        .map(([repoId, cell]) => ({ repoId, rootDir: cell.status().rootDir, mode: cell.status().mode, cell }))
        .filter((repo): repo is AutoClaimRepo => repo.mode === "remote-edge"),
    repoIdOf: (repo) => repo.repoId,
    ownerPersonIdFor: async (repo) => (await autoClaimBinding(repo))?.actor.principal.personId ?? null,
    candidates: async (repo) => {
      const binding = await autoClaimBinding(repo);
      if (!binding) return [];
      const settings = await repo.cell.read("repo.settings.read", {}, binding),
        assignments = await repo.cell.readNodeAutoClaimAssignments(binding),
        result = await readClaimableTasks({
          repoId: repo.repoId,
          binding,
          settings: settings.settings,
          now: now(),
          page: (cursor) => repo.cell.read("repo.tasks.list", { limit: 500, ...(cursor ? { cursor } : {}) }, binding),
          readTask: async (taskId) =>
            (await repo.cell.read("repo.tasks.runtimeContext.read", { taskId }, binding)).snapshot.task,
          readAssignments: async () => assignments.map(({ relation }) => relation),
        });
      const relations = new Map(assignments.map((row) => [row.relation.sourceRef, row] as const));
      const center = await keycloakCenter();
      return Promise.all(
        result.tasks
          .filter((task) => relations.has(`task/${task.taskId}`))
          .map(async (task) => {
            const row = relations.get(`task/${task.taskId}`),
              relation = row?.relation,
              assignedByPersonId = row?.assignedByPersonId ?? null,
              assignedByTeamIds = assignedByPersonId
                ? await center.provider.readPersonTeams(center.accessToken, assignedByPersonId)
                : [];
            const expiresAt = relation ? parseAssignmentExpiry(relation.rationale) : null;
            return {
              taskId: task.taskId,
              assignment: task.assignment,
              autoAssignment: relation
                ? { taskId: task.taskId, expiresAt: expiresAt ?? "", assignedByPersonId, assignedByTeamIds }
                : null,
            };
          }),
      );
    },
    taskIdOf: (candidate) => candidate.taskId,
    assignmentOf: async (candidate) => {
      return candidate.autoAssignment;
    },
    activeTaskKeys: async () => {
      const active = new Set<string>();
      for (const repo of [...cells.entries()]
        .map(([repoId, cell]) => ({ repoId, rootDir: cell.status().rootDir, mode: cell.status().mode, cell }))
        .filter((entry): entry is AutoClaimRepo => entry.mode === "remote-edge")) {
        const binding = await autoClaimBinding(repo);
        if (!binding) continue;
        const overview = await repo.cell.read("repo.agentRuntime.overview", {}, binding);
        for (const session of overview.sessions) {
          if (session.liveness === "exited") continue;
          for (const association of session.associations)
            if (association.taskId) {
              const task = await repo.cell.read(
                  "repo.tasks.runtimeContext.read",
                  { taskId: association.taskId },
                  binding,
                ),
                lease = task.snapshot.lease,
                source = lease?.source;
              if (
                lease?.phase === "held" &&
                source &&
                typeof source === "object" &&
                source.kind === "node" &&
                typeof binding.source === "object" &&
                binding.source.kind === "node" &&
                source.nodeId === binding.source.nodeId
              )
                active.add(`${repo.repoId}:${association.taskId}`);
            }
        }
      }
      return [...active];
    },
    agentIds: (_repo, policy) => policy.allowedAgentIds,
    claimAndRun: async (repo, candidate, agentId, dispatchKey, signal) => {
      const binding = await autoClaimBinding(repo);
      if (!binding) throw new Error("authentication_required: node identity is unavailable");
      if (signal.aborted) throw new Error("node auto-claim was cancelled");
      const edge = readFleetEdgeConfig(repo.rootDir);
      if (!edge || edge.repoId !== repo.repoId) throw new Error("fleet_edge_config_invalid");
      const runtime = edgeRuntimeFor({
          ...edge,
          caPath: path.isAbsolute(edge.caPath) ? edge.caPath : path.resolve(repo.rootDir, edge.caPath),
          viewRoot: path.isAbsolute(edge.viewRoot) ? edge.viewRoot : path.resolve(repo.rootDir, edge.viewRoot),
          workspaceRoot: repo.rootDir,
          method: "repo.agentRuntime.spawn",
          action: { agentId, taskId: candidate.taskId, dispatchKey },
        }),
        receipt = await runtime.run(
          "repo.agentRuntime.spawn",
          { agentId, taskId: candidate.taskId, dispatchKey },
          signal,
        ),
        runtimeSessionId = typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : null;
      if (!runtimeSessionId) throw new Error("runtime spawn did not return a runtimeSessionId");
      await runtime.run(
        "repo.agentRuntime.sessions.await",
        { runtimeSessionIds: [runtimeSessionId], mode: "all" },
        signal,
      );
    },
    onDiagnostic: (row: NodeAutoClaimDiagnosticRow) => {
      recordNodeAutoClaimDiagnostic(input.userRoot, {
        repoId: row.repoId,
        taskId: row.taskId,
        reason: row.reason,
        observedAt: row.observedAt,
        ...(row.assignedByPersonId ? { assignedByPersonId: row.assignedByPersonId } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
      });
    },
  });
  function edgeRuntimeFor(request: FleetEdgeRuntimeRequest["payload"]): ReturnType<typeof openFleetEdgeRuntime> {
    const key = `${request.repoId}\0${request.nodeId}\0${request.host}\0${request.port}`,
      runtime =
        fleetEdgeRuntimes.get(key) ??
        openFleetEdgeRuntime({
          request,
          readBinding: async () => {
            const binding = await hostBinding(
              request.workspaceRoot,
              { transportKind: "unix-socket" },
              undefined,
              undefined,
              true,
            );
            return { ...binding, source: { kind: "node", nodeId: request.nodeId } };
          },
          controlBinding: async () => {
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
  }
  const scheduleScheduler = makeScheduleScheduler({
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
      if (
        schedule.spec.target.kind !== "builtin" &&
        current.actor.principal.personId !== schedule.createdBy.principal.personId
      )
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
  const replicaSyncTasks = new Set<Promise<void>>();
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
    onAutoClaimTrigger: (reason) => {
      void autoClaimLoop.trigger(reason).catch((error: unknown) => {
        process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
          code: "NODE_AUTO_CLAIM_SCAN_FAILED",
        });
      });
    },
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
      autoClaim = readNodeAutoClaimPolicy(input.userRoot),
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
      nodeAutoClaim: {
        enabled: autoClaim.policy.enabled,
        configuration: autoClaim.diagnostic,
        maxConcurrent: autoClaim.policy.maxConcurrent,
        allowedAgentIds: [...autoClaim.policy.allowedAgentIds],
        recent: readNodeAutoClaimDiagnostics(input.userRoot).slice(-10) as unknown as JsonObject[],
      },
    };
  };
  const accessAdminRef: { current: AccessAdminService | null } = { current: null };
  const managedRbac = input.managedRbac ?? createIdentityManagement(input.userRoot);
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
    openings,
    replicaSyncTasks,
    replicaSyncControllers,
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
    nodeRetirement: createNodeRetirement({
      stateRoot: () =>
        readFleetCenterConfig(input.userRoot, input.daemonId)?.stateRoot ?? path.join(input.userRoot, "fleet"),
      center: () => hostContext.fleetCenter,
      repositories: () =>
        [...cells.values()]
          .map((cell) => cell.status())
          .concat([...warming.values(), ...unavailable.values()])
          .filter((repo) => repo.mode !== "remote-proxy"),
    }),
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
    skillEvalRunner: skillEvalProduction.runner,
    skillEval: {
      addCase: async (auth, skillId, draft): Promise<SkillEvalCaseView> =>
        skillEvalProduction.runner.addCase(await skillEvalProduction.policy.scope(auth), skillId, draft),
      listCases: async (auth, skillId): Promise<readonly SkillEvalCaseView[]> =>
        skillEvalProduction.runner.listCases(await skillEvalProduction.policy.scope(auth), skillId),
      run: async (auth, skillId, version, options): Promise<SkillEvalRecord & { readonly runtime: unknown }> =>
        skillEvalProduction.runner.run(await skillEvalProduction.policy.scope(auth), skillId, version, options),
    },
    remoteProxy,
    configureNodeAutoClaim: async (value, auth) => {
      localOnly(auth);
      const policy: NodeAutoClaimPolicy = parseNodeAutoClaimPolicy(value),
        binding = await localSystemActionBinding(input.userRoot, "daemon-node-auto-claim", auth, () =>
          Promise.resolve(localDefaultBinding(auth)),
        ),
        authorizationDecision = await requireAuthorizedHostAction({
          kind: "daemon-node-auto-claim",
          binding,
          actionId: "daemon-node-auto-claim:configure",
          evaluatedAtCut: "node-auto-claim:local",
        });
      writeNodeAutoClaimPolicy(input.userRoot, policy);
      await autoClaimLoop.trigger("rpc-wake");
      return {
        ok: true,
        command: "daemon-auto-claim-configure",
        policy: policy as unknown as JsonObject,
        activation: "woken",
        authorizationDecision: authorizationDecision as unknown as JsonObject,
      };
    },
    home,
    keycloakCenter,
    sessionPrincipal: async (auth, method, params) => {
      await rbacResumed;
      if (
        isDaemonSocketOwner(auth) &&
        [
          "daemon.repo.register",
          "daemon.repo.update",
          "daemon.repo.unbind",
          "daemon.repo.backup",
          "daemon.repo.restoreDrill",
        ].includes(method)
      )
        return undefined;
      const repo =
          params.repo && typeof params.repo === "object" ? (params.repo as Record<string, unknown>) : undefined,
        payload =
          params.payload && typeof params.payload === "object"
            ? (params.payload as Record<string, unknown>)
            : undefined,
        methodContract = jsonRpcMethodContracts.find((entry) => entry.method === method),
        repoId =
          (typeof repo?.repoId === "string" ? repo.repoId : undefined) ??
          (typeof params.repoId === "string" ? params.repoId : undefined) ??
          (typeof payload?.repoId === "string" ? payload.repoId : undefined),
        requestedRoot = typeof params.rootDir === "string" ? canonicalRoot(params.rootDir, true) : undefined,
        registered = repoId
          ? readDaemonRegistry({ userRoot: input.userRoot }).repos.find(
              (row) => row.repoId === repoId && row.state === "enabled" && row.canonicalRoot !== null,
            )
          : undefined,
        rootDir = requestedRoot ?? registered?.canonicalRoot;
      if (!rootDir && methodContract?.requiresRepo)
        throw hostCodedError("oidc_center_required", "Select a repository with a configured center before continuing.");
      if (!rootDir) return undefined;
      return (await oidc.bind(auth, rootDir)).oidcPrincipal;
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
        const loginTarget =
            request.rootDir ??
            request.workspaceRoot ??
            (request.repoId
              ? (readDaemonRegistry({ userRoot: input.userRoot }).repos.find((repo) => repo.repoId === request.repoId)
                  ?.canonicalRoot ?? undefined)
              : undefined),
          requireLoginTarget = () => {
            if (!loginTarget)
              throw hostCodedError("oidc_center_required", "Select a repository root to choose its identity center.");
            return loginTarget;
          };
        if (request.operation === "edge-join")
          return joinFleetEdge(
            {
              link: String(request.link ?? ""),
              ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
              ...(request.quotaBytes === undefined ? {} : { quotaBytes: request.quotaBytes }),
            },
            {
              session: async (rootDir) => (await oidc.bind(auth, rootDir)).oidcPrincipal,
              beginLogin: (authority, rootDir) => oidc.beginDevice(rootDir, authority),
              register: (rootDir, repoId) =>
                host.admin({ kind: "register", rootDir, repoId, mode: "remote-edge" }, auth),
              sync: (payload) => host.fleet.edgeSync(payload, auth),
              onProgress: edgeJoinProgress.record,
            },
          );
        if (request.mode === "external")
          return oidc.configureAuthority(() => managedRbac.run(request), requireLoginTarget());
        if (request.repoId && !loginTarget)
          throw hostCodedError("repo_namespace_unknown", "Select a registered repository for login.");
        if (request.operation === "listener" && loginTarget) {
          const edge = readFleetEdgeConfig(loginTarget);
          if (edge?.loginUrl && edge.loginBrowserUrl && edge.loginCertificate) {
            const browser = new URL(edge.loginBrowserUrl),
              target = new URL(edge.loginUrl);
            return {
              ok: true,
              command: "rbac-listener",
              listener: {
                address: target.hostname,
                hostname: browser.hostname,
                port: Number(browser.port || 443),
                certificate: edge.loginCertificate,
                targetUrl: target.toString(),
              },
              version: "fleet-edge-login",
            };
          }
        }
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
            requireLoginTarget(),
            request.loginUrl && request.loginRealm && request.loginClientId
              ? { url: request.loginUrl, realm: request.loginRealm, clientId: request.loginClientId }
              : undefined,
          );
        if (request.operation === "login-poll") return oidc.pollDevice();
        if (request.operation === "login-begin") {
          if (!request.redirectUri) throw hostCodedError("oidc_redirect_required", "Login requires redirectUri.");
          return oidc.begin(request.redirectUri, requireLoginTarget());
        }
        if (request.operation === "login-complete") {
          if (!request.code || !request.state)
            throw hostCodedError("oidc_callback_invalid", "Login completion requires code and state.");
          return oidc.complete(request.code, request.state);
        }
        if (request.operation === "device-approval")
          return oidc.deviceApproval(request.code ?? "", requireLoginTarget());
        if (request.operation === "session") return oidc.status(requireLoginTarget());
        if (request.operation === "logout") return oidc.logout(requireLoginTarget());
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
          return oidc.invite(
            {
              username: request.username!,
              email: request.email!,
              displayName: request.displayName!,
              personId: request.personId!,
            },
            false,
            requireLoginTarget(),
          );
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
          return accessAdmin.run(
            { ...request, ...(loginTarget ? { rootDir: loginTarget } : {}) },
            auth.executionPrincipal?.personId,
          );
        }
        if (request.operation === "listener-set")
          return oidc.configureAuthority(() => managedRbac.run(request), requireLoginTarget());
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
      await autoClaimLoop.close();
      for (const { controller } of replicaSyncControllers.values()) controller.abort();
      replicaSyncControllers.clear();
      await rbacResumed;
      await accessAdmin.close();
      await managedRbac.stop();
      await lifecycle.close();
    },
  };
  const startReplicaSyncs = (): void => {
    if (closing) return;
    // A registry refresh can arrive while the initial attach fan-out is still opening cells. Starting
    // a remote-edge stream here races the cell's publication boundary and exposes sync failures
    // before the host reports attachment. Defer that refresh until the same initial barrier used by
    // attachmentsSettled(); calls made after startup remain immediate.
    if (initialAttachments && !initialAttachmentsSettled) {
      if (!replicaSyncStartQueued) {
        replicaSyncStartQueued = true;
        void initialAttachments.then(() => {
          replicaSyncStartQueued = false;
          if (closing) return;
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
      const task = runFleetReplicaSync({
        readAccessToken: async () => {
          const auth = await oidc.bind({ transportKind: "unix-socket" }, rootDir);
          // Resolve the current session token at request time so refreshes are observed.
          return auth.localSessionAccessToken ? await auth.localSessionAccessToken() : auth.oidcPrincipal?.accessToken;
        },
        hostname: config.host,
        port: config.port,
        ca: readFileSync(caPath),
        ...(config.servername ? { servername: config.servername } : {}),
        nodeId: config.nodeId,
        credential: config.credential,
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
          await autoClaimLoop.trigger("replica-confirmed");
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
      replicaSyncTasks.add(task);
      void task.then(
        () => replicaSyncTasks.delete(task),
        () => replicaSyncTasks.delete(task),
      );
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
            invitationClientForNode: (nodeId) => accessAdmin.invitationClientForNode(nodeId),
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
    if (!closing) startReplicaSyncs();
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
      if (closing) return;
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

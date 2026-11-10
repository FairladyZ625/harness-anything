import { createFleetMemberDeviceLink } from "./fleet/peer.ts";
import { forward, resolveRuntimeLocation, type RuntimeForwardingRequest } from "./fleet/forwarding-port.ts";
import { forwardingIntentForAction, runtimeForwardingIntent } from "./fleet/forwarding-intent.ts";
import { runtimeInstanceUsesCredential } from "./runtime-hosting-credentials.ts";
import { markDaemonOperationPhase } from "./daemon-operation.ts";
import type {
  FleetDeviceLoginNotice,
  IdentityManagementPort,
  IdentitySessionPort,
  TaskReviewDispatchFailureV1,
} from "@harness-anything/kernel";
import { readHomeOverview } from "./home/home-overview-read.ts";
import { readFleetCenterConfig } from "./fleet-center-config.ts";
import {
  keycloakNodeRegistry,
  prepareFleetCenterAdmission,
  startFleetCenterAdmission,
} from "./fleet-center-admission.ts";
import { executionCredentialRejected, runtimeExecutionActor } from "./runtime-execution-credential.ts";
/** @daemon-transport-authority Host composition and RepoCell ownership. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { readDaemonStorageConfig, registerDaemonRepo, type DaemonStorageConfig } from "@harness-anything/storage";
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
import {
  openNodeAutoClaimLoop,
  type NodeAutoClaimCandidate,
  parseNodeAutoClaimSnapshot,
  type NodeAutoClaimSnapshot,
  type NodeAutoClaimDiagnosticRow,
} from "./node-auto-claim.ts";
import {
  openNodeAutoDispatchLoop,
  parseNodeAutoDispatchSnapshot,
  type NodeAutoDispatchCandidate,
} from "./node-auto-dispatch.ts";
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
import { applyFleetMirrorCut, revokeFleetMirrorTree } from "./fleet-edge-mirror.ts";
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
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import { openRuntimeRecoveryWatch, runReplicaConfirmedRound } from "./runtime-recovery-watch.ts";
import { openDecisionProviderService } from "./decision-provider.ts";
import { openDecisionPointExecutorFactory } from "./decision-point-executor.ts";
import { createNodeRetirement } from "./fleet/node-retirement.ts";
import { AccessAdminService } from "./access-admin-service.ts";
import type { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import { accessAdminOperations } from "./protocol/daemon-protocol.contract.ts";
import { createIdentityManagement } from "./authorization-provider.ts";
import { createIdentitySession } from "./authorization-provider.ts";
import type { SkillEvalRunner } from "./skill-eval-runner.ts";
import { openSkillEvalProduction, type SkillEvalProductionInput } from "./skill-eval-production.ts";
import { runFleetReplicaSync, waitForFleetReplicaReady } from "./fleet/replica-sync.ts";
import { createFleetReplicaAccessTokenReader } from "./fleet/replica-token.ts";
import type { FleetVersionWarning } from "./fleet/peer.ts";
import { migrateFleetEdgeWorkspace } from "./fleet-edge-workspace-migration.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";

export interface DaemonHostOpenInput {
  readonly storage?: Readonly<Record<string, DaemonStorageConfig>>;
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
  readonly authenticateExecutionPrincipal?: (
    credential: string,
  ) => Promise<import("./runtime-execution-credential.ts").RuntimeExecutionPrincipal>;
  readonly runtimeFile?: string;
  readonly shutdownRequested?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  readonly buildDraining?: () => boolean;
  readonly onRepoStatusChange?: () => void;
  /** One persisted transport record per completed request, shared with local JSON-RPC traffic. */
  readonly recordTraffic?: (entry: import("./conn-log.ts").DaemonTrafficLogEntry) => void;
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
  input = { ...input, storage: input.storage ?? readDaemonStorageConfig(input.userRoot) };
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
    replicaSyncControllers = new Map<
      string,
      { readonly controller: AbortController; readonly config: string; task: Promise<void> }
    >();
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
      resolveGithubToken: input.runtimeGithubToken,
    }),
    instances = { ...instanceStore, ...runtimeInstanceCredentialService(instanceStore, vault) },
    decisionProviders = openDecisionProviderService({
      userRoot: input.userRoot,
      vault,
      isCredentialInUse: (reference) =>
        instanceStore.list().some((config) => runtimeInstanceUsesCredential(config, reference)),
    }),
    runtimePorts = openDaemonRuntimePorts({ userRoot: input.userRoot, instances }),
    startedAt = input.startedAt ?? new Date().toISOString(),
    now = input.now ?? (() => new Date().toISOString()),
    initialRegistry = readDaemonRegistry({ userRoot: input.userRoot }),
    buildObserver = observeDaemonBuild(input.runtimeFile),
    fleetEdgeRuntimes = new Map<string, ReturnType<typeof openFleetEdgeRuntime>>(),
    fleetVersionWarnings = new Map<string, FleetVersionWarning>(),
    runtimeRecoveryWatch = openRuntimeRecoveryWatch();
  const oidc = input.oidc ?? createIdentitySession(input.userRoot),
    {
      writerEpochLease,
      writerEpochFence,
      writerEpochHighWatermark,
      retireWriterEpoch,
      closeDaemonWriterEpoch,
      daemonWriterBinding,
    } = openDaemonWriterEpochs({ userRoot: input.userRoot, daemonId: input.daemonId, now, storage: input.storage });
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
    await rbacResumed;
    const replicaPrincipal = auth.fleetReplicaPrincipal;
    if (replicaPrincipal) {
      if (
        auth.transportKind !== "fleet-tls" ||
        auth.nodePrincipal?.nodeId !== replicaPrincipal.nodeId ||
        auth.nodePrincipal.personId !== replicaPrincipal.personId ||
        replicaPrincipal.expiresAt <= Date.now()
      )
        throw hostCodedError("fleet_replica_credential_rejected", "The Fleet replica credential was rejected.");
      const base = {
        actor: { principal: { personId: replicaPrincipal.personId }, executor: null },
        source: { kind: "node" as const, nodeId: replicaPrincipal.nodeId },
        keycloakAuthorization: {
          center: keycloakCenter,
          fleetReplicaPrincipal: replicaPrincipal,
        },
      };
      return writerRepoId ? daemonWriterBinding(writerRepoId, base) : base;
    }
    const execution = auth.executionPrincipal;
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
      const {
        executionCredential: _executionCredential,
        executionPrincipal: _executionPrincipal,
        ...operatorAuth
      } = auth;
      const deviceSession = await hostBinding(rootDir, operatorAuth, executor, undefined, replicaRead);
      if (deviceSession.actor.principal.personId !== execution.personId) throw executionCredentialRejected();
      const base = {
        ...deviceSession,
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
  const autoClaimSnapshots = new Map<string, NodeAutoClaimSnapshot>();
  const autoClaimRepos = (): AutoClaimRepo[] =>
    [...cells.entries()]
      .map(([repoId, cell]) => ({ repoId, rootDir: cell.status().rootDir, mode: cell.status().mode, cell }))
      .filter((repo): repo is AutoClaimRepo => repo.mode === "remote-edge");
  const autoClaimBinding = async (repo: AutoClaimRepo): Promise<RepoCellBinding | null> => {
    if (repo.mode !== "remote-edge") return null;
    const { nodeId } = resolveRuntimeLocation(input.userRoot, repo.repoId),
      binding = {
        ...(await hostBinding(repo.rootDir, { transportKind: "unix-socket" })),
        source: { kind: "node", nodeId } as const,
      };
    await repo.cell.readNodeAutoClaimAssignments(binding);
    return binding;
  };
  const readAutoClaimSnapshot = async (repo: AutoClaimRepo): Promise<NodeAutoClaimSnapshot> => {
    const binding = await autoClaimBinding(repo);
    if (!binding) return { candidates: [], activeTaskIds: [] };
    const result = await forwardRuntime({
      repoId: repo.repoId,
      method: "repo.tasks.autoClaimCandidates",
      action: {},
      auth: { transportKind: "unix-socket" },
    });
    if (!result) throw hostCodedError("fleet_edge_config_invalid", `Remote-edge ${repo.repoId} is unavailable.`);
    return parseNodeAutoClaimSnapshot(result);
  };
  const autoClaimLoop = openNodeAutoClaimLoop<AutoClaimRepo, NodeAutoClaimCandidate>({
    userRoot: input.userRoot,
    now,
    repos: autoClaimRepos,
    repoIdOf: (repo) => repo.repoId,
    ownerPersonIdFor: async (repo) => (await autoClaimBinding(repo))?.actor.principal.personId ?? null,
    candidates: async (repo) => {
      return (autoClaimSnapshots.get(repo.repoId) ?? (await readAutoClaimSnapshot(repo))).candidates;
    },
    taskIdOf: (candidate) => candidate.taskId,
    assignmentOf: async (candidate) => {
      return candidate.autoAssignment;
    },
    activeTaskKeys: async () => {
      autoClaimSnapshots.clear();
      if (!readNodeAutoClaimPolicy(input.userRoot).policy.enabled) return [];
      const active = new Set<string>();
      for (const repo of autoClaimRepos()) {
        const snapshot = await readAutoClaimSnapshot(repo);
        autoClaimSnapshots.set(repo.repoId, snapshot);
        for (const taskId of snapshot.activeTaskIds) active.add(`${repo.repoId}:${taskId}`);
      }
      return [...active];
    },
    agentIds: (_repo, policy) => policy.allowedAgentIds,
    claimAndRun: async (repo, candidate, agentId, dispatchKey, signal) => {
      const binding = await autoClaimBinding(repo);
      if (!binding) throw new Error("authentication_required: node identity is unavailable");
      if (signal.aborted) throw new Error("node auto-claim was cancelled");
      const spawnAction = { agentId, taskId: candidate.taskId, dispatchKey },
        receipt = await forwardRuntime({
          repoId: repo.repoId,
          method: "repo.agentRuntime.spawn",
          action: spawnAction,
          auth: { transportKind: "unix-socket", connectionSignal: signal },
        });
      if (!receipt) throw new Error("node auto-claim runtime is unavailable");
      const runtimeSessionId = typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : null;
      if (!runtimeSessionId) throw new Error("runtime spawn did not return a runtimeSessionId");
      const awaited = await forwardRuntime({
        repoId: repo.repoId,
        method: "repo.agentRuntime.sessions.await",
        action: { runtimeSessionIds: [runtimeSessionId], mode: "all" },
        auth: { transportKind: "unix-socket", connectionSignal: signal },
      });
      if (!awaited) throw new Error("node auto-claim runtime is unavailable while awaiting completion");
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
  const readAutoDispatchCandidates = async (
    repo: AutoClaimRepo,
    signal: AbortSignal,
  ): Promise<readonly NodeAutoDispatchCandidate[]> => {
    const result = await forwardRuntime({
      repoId: repo.repoId,
      method: "repo.tasks.autoDispatchCandidates",
      action: {},
      auth: { transportKind: "unix-socket", connectionSignal: signal },
    });
    if (!result) throw hostCodedError("fleet_edge_config_invalid", `Remote-edge ${repo.repoId} is unavailable.`);
    return parseNodeAutoDispatchSnapshot(result).candidates;
  };
  const autoDispatchLoop = openNodeAutoDispatchLoop({
    read: async (signal) =>
      (await Promise.all(autoClaimRepos().map((repo) => readAutoDispatchCandidates(repo, signal)))).flat(),
    spawn: async (candidate, signal) => {
      const repo = autoClaimRepos().find((value) => value.repoId === candidate.repoId);
      if (!repo) throw new Error(`required node repository for ${candidate.taskId} is unavailable`);
      const spawn = (payload: JsonObject) =>
        forwardRuntime({
          repoId: repo.repoId,
          method: "repo.agentRuntime.spawn",
          action: payload,
          auth: { transportKind: "unix-socket", connectionSignal: signal },
          requiredNodeId: candidate.requiredNodeId,
        });
      let receipt: JsonObject;
      try {
        receipt = (await spawn(candidate.payload)) ?? {};
      } catch (error) {
        if (!candidate.fallbackPayload || runtimeErrorCode(error) !== "runtime_resume_failed") throw error;
        consumeKnownError(error);
        receipt = (await spawn(candidate.fallbackPayload)) ?? {};
      }
      if (receipt.code === "runtime_resume_failed" && candidate.fallbackPayload)
        receipt = (await spawn(candidate.fallbackPayload)) ?? {};
      const runtimeSessionId = typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : null;
      if (!runtimeSessionId || !["applied", "no_changes"].includes(String(receipt.outcome)))
        throw Object.assign(
          new Error(
            `Node runtime spawn did not start ${candidate.dispatchKey}: ${String(receipt.code ?? receipt.outcome)}.`,
          ),
          { code: typeof receipt.code === "string" ? receipt.code : "node_auto_dispatch_failed" },
        );
      return {
        completion: forwardRuntime({
          repoId: repo.repoId,
          method: "repo.agentRuntime.sessions.await",
          action: { runtimeSessionIds: [runtimeSessionId], mode: "all" },
          auth: { transportKind: "unix-socket", connectionSignal: signal },
          requiredNodeId: candidate.requiredNodeId,
        }).then((result) => {
          if (!result) throw new Error(`auto-dispatch node ${candidate.requiredNodeId} is unavailable`);
        }),
      };
    },
    onFailure: async (candidate, error) => {
      if (candidate.kind !== "review") return;
      const rawCode = runtimeErrorCode(error),
        failure = {
          executionId: candidate.executionId,
          dispatchKey: candidate.dispatchKey,
          code: rawCode && /^[a-z][a-z0-9_]{0,79}$/u.test(rawCode) ? rawCode : "node_auto_dispatch_failed",
          message:
            `Node ${candidate.requiredNodeId} could not start the automatic reviewer. ` +
            `Ask the task owner to retry with ha task dispatch-review ${candidate.taskId}.`,
          failedAt: now(),
        };
      await writeNodeReviewDispatchFailure(candidate, failure);
    },
    onSuccess: async (candidate) => {
      if (candidate.kind === "review") await writeNodeReviewDispatchFailure(candidate, null);
    },
  });
  async function writeNodeReviewDispatchFailure(
    candidate: NodeAutoDispatchCandidate,
    failure: TaskReviewDispatchFailureV1 | null,
  ): Promise<void> {
    const repo = autoClaimRepos().find((value) => value.repoId === candidate.repoId);
    if (!repo) throw new Error(`auto-dispatch repository ${candidate.repoId} is unavailable`);
    const action = {
        kind: "task-amend",
        taskId: candidate.taskId,
        patches: [{ field: "reviewDispatchFailure", value: JSON.stringify(failure) }],
      },
      receipt = await forward({
        userRoot: input.userRoot,
        repoId: repo.repoId,
        intent: forwardingIntentForAction("repo.task.run", action, {
          requiredNodeId: candidate.requiredNodeId,
        }),
        auth: { transportKind: "unix-socket" },
        oidc,
        runRuntime: async () => {
          throw new Error("Review-dispatch state must use the repository command intent.");
        },
      });
    if (!receipt) throw new Error(`auto-dispatch node ${candidate.requiredNodeId} is unavailable`);
    if (!["applied", "no_changes"].includes(String(receipt.outcome)))
      throw Object.assign(new Error(`The center rejected review-dispatch state for task ${candidate.taskId}.`), {
        code: typeof receipt.code === "string" ? receipt.code : "review_dispatch_state_rejected",
      });
  }
  function runtimeOwnerFor({
    repoId,
    nodeId,
  }: Pick<FleetEdgeRuntimeRequest["payload"], "repoId" | "nodeId">): ReturnType<typeof openFleetEdgeRuntime> {
    const location = () => resolveRuntimeLocation(input.userRoot, repoId, nodeId),
      key = JSON.stringify([repoId, nodeId]),
      runtime =
        fleetEdgeRuntimes.get(key) ??
        openFleetEdgeRuntime({
          get request() {
            return location();
          },
          readBinding: async (request = location()) => {
            const binding = await hostBinding(
              request.workspaceRoot,
              { transportKind: "unix-socket" },
              undefined,
              undefined,
              true,
            );
            return { ...binding, source: { kind: "node", nodeId } };
          },
          readAccessToken: async (request) => {
            const auth = await oidc.bind({ transportKind: "unix-socket" }, request.workspaceRoot);
            return auth.localSessionAccessToken ? auth.localSessionAccessToken() : auth.oidcPrincipal?.accessToken;
          },
          controlBinding: async (request = location()) => {
            const binding = await hostBinding(request.workspaceRoot, { transportKind: "unix-socket" });
            return { ...binding, source: { kind: "node", nodeId } };
          },
          daemonGeneration: Date.now() * 1000 + (process.pid % 1000),
          daemonRoute: runtimeDaemonRoute,
          ports: runtimePorts,
          forwardTaskAction: async (action) => {
            const receipt = await forward({
              userRoot: input.userRoot,
              repoId,
              intent: forwardingIntentForAction("repo.task.run", action, { requiredNodeId: nodeId }),
              auth: { transportKind: "unix-socket" },
              oidc,
              runRuntime: async () => {
                throw new Error("Squad task actions must use the repository command intent.");
              },
            });
            if (!receipt)
              throw hostCodedError("fleet_edge_config_invalid", `Remote-edge Squad ${repoId} is unavailable.`);
            return receipt as JsonObject;
          },
          onTaskSettled: (taskId) => {
            void autoClaimLoop.trigger("runtime-terminal", { repoId, taskId }).catch((error: unknown) => {
              process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
                code: "NODE_AUTO_CLAIM_SCAN_FAILED",
              });
            });
            void autoDispatchLoop.trigger("runtime-terminal").catch((error: unknown) => {
              process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
                code: "NODE_AUTO_DISPATCH_SCAN_FAILED",
              });
            });
          },
          waitForReplicaReady: (request) => waitForFleetReplicaReady(request),
          ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
          now,
        });
    fleetEdgeRuntimes.set(key, runtime);
    return runtime;
  }
  function forwardRuntime(request: RuntimeForwardingRequest): Promise<JsonObject | null> {
    return forward({
      userRoot: input.userRoot,
      repoId: request.repoId,
      intent: runtimeForwardingIntent(request.method, request.action, request),
      auth: request.auth,
      oidc,
      runRuntime: async (value, requestAuth, operation) => {
        const payload = value as unknown as FleetEdgeRuntimeRequest["payload"],
          runtime = runtimeOwnerFor(payload),
          result =
            operation === "reconcile"
              ? (await runtime.reconcile(), { outcome: "applied" })
              : await runtime.run(payload.method, payload.action, requestAuth.connectionSignal);
        return request.decorate ? request.decorate(payload, result) : result;
      },
    }) as Promise<JsonObject | null>;
  }
  async function migrateEdgeWorkspace(repoId: string, oldRoot: string, newRoot: string): Promise<void> {
    const running = replicaSyncControllers.get(repoId);
    if (running) {
      running.controller.abort();
      await running.task;
      replicaSyncControllers.delete(repoId);
    }
    try {
      migrateFleetEdgeWorkspace(oldRoot, newRoot, repoId, input.userRoot);
    } catch (error) {
      startReplicaSyncs();
      throw error;
    }
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
      const current =
        schedule.spec.target.kind === "builtin" && action.kind === "schedule-settle"
          ? system
          : await hostBinding(rootDir, { transportKind: "unix-socket" });
      if (
        schedule.spec.target.kind !== "builtin" &&
        current.actor.principal.personId !== schedule.createdBy.principal.personId
      )
        throw hostCodedError("authentication_required", "The schedule creator must sign in on this device.");
      return daemonWriterBinding(repoId, current);
    },
    remoteEdgeAction: async (repoId, _rootDir, action) => {
      if (typeof action.kind !== "string") throw hostCodedError("invalid_field", "Schedule action kind is required.");
      const runtimeSessionRead = action.kind === "runtime-session-read",
        method = runtimeSessionRead ? "repo.agentRuntime.sessions.read" : "repo.schedule.run",
        forwardedAction = runtimeSessionRead ? { runtimeSessionId: action.runtimeSessionId } : action;
      const receipt = await forwardRuntime({
        repoId,
        method,
        action: forwardedAction as JsonObject,
        auth: { transportKind: "unix-socket" },
      });
      if (!receipt) throw hostCodedError("fleet_edge_config_invalid", `Remote-edge Schedule ${repoId} is unavailable.`);
      return receipt;
    },
  });
  let latestControl: DaemonControlReceipt | null = null;
  let fleetCenter: FleetTlsCenter | null = null;
  let initialAttachments: Promise<void> | null = null,
    initialAttachmentsSettled = false,
    replicaSyncStartQueued = false,
    closing = false;
  const replicaSyncTasks = new Set<Promise<void>>();
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
      readonly authoredBranch: string | null;
    } => repo.state === "enabled" && repo.mode !== "remote-proxy" && repo.canonicalRoot !== null,
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
    onAutoClaimTrigger: (reason, releasedTask) => {
      void autoClaimLoop.trigger(reason, releasedTask).catch((error: unknown) => {
        process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
          code: "NODE_AUTO_CLAIM_SCAN_FAILED",
        });
      });
      void autoDispatchLoop.trigger(reason).catch((error: unknown) => {
        process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
          code: "NODE_AUTO_DISPATCH_SCAN_FAILED",
        });
      });
    },
    forwardRuntime,
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
    if (registered.repo.canonicalRoot === null)
      throw hostCodedError(
        "registry_repo_invalid",
        `Workspace repository ${repoId} has no authored branch or canonical root.`,
      );
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
    fleetVersionWarnings,
    runtimeRecoveryWatch,
    runtimeDaemonRoute,
    scheduleScheduler,
    forwardRuntime,
    migrateEdgeWorkspace,
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
  const accessAdmin = new AccessAdminService(oidc, input.userRoot, {
    daemonId: input.daemonId,
    nodeRetirement: createNodeRetirement({
      storage: input.storage,
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
  const resumed = managedRbac.resume();
  rbacResumed = resumed;
  void resumed.then(
    () => input.recordLifecycle?.({ event: "identity_ready" }),
    (error: unknown) => {
      input.recordLifecycle?.({
        event: "rbac_resume_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  const parkedWaitController = new AbortController(),
    edgeJoinProgress = createEdgeJoinProgressTap();
  const host: DaemonHost = {
    skillEvalRunner: skillEvalProduction.runner,
    skillEval: skillEvalProduction.service,
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
    identityCenter: keycloakCenter,
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
        rootDir = requestedRoot ?? registered?.canonicalRoot,
        edgeReplicaRead =
          registered?.mode === "remote-edge" &&
          payload?.action !== null &&
          typeof payload?.action === "object" &&
          typeof (payload.action as Record<string, unknown>).kind === "string" &&
          !["fleet-runtime", "fleet-schedule"].includes(String((payload.action as Record<string, unknown>).kind)) &&
          commandDescriptorForAction(String((payload.action as Record<string, unknown>).kind)).admission[
            "remote-edge"
          ] === "edge-replica";
      if (!rootDir && methodContract?.requiresRepo)
        throw hostCodedError("oidc_center_required", "Select a repository with a configured center before continuing.");
      if (!rootDir && !method.startsWith("daemon.skillEval.")) return undefined;
      const bound = await oidc.bind(auth, rootDir ?? undefined, edgeReplicaRead);
      if (edgeReplicaRead && bound.replicaReadDenied)
        throw hostCodedError("authorization_denied", "The current session does not authorize this replica read.");
      return bound.oidcPrincipal;
    },
    parkedWaitSignal: parkedWaitController.signal,
    ...createDaemonHostRepositoryApi(hostContext),
    ...createDaemonHostRuntimeApi(hostContext),
    ...createDaemonHostControlApi(hostContext),
    ...lifecycle,
    manageRbac: (request, auth) => {
      localOnly(auth);
      return (async () => {
        if (request.operation === "edge-join-progress") {
          return { ok: true, command: "edge-join", ...edgeJoinProgress.read() };
        }
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
        if (request.operation === "edge-join-create" && request.joinMode === "member-device" && loginTarget) {
          const edge = readFleetEdgeConfig(loginTarget);
          if (edge) {
            return {
              ...(await createFleetMemberDeviceLink(
                {
                  hostname: edge.host,
                  port: edge.port,
                  ca: readFileSync(edge.caPath),
                  ...(edge.servername ? { servername: edge.servername } : {}),
                  nodeId: edge.nodeId,
                  credential: edge.credential,
                  repoId: edge.repoId,
                  readAccessToken: async () => (await oidc.bind(auth, loginTarget)).oidcPrincipal?.accessToken,
                },
                (request.repoIds ?? []) as readonly string[],
              )),
            };
          }
        }
        if (request.operation === "edge-join") {
          const originUrls = edgeJoinOriginUrls(request.originUrls);
          return joinFleetEdge(
            {
              link: String(request.link ?? ""),
              ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
              ...(request.quotaBytes === undefined ? {} : { quotaBytes: request.quotaBytes }),
              ...(originUrls === undefined ? {} : { originUrls }),
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
        }
        if (request.mode === "external" || request.mode === "managed")
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
        if (request.operation === "device-approval") return oidc.deviceApproval(request.code ?? "", loginTarget);
        if (request.operation === "session") return oidc.status(loginTarget);
        if (request.operation === "logout") return oidc.logout(loginTarget);
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
        if (request.operation === "listener-set") {
          return oidc.configureAuthority(() => managedRbac.run(request), requireLoginTarget());
        }
        return requireAuthorizedHostAction({
          kind: "rbac-bootstrap",
          binding: localSystemBinding(input.userRoot),
          actionId: `rbac-bootstrap:${request.operation ?? "bootstrap"}`,
          evaluatedAtCut: "daemon-rbac:current",
        }).then(() => managedRbac.run(request));
      })();
    },
    close: async () => {
      parkedWaitController.abort();
      markDaemonOperationPhase("auto-claim.close");
      await autoClaimLoop.close();
      await autoDispatchLoop.close();
      for (const { controller } of replicaSyncControllers.values()) controller.abort();
      replicaSyncControllers.clear();
      markDaemonOperationPhase("rbac-resume-and-access-admin.close");
      await rbacResumed.catch(consumeKnownError);
      await accessAdmin.close();
      markDaemonOperationPhase("managed-rbac.stop");
      await managedRbac.stop();
      await lifecycle.close();
    },
  };
  const startReplicaSyncs = (): void => {
    if (closing) return;
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
      if (!config || config.repoId !== repo.repoId) {
        fleetVersionWarnings.delete(repo.repoId);
        continue;
      }
      activeRemoteEdges.add(repo.repoId);
      const running = replicaSyncControllers.get(repo.repoId),
        connection = JSON.stringify([rootDir, config]);
      if (running?.config === connection) continue;
      fleetVersionWarnings.delete(repo.repoId);
      running?.controller.abort();
      const controller = new AbortController(),
        replicaSync = { controller, config: connection, task: Promise.resolve() };
      replicaSyncControllers.set(repo.repoId, replicaSync);
      const viewRoot = path.isAbsolute(config.viewRoot) ? config.viewRoot : path.resolve(rootDir, config.viewRoot);
      const caPath = path.isAbsolute(config.caPath) ? config.caPath : path.resolve(rootDir, config.caPath);
      const readAccessToken = createFleetReplicaAccessTokenReader({
        config,
        workspaceRoot: rootDir,
        readUserAccessToken: async () => {
          const auth = await oidc.bind({ transportKind: "unix-socket" }, rootDir);
          return auth.localSessionAccessToken ? auth.localSessionAccessToken() : auth.oidcPrincipal?.accessToken;
        },
      });
      const task = runFleetReplicaSync({
        readAccessToken,
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
        onVersionWarning: (warning) => {
          if (warning === null) fleetVersionWarnings.delete(repo.repoId);
          else fleetVersionWarnings.set(repo.repoId, warning);
        },
        onRevoked: () => revokeFleetMirrorTree(rootDir),
        onConfirmed: async (changedPaths) => {
          applyFleetMirrorCut(viewRoot, config.repoId, rootDir, "pull", { changedPaths });
          await runReplicaConfirmedRound({
            reconcile: async () => {
              const result = await forwardRuntime({
                repoId: repo.repoId,
                method: "repo.squad.control",
                action: {},
                auth: { transportKind: "unix-socket" },
                operation: "reconcile",
              });
              if (!result)
                throw hostCodedError("fleet_edge_config_invalid", `Remote-edge ${repo.repoId} is unavailable.`);
            },
            observeRecovery: (failures) => runtimeRecoveryWatch.observe(config.repoId, failures, now()),
            triggers: [
              () => autoClaimLoop.trigger("replica-confirmed"),
              () => autoDispatchLoop.trigger("replica-confirmed"),
            ],
          });
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
      replicaSync.task = task;
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
      fleetVersionWarnings.delete(repoId);
    }
  };
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
          storage: input.storage,
          buildDraining: input.buildDraining,
          onDeliverySettled: input.onRepoStatusChange,
          recordTraffic: input.recordTraffic,
          ...(input.authenticateExecutionPrincipal
            ? { authenticateExecutionPrincipal: input.authenticateExecutionPrincipal }
            : {}),
          userRoot: input.userRoot,
          writerEpochLease: hostContext.writerEpochLease,
          payload: config,
          nodes: {
            ...keycloakNodeRegistry(hostContext.keycloakCenter),
            loginAuthority: (nodeId) => oidc.discovery(nodeId),
            ...(oidc.revokeDeviceSessions
              ? { revokeDeviceSessions: (nodeId: string) => oidc.revokeDeviceSessions!(nodeId) }
              : {}),
            ...(oidc.receiveDeviceNotice
              ? {
                  deviceLoginNotice: (nodeId: string, personId: string, notice: FleetDeviceLoginNotice) =>
                    oidc.receiveDeviceNotice!(nodeId, personId, notice),
                }
              : {}),
            verifyHuman: (auth) => oidc.bind(auth),
            ...(oidc.bindReplica
              ? { verifyReplica: (auth: DaemonAuthenticationContext) => oidc.bindReplica!(auth) }
              : {}),
            createMemberEdgeJoin: (repos, person, token) => accessAdmin.createMemberEdgeJoin(repos, person, token),
            edgeJoinStatus: (input) => accessAdmin.edgeJoinStatus(input),
            edgeJoin: (input) =>
              accessAdmin.admitEdgeJoin({
                joinId: input.joinId,
                inviteToken: input.inviteToken,
                ...(input.recovery ? { recovery: input.recovery } : {}),
                accessToken: input.accessToken,
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
      readonly authoredBranch: string | null;
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
      readonly authoredBranch: string | null;
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

function edgeJoinOriginUrls(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw hostCodedError("edge_origin_invalid", "Edge join origin addresses must be a repository-to-address map.");
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(
      ([repoId, address]) =>
        !repoId ||
        repoId.length > 128 ||
        typeof address !== "string" ||
        !address.trim() ||
        address.length > 2_048 ||
        /[\0\r\n]/u.test(address),
    )
  )
    throw hostCodedError("edge_origin_invalid", "Edge join origin addresses contain an invalid repository or address.");
  return Object.fromEntries(entries) as Record<string, string>;
}

import {
  daemonControlInProgressError,
  makeDaemonLogService,
  makeLocalControllerService
} from "../../../application/src/index.ts";
import type { DaemonLogService } from "../../../application/src/index.ts";
import { randomUUID } from "node:crypto";
import {
  createPtyTerminalSessionService,
  createJsonRpcProtocolServer,
  calculateDaemonArtifactIdentity,
  type AcceptedConnectionBinding,
  type AuthorityConnectionDispatch,
  type AuthorityWireIngressHandler,
  type DaemonActiveControlStatus,
  type DaemonControlService,
  type DaemonStatusResultV2,
  type DaemonAuthenticationContext,
  type DaemonRepoAvailabilityFailure,
  type DaemonRepoNamespace
} from "../../../daemon/src/index.ts";
import {
  makeMarkdownArtifactStore,
  readDaemonRegistry,
} from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { loadDaemonIdentity } from "../commands/daemon/productization.ts";
import { makeDaemonGuiControllerOptions } from "../commands/extensions/gui-controller-options.ts";
import {
  daemonStatusPayload,
  type DaemonConnectionStats
} from "../commands/daemon/status-payload.ts";
import { leaseEnforcementEnabled } from "../commands/settings.ts";
import {
  selectCliAdapterProvider,
  type CliCompositionAdapterProvider
} from "../composition/adapter-registry.ts";
import { daemonActorAttribution } from "../composition/actor-attribution.ts";
import { failClosedReservationReconcilerCoordinator } from "../composition/reservation-reconciler.ts";
import { createCliCommandService } from "./command-service.ts";
import { createAuthorityWireIngressHandler } from "./authority-wire-service.ts";
import { canonicalRootIdentity } from "./canonical-root.ts";
import { makeDocSyncService } from "./doc-sync-service.ts";
import { makeDaemonLogFileStore } from "./daemon-log-file-store.ts";
import { drainDaemonRuntime, isDaemonDrainTimeout } from "./daemon-drain.ts";
import {
  makeDaemonQueuedWriteCoordinator
} from "./queued-write-coordinator.ts";
import {
  createDaemonReconcileState,
  reconcileDaemonRepoRegistry,
  type DaemonReconcileState
} from "./registry-reconciler.ts";
import type {
  AuthorityRepoComponent,
  AuthorityRepoLifecycleController
} from "./authority-lifecycle.ts";
import { makeLocalAgentHolderServices } from "./agent-holder-projection-host.ts";

type HarnessDaemonRuntime = ReturnType<CliCompositionAdapterProvider["createDaemonRuntime"]>;
type MultiRepoHarnessDaemonRuntime = ReturnType<CliCompositionAdapterProvider["createMultiRepoDaemonRuntime"]>;
type RepoServiceBinding = ReturnType<typeof createRepoServiceBinding>;
type RepoIdentity = ReturnType<typeof loadDaemonIdentity> & { readonly loadError?: string };

export async function createDaemonServiceHost(
  runtime: MultiRepoHarnessDaemonRuntime,
  repos: ReadonlyArray<DaemonRepoNamespace>,
  defaultRepoId: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  idleMs: number,
  endpoint: string,
  connections: DaemonConnectionStats,
  userRoot: string,
  build: {
    readonly entrypoint: string;
    readonly loadedIdentity: string;
    readonly startedAt: string;
  },
  authorityLifecycle?: AuthorityRepoLifecycleController
): Promise<{
  readonly daemonId: string;
  readonly createProtocolServer: (
    authContext: DaemonAuthenticationContext,
    acceptedConnection?: AcceptedConnectionBinding
  ) => ReturnType<typeof createJsonRpcProtocolServer>;
  readonly acceptsSshForcedCommand: (canonicalRoot: string) => boolean;
  readonly authorityWireIngress: AuthorityWireIngressHandler;
  readonly status: () => DaemonStatusResultV2;
  readonly onConnectionStart: () => void;
  readonly onConnectionSettled: () => void;
  readonly scheduleIdleExit: () => void;
  readonly waitForStopRequest: () => Promise<void>;
  readonly onStop: (handler: () => Promise<void>) => void;
  readonly startRegistryReconcile: (userRoot: string) => void;
  readonly reconcileNow: (userRoot: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  const daemonId = `ha-${process.pid}`;
  const daemonLogService = makeDaemonLogService({ store: makeDaemonLogFileStore({ userRoot }) });
  const stopHandlers: Array<() => Promise<void>> = [];
  const reposById = new Map(repos.map((repo) => [repo.repoId, repo]));
  let requestStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciling = false;
  let stopping = false;
  let drainTimeoutMs: number | undefined;
  let activeControl: DaemonActiveControlStatus | null = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    try {
      await drainDaemonRuntime({
        authorityLifecycle,
        runtime,
        drainTimeoutMs
      });
    } catch (error) {
      if (isDaemonDrainTimeout(error) && activeControl) {
        activeControl = {
          ...activeControl,
          phase: "failed",
          failure: cliError(
            CliErrorCode.DaemonQueueDrainTimeout,
            `Daemon ${activeControl.kind} requires the write queue to drain within the deadline, but in-flight operations failed to settle in time. Run \`ha daemon status --json\`, inspect the reported queue operation tuples, resolve or recover them, then retry the control request.`
          ) as NonNullable<DaemonActiveControlStatus["failure"]>
        };
        return;
      }
      throw error;
    }
    for (const handler of stopHandlers.splice(0, stopHandlers.length)) {
      await handler();
    }
  };
  const scheduleIdleExit = () => {
    if (idleMs <= 0 || stopping || connections.active !== 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      requestStop?.();
    }, idleMs);
    idleTimer.unref();
  };
  const commandOptions = {
    onCommandStart: () => {
      if (activeControl) {
        throw new Error(`DAEMON_DRAINING_ADMISSION_CLOSED: daemon ${activeControl.kind} operation ${activeControl.operationId} is draining. Run \`ha daemon status --json\` and wait for it to complete or report its timeout before retrying.`);
      }
      if (idleTimer) clearTimeout(idleTimer);
    },
    onCommandSettled: scheduleIdleExit
  };
  const reconcileState = createDaemonReconcileState();
  const controlService: DaemonControlService = {
    requestControl: (kind, request) => {
      if (activeControl) {
        return {
          ok: false,
          error: daemonControlInProgressError(activeControl)
        };
      }
      const before = serviceStatus(defaultRepoId);
      const operationId = `control_${randomUUID()}`;
      const requestedAt = new Date().toISOString();
      activeControl = { operationId, kind, phase: "accepted", requestedAt };
      return {
        ok: true,
        accepted: {
          schema: "daemon-control-accepted/v1",
          accepted: true,
          operationId,
          kind,
          scope: "service",
          requestedAt,
          before: {
            pid: before.service.pid,
            loadedIdentity: before.service.build.loadedIdentity,
            repoCount: before.service.repoCount,
            queueDepth: before.service.queue.depth
          }
        },
        afterResponse: () => {
          if (activeControl?.operationId !== operationId) return;
          activeControl = { ...activeControl, phase: "draining" };
          drainTimeoutMs = request.drainTimeoutMs;
          requestStop?.();
        }
      };
    }
  };
  const repoBindings = new Map<string, RepoServiceBinding>();
  for (const repo of repos) {
    const repoRuntime = runtime.getRepoRuntime(repo.repoId);
    if (!repoRuntime) throw new Error(`daemon runtime missing repo context: ${repo.repoId}`);
    const runtimeRepoStatus = runtime.status().repos.find((candidate) => candidate.repoId === repo.repoId);
    if (authorityLifecycle && runtimeRepoStatus?.state !== "attached") continue;
    let authorityComponent: AuthorityRepoComponent | undefined;
    if (authorityLifecycle) {
      const startedAuthority = await authorityLifecycle.startRepo(repo, repoRuntime);
      if (!startedAuthority.ok) continue;
      authorityComponent = startedAuthority.component;
    }
    repoBindings.set(repo.repoId, createRepoServiceBinding(
      repo,
      repoRuntime,
      runtime,
      layoutOverrides,
      commandOptions,
      { daemonId, endpoint, connections, userRoot, reconcileStatus: reconcileState, build, controlService, daemonLogService, activeControl: () => activeControl },
      authorityComponent
    ));
  }
  const selectedFallbackBinding = repoBindings.get(defaultRepoId) ?? repoBindings.values().next().value;
  if (!selectedFallbackBinding) throw new Error("daemon service host has no repo bindings");
  const serviceFallbackBinding: RepoServiceBinding = selectedFallbackBinding;
  return {
    daemonId,
    createProtocolServer: (authContext, acceptedConnection) => createJsonRpcProtocolServer({
      daemonId,
      repos: protocolRepos(),
      services: defaultRepoBinding().services,
      resolveRepoServices: (repo) => protocolRepoBinding(repo)?.services,
      resolveRepoIdentity: (repo) => protocolRepoBinding(repo)?.identity,
      resolveRepoAvailability: (repo) => repoAvailabilityFailure(
        runtime,
        repo,
        authorityLifecycle?.unavailableReason(repo.repoId)
      ),
      leaseEnforcementEnabled: (repo) => leaseEnforcementEnabled({ rootDir: repo.canonicalRoot, layoutOverrides }),
      authContext,
      ...(acceptedConnection ? { acceptedConnection } : {}),
      ...(authorityLifecycle ? { authorityPeerPolicy: localAuthorityPeerPolicy } : {}),
      ...(defaultRepoBinding().identity.identityProvider ? { identityProvider: defaultRepoBinding().identity.identityProvider } : {}),
      ...(defaultRepoBinding().identity.personRegistry ? { personRegistry: defaultRepoBinding().identity.personRegistry } : {}),
      ...(defaultRepoBinding().identity.identityAdminSnapshot ? { identityAdminSnapshot: defaultRepoBinding().identity.identityAdminSnapshot } : {}),
      appendRuntimeEvent: (input, context) => {
        const targetRepoId = context?.repo.repoId ?? defaultRepoId;
        return repoBindings.get(targetRepoId)?.appendRuntimeEvent(input) ?? Promise.resolve();
      }
    }),
    acceptsSshForcedCommand: (canonicalRoot) => [...repoBindings.values()].some((binding) =>
      binding.identity.mode === "remote" && sameCanonicalRoot(binding.repo.canonicalRoot, canonicalRoot)
    ),
    authorityWireIngress: createAuthorityWireIngressHandler({
      authorityLifecycle,
      repoBindings: () => repoBindings.values()
    }),
    status: () => serviceStatus(defaultRepoBinding().repo.repoId),
    onConnectionStart: () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    },
    onConnectionSettled: scheduleIdleExit,
    scheduleIdleExit,
    waitForStopRequest: () => stopRequested,
    onStop: (handler) => {
      stopHandlers.push(handler);
    },
    startRegistryReconcile: (userRoot) => {
      if (reconcileTimer || stopping) return;
      const reconcile = async () => {
        if (reconciling || stopping) return;
        reconciling = true;
        try {
          await reconcileDaemonRepos(userRoot);
        } finally {
          reconciling = false;
        }
      };
      reconcileTimer = setInterval(() => {
        void reconcile();
      }, 1_000);
      reconcileTimer.unref();
    },
    reconcileNow: (targetUserRoot) => reconcileDaemonRepos(targetUserRoot),
    stop
  };

  function defaultRepoBinding(): RepoServiceBinding {
    return repoBindings.get(defaultRepoId) ?? repoBindings.values().next().value ?? serviceFallbackBinding;
  }

  function protocolRepos(): ReadonlyArray<DaemonRepoNamespace> {
    return sortedDaemonRepos(reposById.size > 0 ? [...reposById.values()] : [serviceFallbackBinding.repo]);
  }

  function protocolRepoBinding(repo: DaemonRepoNamespace): RepoServiceBinding | undefined {
    const binding = repoBindings.get(repo.repoId);
    if (binding) return binding;
    return reposById.size === 0
      && repo.repoId === serviceFallbackBinding.repo.repoId
      && sameCanonicalRoot(repo.canonicalRoot, serviceFallbackBinding.repo.canonicalRoot)
      ? serviceFallbackBinding
      : undefined;
  }

  async function reconcileDaemonRepos(userRoot: string): Promise<void> {
    await reconcileDaemonRepoRegistry({
      loadDesiredRepos: () => readDaemonRegistry({ userRoot }).repos.filter((repo) => repo.state === "enabled"),
      knownRepoIds: () => [...reposById.keys()],
      repoStatus: (repoId) => runtime.status().repos.find((candidate) => candidate.repoId === repoId),
      attachRepo: async (repo) => {
        if (!reposById.has(repo.repoId)) {
          reposById.set(repo.repoId, { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot });
        }
        return runtime.attachRepo({
          repoId: repo.repoId,
          rootDir: repo.canonicalRoot,
          displayName: repo.displayName,
          ...(layoutOverrides ? { layoutOverrides } : {})
        });
      },
      bindRepo: async (repo) => {
        if (repoBindings.has(repo.repoId)) return;
        const namespace = reposById.get(repo.repoId) ?? { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot };
        reposById.set(repo.repoId, namespace);
        const repoRuntime = runtime.getRepoRuntime(repo.repoId);
        if (!repoRuntime) throw new Error(`daemon runtime missing repo context: ${repo.repoId}`);
        let authorityComponent: AuthorityRepoComponent | undefined;
        if (authorityLifecycle) {
          const startedAuthority = await authorityLifecycle.startRepo(namespace, repoRuntime);
          if (!startedAuthority.ok) throw new Error(startedAuthority.error);
          authorityComponent = startedAuthority.component;
        }
        repoBindings.set(repo.repoId, createRepoServiceBinding(
          namespace,
          repoRuntime,
          runtime,
          layoutOverrides,
          commandOptions,
          { daemonId, endpoint, connections, userRoot, reconcileStatus: reconcileState, build, controlService, daemonLogService, activeControl: () => activeControl },
          authorityComponent
        ));
      },
      detachRepo: async (repoId) => {
        repoBindings.delete(repoId);
        const repo = reposById.get(repoId);
        authorityLifecycle?.unpublishRepo(repoId);
        if (repo) await authorityLifecycle?.stopRepo(repo, "reconcile-removed");
        if (runtime.getRepoRuntime(repoId)) await runtime.detachRepo(repoId);
      },
      removeRepo: (repoId) => {
        repoBindings.delete(repoId);
        reposById.delete(repoId);
      }
    }, reconcileState);
  }

  function serviceStatus(repoId: string): DaemonStatusResultV2 {
    const target = reposById.get(repoId) ?? defaultRepoBinding().repo;
    return daemonStatusPayload({
      daemonId,
      rootDir: target.canonicalRoot,
      repoId: target.repoId,
      endpoint,
      userRoot,
      startedAt: build.startedAt,
      loadedIdentity: build.loadedIdentity,
      readInstalledIdentity: () => calculateDaemonArtifactIdentity(build.entrypoint).identity,
      activeControl,
      runtimeStatus: runtime.status(),
      connections,
      reconcileStatus: reconcileState
    });
  }
}

function createRepoServiceBinding(
  repo: DaemonRepoNamespace,
  runtime: HarnessDaemonRuntime,
  managerRuntime: MultiRepoHarnessDaemonRuntime,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  commandOptions: { readonly onCommandStart: () => void; readonly onCommandSettled: () => void },
  statusOptions?: {
    readonly daemonId?: string;
    readonly endpoint?: string;
    readonly connections?: DaemonConnectionStats;
    readonly userRoot?: string;
    readonly reconcileStatus?: DaemonReconcileState;
    readonly build?: {
      readonly entrypoint: string;
      readonly loadedIdentity: string;
      readonly startedAt: string;
    };
    readonly controlService?: DaemonControlService;
    readonly daemonLogService?: DaemonLogService;
    readonly activeControl?: () => DaemonActiveControlStatus | null;
  },
  authorityComponent?: AuthorityRepoComponent
): {
  readonly repo: DaemonRepoNamespace;
  readonly identity: RepoIdentity;
  readonly services: Parameters<typeof createJsonRpcProtocolServer>[0]["services"];
  readonly appendRuntimeEvent: ReturnType<typeof makeLocalAgentHolderServices>["appendRuntimeEvent"];
} {
  const rootDir = repo.canonicalRoot;
  const identity = loadRepoIdentity(rootDir, layoutOverrides, statusOptions?.endpoint, statusOptions?.userRoot);
  const taskWriter = selectCliAdapterProvider("task.lifecycle").createLifecycleEngine({
    rootDir,
    layoutOverrides,
    coordinator: failClosedReservationReconcilerCoordinator()
  });
  const { appendRuntimeEvent, taskHolderService, agentRuntimeControllerOptions, agentHolderProjection } =
    makeLocalAgentHolderServices(rootDir, layoutOverrides, runtime);
  const localController = makeLocalControllerService({
    rootDir,
    layoutOverrides,
    taskWriter,
    artifactStore: makeMarkdownArtifactStore({ rootDir, layoutOverrides }),
    ...makeDaemonGuiControllerOptions(runtime, { rootDir, layoutOverrides }, commandOptions),
    projectionQueries: {
      getExecutionEvidencePage: async (payload) => ({
        ok: true,
        ...await runtime.queryExecutionEvidencePage({
          limit: payload.limit,
          ...(payload.cursor ? { cursor: payload.cursor } : {})
        })
      })
    },
    ...agentRuntimeControllerOptions,
    agentHolderProjection
  });
  const cliCommandService = createCliCommandService(runtime, {
    ...commandOptions,
    ...(authorityComponent ? { authorityCutoverControl: authorityComponent.cutoverControl } : {}),
    ...(authorityComponent ? {
      resolveAuthoritySubmissionV2: (dispatch) => requireAuthoritySubmissionForDispatch(
        authorityComponent,
        repo.repoId,
        dispatch
      )
    } : {})
  });
  return {
    repo,
    identity,
    services: {
      LocalControllerService: localController,
      TerminalSessionService: createPtyTerminalSessionService({ workspaceRoot: rootDir }),
      TaskHolderService: taskHolderService,
      ...(statusOptions?.daemonLogService ? { DaemonLogService: statusOptions.daemonLogService } : {}),
      DaemonStatusService: {
        getStatus: (context) => {
          const targetRepo = context?.repo ?? repo;
          return daemonStatusPayload({
            daemonId: statusOptions?.daemonId ?? `ha-${process.pid}`,
            rootDir: targetRepo.canonicalRoot,
            repoId: targetRepo.repoId,
            endpoint: statusOptions?.endpoint ?? "repo-router",
            userRoot: statusOptions?.userRoot ?? rootDir,
            startedAt: statusOptions?.build?.startedAt ?? new Date(0).toISOString(),
            loadedIdentity: statusOptions?.build?.loadedIdentity ?? "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            readInstalledIdentity: () => statusOptions?.build
              ? calculateDaemonArtifactIdentity(statusOptions.build.entrypoint).identity
              : "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            activeControl: statusOptions?.activeControl?.() ?? null,
            runtimeStatus: managerRuntime.status(),
            connections: statusOptions?.connections ?? { active: 0, total: 0 },
            ...(statusOptions?.reconcileStatus ? { reconcileStatus: statusOptions.reconcileStatus } : {})
          });
        }
      },
      ...(statusOptions?.controlService ? { DaemonControlService: statusOptions.controlService } : {}),
      CliCommandService: cliCommandService,
      DocSyncService: {
        submit: (request, context) => {
          const actor = context?.actor;
          const attribution = actor ? daemonActorAttribution(actor, context?.executor) : undefined;
          const docSyncService = makeDocSyncService({
            rootDir,
            layoutOverrides,
            ...(attribution ? {
              coordinator: makeDaemonQueuedWriteCoordinator(runtime, `doc-sync-submit:${request.payload.intentId}`, {
                attribution: attribution.writeAttribution,
                commitAuthor: attribution.commitAuthor,
                ...(request.session?.sessionId ? { sessionId: request.session.sessionId } : {})
              })
            } : {})
          });
          return docSyncService.submit(request);
        }
      }
    },
    appendRuntimeEvent
  };
}

export function bindAuthoritySubmissionForDispatch(
  component: AuthorityRepoComponent,
  repoId: string,
  dispatch: AuthorityConnectionDispatch | undefined
): ReturnType<AuthorityRepoComponent["bindConnection"]> | undefined {
  if (!dispatch?.available) return undefined;
  if (dispatch.context.repoId !== repoId) throw new Error("AUTHORITY_CONNECTION_REPO_MISMATCH");
  dispatch.assertActive();
  const bound = component.bindConnection(dispatch.context);
  return {
    submit: async (submission) => {
      dispatch.assertActive();
      return bound.submit(submission);
    }
  };
}

function requireAuthoritySubmissionForDispatch(
  component: AuthorityRepoComponent,
  repoId: string,
  dispatch: AuthorityConnectionDispatch | undefined
): ReturnType<AuthorityRepoComponent["bindConnection"]> {
  const bound = bindAuthoritySubmissionForDispatch(component, repoId, dispatch);
  if (!bound) throw new Error("AUTHORITY_CONNECTION_REQUIRED");
  return bound;
}

function loadRepoIdentity(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  endpoint: string | undefined,
  userRoot: string | undefined
): RepoIdentity {
  try {
    return loadDaemonIdentity(rootDir, layoutOverrides, endpoint, userRoot);
  } catch (error) {
    return {
      mode: "local",
      loadError: error instanceof Error ? error.message : String(error)
    };
  }
}

function repoAvailabilityFailure(
  runtime: MultiRepoHarnessDaemonRuntime,
  repo: DaemonRepoNamespace,
  authorityUnavailable?: string
): DaemonRepoAvailabilityFailure | undefined {
  const status = runtime.status().repos.find((candidate) => candidate.repoId === repo.repoId);
  if (!status) {
    return {
      code: "repo_unavailable",
      repo: {
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: "unavailable",
        lockPath: null,
        lockOwnerToken: null,
        lastError: "runtime context not found"
      }
    };
  }
  if (status.state === "attached" && !authorityUnavailable) return undefined;
  const lockHeld = typeof status.lastError === "string" && /lock already held|global\.lock/u.test(status.lastError);
  return {
    code: lockHeld ? "repo_lock_held" : "repo_unavailable",
    repo: {
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      state: status.state,
      lockPath: status.lockPath ?? null,
      lockOwnerToken: status.lockOwnerToken ?? null,
      lastError: authorityUnavailable ?? status.lastError ?? null
    }
  };
}

function sortedDaemonRepos(repos: ReadonlyArray<DaemonRepoNamespace>): ReadonlyArray<DaemonRepoNamespace> {
  return [...repos].sort((left, right) => left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot));
}

function sameCanonicalRoot(left: string, right: string): boolean {
  return canonicalRootIdentity(left) === canonicalRootIdentity(right);
}

export function localAuthorityPeerPolicy(input: Parameters<NonNullable<
  Parameters<typeof createJsonRpcProtocolServer>[0]["authorityPeerPolicy"]
>>[0]): boolean {
  if (input.actor.resolvedCredential.kind !== "unix-socket-owner-boundary") return false;
  const credentialUid = Number(input.actor.resolvedCredential.subject);
  const daemonUid = process.getuid?.();
  return Number.isSafeInteger(credentialUid)
    && credentialUid >= 0
    && typeof daemonUid === "number"
    && input.peerCredential.uid === credentialUid
    && input.peerCredential.uid === daemonUid;
}

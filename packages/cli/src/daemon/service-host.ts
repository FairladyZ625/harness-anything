import {
  makeLocalControllerService,
  makeRuntimeEventAppendPromise,
  makeRuntimeEventLedgerService,
  makeTaskHolderService
} from "../../../application/src/index.ts";
import {
  createPtyTerminalSessionService,
  createJsonRpcProtocolServer,
  type DaemonAuthenticationContext,
  type DaemonRepoAvailabilityFailure,
  type DaemonRepoNamespace
} from "../../../daemon/src/index.ts";
import {
  makeMarkdownArtifactStore,
  readDaemonRegistry
} from "../../../kernel/src/index.ts";
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
import { makeDocSyncService } from "./doc-sync-service.ts";
import {
  makeDaemonQueuedOperationalWriteCoordinator,
  makeDaemonQueuedWriteCoordinator
} from "./queued-write-coordinator.ts";

type HarnessDaemonRuntime = ReturnType<CliCompositionAdapterProvider["createDaemonRuntime"]>;
type MultiRepoHarnessDaemonRuntime = ReturnType<CliCompositionAdapterProvider["createMultiRepoDaemonRuntime"]>;
type RepoServiceBinding = ReturnType<typeof createRepoServiceBinding>;

export function createDaemonServiceHost(
  runtime: MultiRepoHarnessDaemonRuntime,
  repos: ReadonlyArray<DaemonRepoNamespace>,
  defaultRepoId: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  idleMs: number,
  endpoint: string,
  connections: DaemonConnectionStats
): {
  readonly daemonId: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => ReturnType<typeof createJsonRpcProtocolServer>;
  readonly status: () => Record<string, unknown>;
  readonly onConnectionStart: () => void;
  readonly onConnectionSettled: () => void;
  readonly scheduleIdleExit: () => void;
  readonly waitForStopRequest: () => Promise<void>;
  readonly onStop: (handler: () => Promise<void>) => void;
  readonly startRegistryReconcile: (userRoot: string) => void;
  readonly stop: () => Promise<void>;
} {
  const daemonId = `ha-${process.pid}`;
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
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    for (const handler of stopHandlers.splice(0, stopHandlers.length)) {
      await handler();
    }
    await runtime.stop();
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
      if (idleTimer) clearTimeout(idleTimer);
    },
    onCommandSettled: scheduleIdleExit
  };
  const repoBindings = new Map(repos.map((repo) => {
    const repoRuntime = runtime.getRepoRuntime(repo.repoId);
    if (!repoRuntime) throw new Error(`daemon runtime missing repo context: ${repo.repoId}`);
    return [repo.repoId, createRepoServiceBinding(
      repo,
      repoRuntime,
      runtime,
      layoutOverrides,
      commandOptions,
      { daemonId, endpoint, connections }
    )] as const;
  }));
  return {
    daemonId,
    createProtocolServer: (authContext) => createJsonRpcProtocolServer({
      daemonId,
      repos: sortedDaemonRepos([...reposById.values()]),
      services: defaultRepoBinding().services,
      resolveRepoServices: (repo) => repoBindings.get(repo.repoId)?.services,
      resolveRepoAvailability: (repo) => repoAvailabilityFailure(runtime, repo),
      leaseEnforcementEnabled: (repo) => leaseEnforcementEnabled({ rootDir: repo.canonicalRoot, layoutOverrides }),
      authContext,
      ...(defaultRepoBinding().identity.identityProvider ? { identityProvider: defaultRepoBinding().identity.identityProvider } : {}),
      ...(defaultRepoBinding().identity.personRegistry ? { personRegistry: defaultRepoBinding().identity.personRegistry } : {}),
      ...(defaultRepoBinding().identity.identityAdminSnapshot ? { identityAdminSnapshot: defaultRepoBinding().identity.identityAdminSnapshot } : {}),
      appendRuntimeEvent: (input, context) => {
        const targetRepoId = context?.repo.repoId ?? defaultRepoId;
        return repoBindings.get(targetRepoId)?.appendRuntimeEvent(input) ?? Promise.resolve();
      }
    }),
    status: () => daemonStatusPayload({
      daemonId,
      rootDir: defaultRepoBinding().repo.canonicalRoot,
      repoId: defaultRepoBinding().repo.repoId,
      endpoint,
      runtimeStatus: runtime.status(),
      connections
    }),
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
        void reconcile().catch(() => undefined);
      }, 1_000);
      reconcileTimer.unref();
    },
    stop
  };

  function defaultRepoBinding(): RepoServiceBinding {
    const binding = repoBindings.get(defaultRepoId) ?? repoBindings.values().next().value;
    if (!binding) throw new Error("daemon service host has no repo bindings");
    return binding;
  }

  async function reconcileDaemonRepos(userRoot: string): Promise<void> {
    const desiredRepos = readDaemonRegistry({ userRoot }).repos.filter((repo) => repo.state === "enabled");
    if (desiredRepos.length === 0) return;
    const desiredIds = new Set(desiredRepos.map((repo) => repo.repoId));
    for (const repo of desiredRepos) {
      if (!reposById.has(repo.repoId)) {
        const namespace = { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot } satisfies DaemonRepoNamespace;
        reposById.set(repo.repoId, namespace);
      }
      if (!runtime.getRepoRuntime(repo.repoId)) {
        await runtime.attachRepo({
          repoId: repo.repoId,
          rootDir: repo.canonicalRoot,
          displayName: repo.displayName,
          ...(layoutOverrides ? { layoutOverrides } : {})
        });
      }
      if (!repoBindings.has(repo.repoId)) {
        const repoRuntime = runtime.getRepoRuntime(repo.repoId);
        if (repoRuntime) {
          repoBindings.set(repo.repoId, createRepoServiceBinding(
            reposById.get(repo.repoId)!,
            repoRuntime,
            runtime,
            layoutOverrides,
            commandOptions,
            { daemonId, endpoint, connections }
          ));
        }
      }
    }
    for (const repoId of [...reposById.keys()]) {
      if (desiredIds.has(repoId)) continue;
      repoBindings.delete(repoId);
      reposById.delete(repoId);
      if (runtime.getRepoRuntime(repoId)) await runtime.detachRepo(repoId);
    }
    await runtime.retryUnavailableRepos();
  }
}

function createRepoServiceBinding(
  repo: DaemonRepoNamespace,
  runtime: HarnessDaemonRuntime,
  managerRuntime: MultiRepoHarnessDaemonRuntime,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  commandOptions: { readonly onCommandStart: () => void; readonly onCommandSettled: () => void },
  statusOptions?: { readonly daemonId?: string; readonly endpoint?: string; readonly connections?: DaemonConnectionStats }
): {
  readonly repo: DaemonRepoNamespace;
  readonly identity: ReturnType<typeof loadDaemonIdentity>;
  readonly services: Parameters<typeof createJsonRpcProtocolServer>[0]["services"];
  readonly appendRuntimeEvent: ReturnType<typeof makeRuntimeEventAppendPromise>;
} {
  const rootDir = repo.canonicalRoot;
  const identity = loadDaemonIdentity(rootDir, layoutOverrides, statusOptions?.endpoint);
  const taskWriter = selectCliAdapterProvider("task.lifecycle").createLifecycleEngine({
    rootDir,
    layoutOverrides,
    coordinator: failClosedReservationReconcilerCoordinator()
  });
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
    }
  });
  const cliCommandService = createCliCommandService(runtime, commandOptions);
  const appendRuntimeEvent = makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({
    rootInput: { rootDir, layoutOverrides },
    coordinator: makeDaemonQueuedOperationalWriteCoordinator(runtime, "runtime-event-protocol", {
      scope: "operational",
      kind: "system",
      id: "daemon-runtime"
    })
  }));
  const taskHolderService = makeTaskHolderService({ rootInput: { rootDir, layoutOverrides }, appendLeaseEvent: appendRuntimeEvent });
  return {
    repo,
    identity,
    services: {
      LocalControllerService: localController,
      TerminalSessionService: createPtyTerminalSessionService({ workspaceRoot: rootDir }),
      TaskHolderService: taskHolderService,
      DaemonStatusService: {
        getStatus: (context) => {
          const targetRepo = context?.repo ?? repo;
          return daemonStatusPayload({
            daemonId: statusOptions?.daemonId ?? `ha-${process.pid}`,
            rootDir: targetRepo.canonicalRoot,
            repoId: targetRepo.repoId,
            endpoint: statusOptions?.endpoint ?? "repo-router",
            runtimeStatus: managerRuntime.status(),
            connections: statusOptions?.connections ?? { active: 0, total: 0 }
          });
        }
      },
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

function repoAvailabilityFailure(
  runtime: MultiRepoHarnessDaemonRuntime,
  repo: DaemonRepoNamespace
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
  if (status.state === "attached") return undefined;
  const lockHeld = typeof status.lastError === "string" && /lock already held|global\.lock/u.test(status.lastError);
  return {
    code: lockHeld ? "repo_lock_held" : "repo_unavailable",
    repo: {
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      state: status.state,
      lockPath: status.lockPath ?? null,
      lockOwnerToken: status.lockOwnerToken ?? null,
      lastError: status.lastError ?? null
    }
  };
}

function sortedDaemonRepos(repos: ReadonlyArray<DaemonRepoNamespace>): ReadonlyArray<DaemonRepoNamespace> {
  return [...repos].sort((left, right) => left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot));
}

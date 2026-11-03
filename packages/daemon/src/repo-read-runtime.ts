import {
  isDomainStatus,
  timestamp,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskProjectionQueries,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { makeDaemonProjectionReader, makeTaskEventReader } from "@harness-anything/storage";
import { readObservedRuntimeSession } from "./agent-runtime-read.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { readRuntimeSessionActivityEvidence } from "./dispatch-read.ts";
import { makeEntityActionCatalogExecutor, type EntityActionCatalogRuntimes } from "./entity-action-catalog-executor.ts";
import { readEntityLocator } from "./entity-locator-read.ts";
import { readEdgeDocWorkspace } from "./fleet-edge-doc-read.ts";
import type { FleetMirrorView } from "./fleet-edge-mirror.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { readReplicaHealth } from "./fleet/replica-health.ts";
import { readObserveEventTail } from "./observe-tail.ts";
import { makePersonActionRuntime } from "./person-action-runtime.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";
import type { RepositoryReadFrame } from "./protocol/repository-read-frame.ts";
import {
  createRepoCellActionContext,
  type RepoCellOperationalContext,
  type RepoCellRuntimeContext,
} from "./repo-cell-action-context.ts";
import { executeRepoReadAction } from "./repo-cell-action-dispatch.ts";
import { createRepoCellApi, repoCellSynchronousRead, type RepoCellApiContext } from "./repo-cell-api.ts";
import { bindVerifiedExecutorClaim } from "./repo-cell-authorization.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import { taskShowFromProjection } from "./repo-cell-completion.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { makeRepoCellSettingsState } from "./repo-cell-settings-state.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import type { RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { repoCellTaskQueryJudgmentsFor } from "./repo-cell.ts";
import { readRepoInFlightWork } from "./repo-in-flight-work.ts";
import { repositoryRuntimeReads } from "./repository-runtime-reads.ts";
import { readEdgeViewBlob } from "./runtime-result-read.ts";
import { makeScheduleActionRuntime } from "./schedule-action-runtime.ts";
import { scheduleOccurrenceSettlementOwner } from "./schedule-runtime-outcome.ts";
import { makeSettingsActionRuntime } from "./settings-action-runtime.ts";
import { makeAgentActionRuntime, makeSquadActionRuntime } from "./squad-action-runtime.ts";
import { explainAuthenticationRequired } from "./task-action-explanation-read.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";

/** Query-only runtime. Created exclusively inside the bounded reader workers. */
export function makeRepoReadRuntime(
  input: Pick<
    RepoCellOpenInput,
    "repoId" | "rootDir" | "storage" | "mode" | "authoredBranch" | "now" | "runtimeInstances"
  >,
) {
  let ledgerReader: ReturnType<typeof makeTaskEventReader> | null = null;
  const reader = makeDaemonProjectionReader({
      repoId: input.repoId,
      rootDir: input.rootDir,
      storage: input.storage,
      ...(input.now ? { now: input.now } : {}),
    }),
    ledgerOptions = {
      repoId: input.repoId,
      rootDir: input.rootDir,
      authoredBranch: input.authoredBranch,
      storage: input.storage,
    },
    // 一个惰性创建的长连接只读读者:WAL 模式下只读连接上每条语句自成一个读事务,
    // 已能看到最新提交,读最新数据不需要每次重开连接。全部读共用同一个 store
    // 引用,entity fold 的 WeakMap<CanonicalEventStore,…> 缓存才会命中(逐请求
    // 新 store 让它永远 miss)。打开失败不缓存,下次读重试。
    ledgerReadStore = () => (ledgerReader ??= makeTaskEventReader(ledgerOptions)),
    // Read runtimes hold the store but open it on first use, so a read that never touches the
    // ledger does not depend on one existing (an edge whose own ledger is not attached).
    lazyLedgerStore = new Proxy({} as ReturnType<typeof makeTaskEventReader>, {
      get: (_target, property) => {
        const store = ledgerReadStore(),
          value: unknown = Reflect.get(store, property, store);
        return typeof value === "function" ? value.bind(store) : value;
      },
    }),
    readSession = (runtimeSessionId: string) =>
      reader.withSession((projection) => readObservedRuntimeSession(projection, input.rootDir, runtimeSessionId));
  let closed = false;
  const latched = () => "Query-only reader cannot start writer work.";
  const edgeConfig = () => (input.mode === "remote-edge" ? readFleetEdgeConfig(input.rootDir) : null);
  /**
   * An edge-replica read on an edge is answered from the materialized replica of the center cut, under the
   * replica owner's authorization, and reports where the answer came from (dec_FB7DE6338E7D3D94ED2A4C05A2).
   */
  const edgeViews = new WeakMap<TaskProjectionQueries, FleetMirrorView>();
  const edgeReplicaRead = <T>(
    binding: RepoCellBinding | undefined,
    read: (projection: TaskProjectionQueries, frame: RepositoryReadFrame, view: FleetMirrorView) => T,
  ): T => {
    if (closed) throw cellCodedError("repo_unavailable", "RepoCell is closed.");
    const config = edgeConfig();
    if (!config) throw cellCodedError("replica_unavailable", "This edge has no Fleet replica configuration.");
    return withEdgeReadModel(
      {
        viewRoot: config.viewRoot,
        repoId: input.repoId,
        nodeId: config.nodeId,
        principalId: binding?.actor.principal.personId,
        ...(config.maxAgeMs === undefined ? {} : { maxAgeMs: config.maxAgeMs }),
        ...(config.maxLagRevisions === undefined ? {} : { maxLagRevisions: config.maxLagRevisions }),
      },
      (projection, frame, view) => {
        edgeViews.set(projection, view);
        const health = readReplicaHealth(view.viewDir),
          failure = health.modelFailure ?? health.syncFailure,
          framed =
            failure === null
              ? frame
              : {
                  ...frame,
                  warning: [frame.warning, `${failure.code}: ${failure.message}`].filter(Boolean).join(" · "),
                };
        return read(projection, framed, view);
      },
    );
  };
  const edgeReplicaRun = (action: RepoTaskAction, binding: RepoCellBinding) =>
    edgeReplicaRead(binding, (projection, frame, view) => {
      const stamp = (receipt: WriteReceiptDraft): WriteReceiptDraft => ({
        ...receipt,
        cut: { repoId: input.repoId, ...frame.cut, opId: receipt.opId },
        freshness: frame.freshness,
        ...(frame.warning === null ? {} : { warnings: [...(receipt.warnings ?? []), frame.warning] }),
      });
      if (action.kind === "doc-status" || action.kind === "doc-dry-run")
        return readRuntime(projection).actionContext.withHumanSummary(
          stamp(readEdgeDocWorkspace(input.rootDir, view, projection, action)),
        ) as Awaited<ReturnType<RepoCell["run"]>>;
      return executeReadAtCut(projection, action, binding, stamp);
    });
  const query = <T>(read: (projection: TaskProjectionQueries) => T): T => {
    if (closed) throw cellCodedError("repo_unavailable", "RepoCell reader is closed.");
    return reader.withSession(read);
  };
  let cachedRuntime:
    | {
        readonly projection: TaskProjectionQueries;
        readonly api: ReturnType<typeof createRepoCellApi>;
        readonly actionContext: RepoCellOperationalContext;
      }
    | undefined;
  type ReadRuntime = NonNullable<typeof cachedRuntime>;
  const readRuntime = (projection: TaskProjectionQueries): ReadRuntime => {
    if (cachedRuntime?.projection === projection) return cachedRuntime;
    const writableProjection = projection as TaskProjection,
      edgeView = edgeViews.get(projection),
      readStore = edgeView
        ? new Proxy({} as ReturnType<typeof makeTaskEventReader>, {
            get: (_target, property) => {
              if (property === "currentCut")
                return () => ({ repoId: input.repoId, revision: edgeView.revision, headDigest: edgeView.headDigest });
              if (property === "readContentBlob") return (sha256: string) => readEdgeViewBlob(edgeView, sha256);
              throw cellCodedError(
                "replica_unavailable",
                `Replica query requires unmaterialized canonical store operation ${String(property)}.`,
              );
            },
          })
        : lazyLedgerStore,
      unsupportedWrite = (): never => {
        throw cellCodedError("repo_unavailable", "A query-only RepoCell reader cannot start writer work.");
      };
    let actionRuntimes: EntityActionCatalogRuntimes = Object.freeze({}),
      knownTaskIds: Set<string> | null = null;
    const squadCoordinator = {
        hydrate: unsupportedWrite,
        retentionProtectedDispatchIds: unsupportedWrite,
        cancelRejectedChildren: unsupportedWrite,
        start: unsupportedWrite,
        startScheduled: unsupportedWrite,
        cancel: unsupportedWrite,
        reconcile: unsupportedWrite,
        flushPublications: unsupportedWrite,
        observeOutcome: unsupportedWrite,
      },
      runtimeReads = repositoryRuntimeReads(writableProjection, readStore, input.now, input.rootDir, false),
      now = input.now ?? (() => new Date().toISOString());
    const runtimeSpawner: RepoCellRuntimeContext["runtimeSpawner"] = {
        prepareWorktree: unsupportedWrite,
        spawn: unsupportedWrite,
        spawnHandoff: unsupportedWrite,
        spawnCoordinated: unsupportedWrite,
        spawnScheduled: unsupportedWrite,
        spawnScheduledCoordinated: unsupportedWrite,
        adopt: unsupportedWrite,
        cancel: unsupportedWrite,
        steer: unsupportedWrite,
        close: unsupportedWrite,
      },
      actionContext = createRepoCellActionContext({
        input: {
          repoId: input.repoId,
          ...(input.runtimeInstances ? { runtimeInstances: input.runtimeInstances } : {}),
        },
        rootDir: input.rootDir,
        now,
        publicPublication: unsupportedWrite,
        getProjection: () => writableProjection,
        getStore: () => readStore,
        getEntityActionExecutor: () => entityActionExecutor,
        getEntityActionRuntimes: () => actionRuntimes,
        getService: unsupportedWrite,
        getSettings: () => settings.read(),
        getRecovery: unsupportedWrite,
        getRecoveryUncertain: () => false,
        setRecoveryUncertain: unsupportedWrite,
        getKnownTaskIds: () => knownTaskIds,
        setKnownTaskIds: (value) => {
          knownTaskIds = value;
        },
        getSquadCoordinator: () => squadCoordinator,
      }),
      runtimeContext = Object.assign(actionContext, {
        mode: input.mode ?? "local",
        runtimeSpawner,
      }),
      settings = makeRepoCellSettingsState(actionContext),
      entityActionExecutor = makeEntityActionCatalogExecutor({
        rootDir: input.rootDir,
        repositoryId: input.repoId,
        store: readStore,
        projection: writableProjection,
        now,
        sessionIdentity: unsupportedWrite,
        readSettings: () => settings.readRepository(),
      }),
      operationalContext = Object.assign(runtimeContext, {
        settings,
        settleRuntimeExecutionLease: unsupportedWrite,
      });
    operationalContext satisfies RepoCellOperationalContext;
    actionRuntimes = Object.freeze({
      entity: Object.freeze({
        agent: makeAgentActionRuntime(runtimeContext),
        schedule: makeScheduleActionRuntime(runtimeContext, () => settings.read().worktree),
        settings: makeSettingsActionRuntime(runtimeContext, settings),
        person: makePersonActionRuntime(runtimeContext),
        squad: makeSquadActionRuntime(runtimeContext),
      }),
    });
    const context = {
        extracted: operationalContext,
        mode: input.mode ?? "local",
        input: {
          repoId: input.repoId,
          ...(input.runtimeInstances ? { runtimeInstances: input.runtimeInstances } : {}),
        },
        state: "attached",
        rootDir: input.rootDir,
        store: readStore,
        projection: writableProjection,
        now,
        settings,
        squadCoordinator,
        runtimeReads,
        dispatchRead,
        requiredCellText,
        cellCodedError,
        latched,
      } as unknown as RepoCellApiContext,
      api = createRepoCellApi(context);
    Object.assign(operationalContext, {
      showTask: (taskId: string) => taskShowFromProjection(input.rootDir, writableProjection, taskId),
    });
    return (cachedRuntime = { projection, api, actionContext: operationalContext });
  };
  const readAtCut = <M extends Parameters<RepoCell["read"]>[0]>(
    projection: TaskProjectionQueries,
    method: M,
    payload: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
  ): Awaited<ReturnType<RepoCell["read"]>> => {
    // The store, action runtimes, coordinator, and API are worker-owned long-lived readers.
    // The query-only SQLite session still scopes each synchronous read to one completed cut.
    return readRuntime(projection).api[repoCellSynchronousRead](method, payload, binding) as Awaited<
      ReturnType<RepoCell["read"]>
    >;
  };
  const executeReadAtCut = (
    projection: TaskProjectionQueries,
    action: RepoTaskAction,
    binding: RepoCellBinding,
    frame: (receipt: WriteReceiptDraft) => WriteReceiptDraft = (receipt) => receipt,
  ): Awaited<ReturnType<RepoCell["run"]>> => {
    const context = readRuntime(projection).actionContext,
      receipt = executeRepoReadAction(context, action, binding);
    if (receipt instanceof Promise)
      throw new Error(`Query-only action ${action.kind} must complete inside its synchronous read session.`);
    return context.withHumanSummary(frame(receipt)) as Awaited<ReturnType<RepoCell["run"]>>;
  };
  const runReadAtCut = (projection: TaskProjectionQueries, action: RepoTaskAction, binding: RepoCellBinding) => {
    const verified = bindVerifiedExecutorClaim({
      action,
      binding,
      projection,
      now: readRuntime(projection).actionContext.now(),
    });
    return executeReadAtCut(projection, verified.action, verified.binding);
  };
  const run = (action: RepoTaskAction, binding: RepoCellBinding) => {
    if (
      input.mode === "remote-edge" &&
      commandDescriptorForAction(action.kind).admission["remote-edge"] === "edge-replica"
    )
      return edgeReplicaRun(action, binding);
    return query((projection) => runReadAtCut(projection, action, binding));
  };
  return {
    run,
    readSession,
    readSettlementSession: (runtimeSessionId: string) =>
      reader.withSession((projection) => {
        const canonical = projection.readRuntimeSession(runtimeSessionId);
        if (!canonical || canonical.outcome !== null) return canonical;
        const observed = readObservedRuntimeSession(projection, input.rootDir, runtimeSessionId);
        // Local terminal evidence precedes canonical publication. It supplies liveness/grace,
        // while only the canonical outcome can release an orchestration waiter immediately.
        return {
          ...observed!,
          outcome: null,
          exitCode: canonical.exitCode,
          resultRef: canonical.resultRef,
          reasonCode: canonical.reasonCode,
        };
      }),
    canAttach: (session: NonNullable<ReturnType<typeof readSession>>) =>
      session.liveness !== "exited" &&
      query((projection) => {
        const dispatch = projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
        return Boolean(
          dispatch &&
            readRuntimeSessionActivityEvidence(input.rootDir, dispatch.payload.dispatchId)?.workerHostAlive === true &&
            projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach"),
        );
      }),
    explainBasis: (payload: Readonly<Record<string, unknown>>, binding?: RepoCellBinding) => {
      const read = (projection: TaskProjectionQueries) => ({
        revision: projection.readCut().sourceRevision,
        binding: bindVerifiedExecutorClaim({
          action: { kind: "entity-action-explain", executor: payload.executor },
          binding: binding ?? explainAuthenticationRequired(),
          projection,
          now: readRuntime(projection).actionContext.now(),
        }).binding,
      });
      return input.mode === "remote-edge" ? edgeReplicaRead(binding, read) : query(read);
    },
    read: <M extends Parameters<RepoCell["read"]>[0]>(
      method: M,
      payload: Readonly<Record<string, unknown>> = {},
      binding?: RepoCellBinding,
      revision?: number,
    ): Awaited<ReturnType<RepoCell["read"]>> => {
      if (method === "repo.entity.locator.read")
        return readEntityLocator({
          rootDir: input.rootDir,
          locatorKind: requiredCellText(payload.locatorKind, "locatorKind"),
          locatorValue: requiredCellText(payload.locatorValue, "locatorValue"),
        }) as never;
      const checkRevision = (projection: TaskProjectionQueries) => {
        if (revision !== undefined && projection.readCut().sourceRevision !== revision)
          throw cellCodedError(
            "projection_pending",
            "Repository cut changed while resolving live action permissions; retry the explanation.",
          );
      };
      if (input.mode === "remote-edge" && method !== "repo.agent.skills.list")
        return edgeReplicaRead(binding, (projection, frame) => {
          checkRevision(projection);
          return { ...readAtCut(projection, method, payload, binding), ...frame };
        }) as never;
      if (method === "repo.tasks.list")
        return query((projection) =>
          makeTaskQueryReadModel({
            rootDir: input.rootDir,
            projection: projection as TaskProjection,
            readPinnedEntities: projection.listPinnedEntities,
            judgments: repoCellTaskQueryJudgmentsFor(projection),
          }).guiTasks(taskListQuery(payload)),
        ) as never;
      return query((projection) => {
        checkRevision(projection);
        return readAtCut(projection, method, payload, binding);
      }) as never;
    },
    readEventWitness: (revision: number) => query((projection) => projection.readEventWitness(revision)),
    readNodeAutoClaimAssignments: (binding?: RepoCellBinding) => {
      const readAssignments = (projection: TaskProjectionQueries) => {
        const graph = readAtCut(
          projection,
          "repo.triadic.relationGraph",
          { facet: "edges", relationType: "assigned-to", state: "active", limit: 500 },
          binding,
        ) as { readonly edges: readonly import("./repo-cell-types.ts").RepoCellAutoClaimRelation[] };
        return graph.edges.map((relation) => ({
          relation,
          assignedByPersonId:
            relation.workspaceRevision === null
              ? null
              : (projection.readEventWitness(relation.workspaceRevision)?.actor.principal.personId ?? null),
        }));
      };
      return input.mode === "remote-edge"
        ? edgeReplicaRead(binding, (projection) => readAssignments(projection))
        : query(readAssignments);
    },
    observeTail: (
      payload: Parameters<RepoCell["observeTail"]>[0],
      _daemon: Parameters<RepoCell["observeTail"]>[1],
      binding?: RepoCellBinding,
    ) => {
      if (input.mode === "remote-edge" && (payload as { kind?: string })?.kind === "events")
        return Promise.resolve(
          edgeReplicaRead(binding, (projection, frame) => ({
            ...readObserveEventTail({
              repoId: input.repoId,
              rootDir: input.rootDir,
              mode: "remote-edge",
              projection: projection as TaskProjection,
              payload,
            }),
            ...frame,
          })),
        );
      return Promise.resolve(
        query((projection) =>
          readObserveEventTail({
            repoId: input.repoId,
            rootDir: input.rootDir,
            mode: input.mode ?? "local",
            projection: projection as TaskProjection,
            payload,
          }),
        ),
      );
    },
    scheduleOccurrenceSettlementOwner: (dispatchId: string | undefined) =>
      query((projection) => scheduleOccurrenceSettlementOwner(projection, dispatchId)),
    inFlightWork: (queueDepth: number) =>
      query((projection) => readRepoInFlightWork({ projection, repoId: input.repoId, queueDepth })),
    close: async () => {
      closed = true;
      reader.close();
      await ledgerReader?.drain();
      ledgerReader = null;
    },
  };
}
function taskListQuery(payload: Readonly<Record<string, unknown>>): TaskProjectionListQuery {
  const status = typeof payload.status === "string" ? payload.status : undefined,
    changedAfterRevision =
      payload.changedAfterRevision === undefined ? undefined : Number(payload.changedAfterRevision),
    updatedAfter = typeof payload.updatedAfter === "string" ? payload.updatedAfter : undefined,
    updatedBefore = typeof payload.updatedBefore === "string" ? payload.updatedBefore : undefined,
    limit = payload.limit === undefined ? undefined : Number(payload.limit),
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
  if (!(status === undefined || isDomainStatus(status)))
    throw cellCodedError("invalid_command", "Query status is invalid for this read.");
  if (changedAfterRevision !== undefined && (!Number.isSafeInteger(changedAfterRevision) || changedAfterRevision < 0))
    throw cellCodedError("invalid_command", "Task changedAfterRevision must be a non-negative integer.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    throw cellCodedError("invalid_command", "Query limit must be an integer between 1 and 500.");
  if (
    [updatedAfter, updatedBefore].some((value) => value !== undefined && !timestamp(value)) ||
    (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
  )
    throw cellCodedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
  if (cursor !== undefined && !cursor) throw cellCodedError("invalid_command", "Query cursor is invalid.");
  return {
    ...(status ? { status: status as TaskProjectionListQuery["status"] } : {}),
    ...(changedAfterRevision === undefined ? {} : { changedAfterRevision }),
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedBefore ? { updatedBefore } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
  };
}

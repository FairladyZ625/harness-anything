import { readFileSync } from "node:fs";
import { readEdgeCiDetail, fetchEdgeCiDetails } from "./ci-detail-cache.ts";
import { repositoryRuntimeReads } from "./repository-runtime-reads.ts";
import { readEntityLocator } from "./entity-locator-read.ts";
import { readEdgeDocWorkspace } from "./fleet-edge-doc-read.ts";
import type { FleetMirrorView } from "./fleet-edge-mirror.ts";
import type { RepositoryReadFrame } from "./protocol/repository-read-frame.ts";
import { readEdgeViewBlob } from "./runtime-result-read.ts";
import path from "node:path";
import {
  consumeKnownError,
  makeTaskEventReader,
  makeTaskProjectionReader,
  isDomainStatus,
  timestamp,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskProjectionQueries,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { ledgerWriteCommandTopology } from "@harness-anything/preset/internal/preset-command-contract";
import { readObservedRuntimeSession } from "./agent-runtime-read.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { taskShowFromProjection } from "./repo-cell-completion.ts";
import { readRuntimeSessionActivityEvidence } from "./dispatch-read.ts";
import { openReplicaCutWorker } from "./fleet/replica-cut-worker.ts";
import { centerEdgeReadModel } from "./fleet/replica-read-model.ts";
import { readObserveEventTail, readObserveTail } from "./observe-tail.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { causeClassOf } from "./repo-cell-lock.ts";
import {
  createRepoCellActionContext,
  type RepoCellOperationalContext,
  type RepoCellRuntimeContext,
} from "./repo-cell-action-context.ts";
import { createRepoCellApi, repoCellSynchronousRead, type RepoCellApiContext } from "./repo-cell-api.ts";
import {
  explainAuthenticationRequired,
  preparePersonActionExplanationBinding,
} from "./task-action-explanation-read.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import { executeRepoReadAction } from "./repo-cell-action-dispatch.ts";
import { bindVerifiedExecutorClaim } from "./repo-cell-authorization.ts";
import { makeEntityActionCatalogExecutor, type EntityActionCatalogRuntimes } from "./entity-action-catalog-executor.ts";
import { makeAgentActionRuntime, makeSquadActionRuntime } from "./squad-action-runtime.ts";
import { makeScheduleActionRuntime } from "./schedule-action-runtime.ts";
import { makeSettingsActionRuntime } from "./settings-action-runtime.ts";
import { makePersonActionRuntime } from "./person-action-runtime.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { operationId } from "./repo-cell-proof.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { failed, requiredCellText } from "./repo-cell-settlement.ts";
import { readRepoInFlightWork } from "./repo-in-flight-work.ts";
import { makeRepoCellSettingsState } from "./repo-cell-settings-state.ts";
import type { RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { repoCellTaskQueryJudgmentsFor } from "./repo-cell.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
import { openWriterSupervisor } from "./writer-supervisor.ts";
import { runtimeOutcomeSettled, runtimeSettlementGraceMs } from "./runtime-settlement.ts";
import { commandDescriptorForAction, repoCellExecutionForAction } from "./protocol/daemon-protocol-commands.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";
import { workspaceScopeFromProjection } from "./workspace-scope-read.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";

const writerAttached = (cell: { readonly state: string }): boolean => cell.state === "attached";
const projectionReady = (read: { readonly status: string }): boolean => read.status === "ready";
const validTaskStatusFilter = (value: string | undefined): boolean => value === undefined || isDomainStatus(value);

/** Host-side RepoCell boundary: admission/proxy plus completed-cut projection reads only. */
export async function openRepoCellProxy(
  input: RepoCellOpenInput & { readonly onStatus?: (status: ReturnType<RepoCell["status"]>) => void },
): Promise<RepoCell> {
  const lock = await acquireWorkspaceLock(input.rootDir);
  let relayRuntimeSignal: NonNullable<RepoCellOpenInput["onRuntimeSignal"]> = () => undefined;
  // Orchestration waiters (runtime batch, agent create, sessions.await) park on these sets; an exit
  // signal or outcome notification re-checks the domain settle predicate. Activity and heartbeat
  // signals change no settle input, and waking every parked wait for each provider frame turned the
  // host thread into a re-read loop proportional to provider output times parked waits.
  const outcomeWaiters = new Map<string, Set<() => void>>(),
    signalWaiters = new Set<() => void>(),
    pokeSignalWaiters = (): void => {
      const waiters = [...signalWaiters];
      signalWaiters.clear();
      for (const waiter of waiters) waiter();
    },
    pokeOutcomeWaiters = (runtimeSessionId: string | undefined): void => {
      pokeSignalWaiters();
      if (typeof runtimeSessionId !== "string") return;
      const waiters = [...(outcomeWaiters.get(runtimeSessionId) ?? [])];
      outcomeWaiters.delete(runtimeSessionId);
      for (const waiter of waiters) waiter();
    };
  let wakeReplica = (): void => undefined;
  const edgeConfig = input.mode === "remote-edge" ? readFleetEdgeConfig(input.rootDir) : null;
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>>;
  try {
    supervisor = await openWriterSupervisor(
      {
        ...input,
        onRuntimeOutcome: (event) => {
          pokeOutcomeWaiters(event.payload.runtimeSessionId);
          input.onRuntimeOutcome?.(event);
        },
        onRuntimeSignal: (runtimeSessionId, signal) => {
          relayRuntimeSignal(runtimeSessionId, signal);
          if (signal.type === "exit") pokeOutcomeWaiters(runtimeSessionId);
          input.onRuntimeSignal?.(runtimeSessionId, signal);
        },
      },
      {
        onAttachStatus: input.onStatus,
        onPublishedStatus: (status) => {
          wakeReplica();
          input.onStatus?.(status);
        },
      },
    );
  } catch (error) {
    // An edge answers replica reads even when its own runtime ledger cannot attach; its writer
    // state reports that failure, and every write rejects with it.
    if (edgeConfig === null) {
      await lock.close();
      throw error;
    }
    consumeKnownError(error);
    const lastError = error instanceof Error ? error.message : String(error),
      rejectWrite = async (): Promise<never> => {
        throw cellCodedError("repo_unavailable", lastError);
      };
    supervisor = {
      status: () => ({
        repoId: input.repoId,
        rootDir: input.rootDir,
        mode: "remote-edge",
        state: "unavailable",
        generation: null,
        queueDepth: null,
        recoveryMs: null,
        materialization: null,
        lastError,
        causeClass: causeClassOf(error),
      }),
      request: rejectWrite,
      control: rejectWrite,
      bootstrapReceipt: () => undefined,
      close: async () => undefined,
    };
  }
  let ledgerReader: ReturnType<typeof makeTaskEventReader> | null = null;
  const reader = makeTaskProjectionReader({ rootDir: input.rootDir, ...(input.now ? { now: input.now } : {}) }),
    ledgerOptions = { repoId: input.repoId, rootDir: input.rootDir, authoredBranch: input.authoredBranch },
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
    readCurrentLedger = <T>(read: (store: ReturnType<typeof makeTaskEventReader>) => T): T => read(ledgerReadStore()),
    replica = openReplicaCutWorker(
      {
        repoId: input.repoId,
        localRoot: path.dirname(path.dirname(reader.path)),
        readBasis: (afterRevision) => reader.withSession((projection) => projection.readReplicaBasis(afterRevision)),
        // Fleet replication follows the acknowledged writer cut, including the durable
        // ledger suffix that may not have reached Git yet. This reader is immutable; the
        // RepoWriterCell remains the only accepting writer.
        readLedgerCut: () => readCurrentLedger((store) => store.currentCut()),
        readContentBlob: (sha256) => readCurrentLedger((store) => store.readContentBlob(sha256)),
        readEvent: (opId) => readCurrentLedger((store) => store.readEvent(opId)),
        readApplied: (opId) => reader.withSession((projection) => projection.readOperation(opId)),
        readEdgeReadModel: () => reader.withSession((projection) => centerEdgeReadModel(projection)),
      },
      { ...ledgerOptions, localRoot: path.dirname(path.dirname(reader.path)) },
    ),
    readSession = (runtimeSessionId: string) =>
      reader.withSession((projection) => readObservedRuntimeSession(projection, input.rootDir, runtimeSessionId)),
    runtime = makeAgentRuntimeStreamHub({
      readSession,
      canAttach: (session) =>
        session.liveness !== "exited" &&
        reader.withSession((projection) => {
          const dispatch = projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
          return dispatch
            ? readRuntimeSessionActivityEvidence(input.rootDir, dispatch.payload.dispatchId)?.workerHostAlive === true
            : false;
        }) &&
        reader.withSession((projection) =>
          Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")),
        ),
      ...(input.now ? { now: () => new Date(input.now!()) } : {}),
    }),
    terminalHost = openTerminalHost({
      repoId: input.repoId,
      rootDir: input.rootDir,
      daemonGeneration: supervisor.status().generation ?? Date.now() * 1_000 + (process.pid % 1_000),
      ...(input.now ? { now: input.now } : {}),
    });
  wakeReplica = () => replica.kick();
  relayRuntimeSignal = runtime.publish;
  let closed = false;

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
    if (!edgeConfig) throw cellCodedError("replica_unavailable", "This edge has no Fleet replica configuration.");
    return withEdgeReadModel(
      {
        viewRoot: edgeConfig.viewRoot,
        repoId: input.repoId,
        nodeId: edgeConfig.nodeId,
        principalId: binding?.actor.principal.personId,
        ...(edgeConfig.maxAgeMs === undefined ? {} : { maxAgeMs: edgeConfig.maxAgeMs }),
        ...(edgeConfig.maxLagRevisions === undefined ? {} : { maxLagRevisions: edgeConfig.maxLagRevisions }),
      },
      (projection, frame, view) => {
        edgeViews.set(projection, view);
        return read(projection, frame, view);
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
      if (action.kind === "event-show")
        throw cellCodedError(
          "replica_unavailable",
          `${action.kind} requires canonical event or acceptance history, which this replica does not publish.`,
        );
      if (action.kind === "doc-status" || action.kind === "doc-dry-run")
        return readRuntime(projection).actionContext.withHumanSummary(
          stamp(readEdgeDocWorkspace(input.rootDir, view, projection, action)),
        ) as Awaited<ReturnType<RepoCell["run"]>>;
      return executeReadAtCut(projection, action, binding, stamp);
    });
  const query = <T>(read: (projection: TaskProjectionQueries) => T): T => {
    if (closed) throw cellCodedError("repo_unavailable", "RepoCell is closed.");
    const status = supervisor.status();
    if (!writerAttached(status) && !(status.state === "unavailable" && status.projectionReadable === true))
      throw cellCodedError("repo_unavailable", status.lastError ?? "RepoWriterCell is not ready.");
    // A write latch does not revoke a verified generation's completed cut. Reads never repair it.
    return reader.withSession(read);
  };
  const latched = (): string => {
    const status = supervisor.status(),
      cause = status.lastError ?? "RepoCell is unavailable.";
    return status.causeClass === "infrastructure"
      ? [
          "this workspace stays latched until its Git or lock infrastructure recovers:",
          "repair the infrastructure cause below, then rerun the command; the next attempt re-probes the workspace",
          `and re-attaches automatically once it verifies. Cause: ${cause}`,
        ].join(" ")
      : status.causeClass === "projection"
        ? [
            "this workspace stays latched until its projection verifies:",
            "run ha daemon projection rebuild to repair the projection cause below; this command remains available",
            `while latched and re-attaches automatically once the projection verifies. Cause: ${cause}`,
          ].join(" ")
        : [
            "this workspace stays latched until its ledger data verifies:",
            "repair the data-shape cause below, then rerun the command; the next attempt re-probes the ledger",
            `and re-attaches automatically once the data verifies. Cause: ${cause}`,
          ].join(" ");
  };
  let hostReadRuntime:
    | {
        readonly projection: TaskProjectionQueries;
        readonly api: ReturnType<typeof createRepoCellApi>;
        readonly actionContext: RepoCellOperationalContext;
      }
    | undefined;
  type HostReadRuntime = NonNullable<typeof hostReadRuntime>;
  const readRuntime = (projection: TaskProjectionQueries): HostReadRuntime => {
    if (hostReadRuntime?.projection === projection) return hostReadRuntime;
    const writableProjection = projection as TaskProjection,
      edgeView = edgeViews.get(projection),
      readStore = edgeView
        ? new Proxy({} as ReturnType<typeof makeTaskEventReader>, {
            get: (_target, property) => {
              if (property === "currentCut")
                return () => ({ repoId: input.repoId, revision: edgeView.revision, headDigest: edgeView.headDigest });
              if (property === "readContentBlob")
                return (sha256: string) =>
                  [...edgeView.entries.values()].some((row) => row.sha256 === sha256)
                    ? readEdgeViewBlob(edgeConfig!.viewRoot, edgeView, sha256)
                    : readEdgeCiDetail(edgeConfig!.viewRoot, edgeView, sha256);
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
        start: unsupportedWrite,
        cancel: unsupportedWrite,
        reconcile: unsupportedWrite,
        flushPublications: unsupportedWrite,
        observeOutcome: unsupportedWrite,
      },
      runtimeReads = repositoryRuntimeReads(writableProjection, readStore, input.now),
      now = input.now ?? (() => new Date().toISOString());
    const runtimeSpawner: RepoCellRuntimeContext["runtimeSpawner"] = {
        prepareWorktree: unsupportedWrite,
        spawn: unsupportedWrite,
        spawnHandoff: unsupportedWrite,
        spawnCoordinated: unsupportedWrite,
        spawnScheduled: unsupportedWrite,
        adopt: unsupportedWrite,
        cancel: unsupportedWrite,
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
        schedule: makeScheduleActionRuntime(runtimeContext, () => settings.read().worktree.setup),
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
    return (hostReadRuntime = { projection, api, actionContext: operationalContext });
  };
  const readAtCut = <M extends Parameters<RepoCell["read"]>[0]>(
    projection: TaskProjectionQueries,
    method: M,
    payload: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
  ): Awaited<ReturnType<RepoCell["read"]>> => {
    // The store, action runtimes, coordinator, and API are host-owned long-lived readers.
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
  const run: RepoCell["run"] = async (action, binding, signal) => {
    if (closed)
      return {
        outcome: "op_rejected",
        opId: operationId(action, binding, input.repoId, 0),
        code: "repo_unavailable",
      } as never;
    if (input.mode === "remote-edge" && action.kind === "receipt-show")
      return failed(
        operationId(action, binding, input.repoId, 0),
        cellCodedError(
          "replica_unavailable",
          "Canonical acceptance and follower progress belong to the center writer, not this edge runtime ledger.",
        ),
      ) as Awaited<ReturnType<RepoCell["run"]>>;
    if (repoCellExecutionForAction(action.kind) === "query-only") {
      try {
        if (
          input.mode === "remote-edge" &&
          commandDescriptorForAction(action.kind).admission["remote-edge"] === "edge-replica"
        ) {
          return edgeReplicaRun(action, binding);
        }
        return query((projection) => runReadAtCut(projection, action, binding));
      } catch (error) {
        return failed(operationId(action, binding, input.repoId, 0), error) as Awaited<ReturnType<RepoCell["run"]>>;
      }
    }
    // Writes must yield once so a close started in the same turn wins admission.
    // Host-owned projection reads do not need that scheduling boundary.
    await Promise.resolve();
    if (closed)
      return {
        outcome: "op_rejected",
        opId: "closed",
        code: "repo_unavailable",
      } as never;
    return supervisor.request("run", { action }, binding, signal);
  };
  const admitTerminalWrite = (binding: RepoCellBinding): void => {
    const admission = admitRepoMode(input.mode ?? "local", ledgerWriteCommandTopology, binding.source);
    if (!admission.ok) throw cellCodedError(admission.code, admission.nextAction);
    if (closed || supervisor.status().state !== "attached")
      throw cellCodedError("repo_unavailable", "RepoWriterCell is unavailable.");
  };
  const terminal: RepoCell["terminal"] = {
    list: terminalHost.list,
    attach: terminalHost.attach,
    detach: terminalHost.detach,
    close: terminalHost.close,
    spawn: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawn(payload);
    },
    spawnTrusted: (launch, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawnTrusted(launch);
    },
    input: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.input(payload);
    },
    resize: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.resize(payload);
    },
    terminate: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.terminate(payload);
    },
  };
  return {
    hasBuiltinExecutor: (claimFence) => supervisor.request("hasBuiltinExecutor", { claimFence }),
    get bootstrapReceipt() {
      return supervisor.bootstrapReceipt() as RepoCell["bootstrapReceipt"];
    },
    run,
    presetRun: (action, binding) => supervisor.request("presetRun", { action }, binding),
    spawnRuntime: (payload, binding) => supervisor.request("spawnRuntime", payload, binding),
    handoffRuntime: (payload, binding) => supervisor.request("handoffRuntime", payload, binding),
    cancelRuntime: (payload, binding) => supervisor.request("cancelRuntime", payload, binding),
    runtimeIngress: (action, binding) => supervisor.request("runtimeIngress", { action }, binding),
    catalog: {
      snapshot: () => supervisor.request("catalog", { method: "snapshot", args: [] }),
      preset: (payload) => supervisor.request("catalog", { method: "preset", args: [payload] }),
      reread: (payload) => supervisor.request("catalog", { method: "reread", args: [payload] }),
    },
    terminal,
    read: async (method, payload = {}, binding) => {
      if (method === "repo.entity.locator.read")
        return readEntityLocator({
          rootDir: input.rootDir,
          locatorKind: requiredCellText(payload.locatorKind, "locatorKind"),
          locatorValue: requiredCellText(payload.locatorValue, "locatorValue"),
        }) as never;
      if (method === "repo.entity.actions.explain") {
        const session = <T>(read: (projection: TaskProjectionQueries, frame?: RepositoryReadFrame) => T): T =>
          input.mode === "remote-edge" ? edgeReplicaRead(binding, read) : query(read);
        const at = session((projection) => ({
          revision: projection.readCut().sourceRevision,
          binding: bindVerifiedExecutorClaim({
            action: { kind: "entity-action-explain", executor: payload.executor },
            binding: binding ?? explainAuthenticationRequired(),
            projection,
            now: readRuntime(projection).actionContext.now(),
          }).binding,
        }));
        const prepared = await preparePersonActionExplanationBinding(
          {
            revision: at.revision,
            repoId: input.repoId,
            now: () => input.now?.() ?? new Date().toISOString(),
            binding: at.binding,
          },
          payload,
        );
        return session((projection, frame) => {
          if (projection.readCut().sourceRevision !== at.revision)
            throw cellCodedError(
              "projection_pending",
              "Repository cut changed while resolving live action permissions; retry the explanation.",
            );
          return { ...readAtCut(projection, method, payload, prepared), ...frame };
        }) as never;
      }
      if (input.mode === "remote-edge" && method === "repo.ci.observatory.read" && payload.fetchDetails === true) {
        const selected = edgeReplicaRead(binding, (projection) => ({
          view: edgeViews.get(projection)!,
          answer: readAtCut(projection, method, payload, binding) as unknown as { missingDetails: readonly string[] },
        }));
        const config = edgeConfig!;
        await fetchEdgeCiDetails({
          peer: {
            hostname: config.host,
            port: config.port,
            ca: readFileSync(config.caPath),
            ...(config.servername ? { servername: config.servername } : {}),
            nodeId: config.nodeId,
            credential: config.credential,
            repoId: config.repoId,
          },
          viewRoot: config.viewRoot,
          view: selected.view,
          eventIds: selected.answer.missingDetails.filter(
            (ref) => !["inventory:", "artifact:", "unavailable:"].some((prefix) => ref.startsWith(prefix)),
          ),
          quotaBytes: config.quotaBytes,
        });
        return edgeReplicaRead(binding, (projection, frame, view) => {
          if (view.revision !== selected.view.revision || view.headDigest !== selected.view.headDigest)
            throw cellCodedError("projection_pending", "CI observation cut changed while fetching details.");
          return { ...readAtCut(projection, method, payload, binding), ...frame };
        }) as never;
      }
      if (input.mode === "remote-edge" && method !== "repo.agent.skills.list")
        return edgeReplicaRead(binding, (projection, frame) => {
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
      return query((projection) => readAtCut(projection, method, payload, binding)) as never;
    },
    workspaceSummary: () => query((projection) => workspaceSummaryFromProjection(projection as never)),
    workspaceScope: (payload) => query((projection) => workspaceScopeFromProjection(projection as never, payload)),
    observeTail: (payload, daemon, binding) => {
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
      if (payload !== null && typeof payload === "object" && (payload as { kind?: unknown }).kind === "events")
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
      return readObserveTail({
        repoId: input.repoId,
        rootDir: input.rootDir,
        mode: input.mode ?? "local",
        projection: {} as TaskProjection,
        userRoot: daemon.userRoot,
        daemonId: daemon.daemonId,
        payload,
      });
    },
    replica,
    verifyReadiness: async () => {
      const status = supervisor.status();
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
      const read = query((projection) => projection.readCut());
      if (!projectionReady(read)) throw cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" } as const;
    },
    attach: async (runtimeSessionId, afterCursor) => {
      const status = supervisor.status();
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
      return runtime.attach(runtimeSessionId, afterCursor);
    },
    awaitRuntimeOutcome: async (runtimeSessionId) => {
      const now = input.now ?? (() => new Date().toISOString());
      while (!runtimeOutcomeSettled(readSession(runtimeSessionId), now())) {
        await new Promise<void>((resolve) => {
          const waiter = () => {
            waiters.delete(waiter);
            clearTimeout(timer);
            resolve();
          };
          // The settle predicate is also time-based (post-exit grace), so a missed signal cannot
          // park a waiter forever; each wake re-reads the projection and either returns or rearms.
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            resolve();
          }, runtimeSettlementGraceMs);
          timer.unref?.();
          const waiters = outcomeWaiters.get(runtimeSessionId) ?? new Set<() => void>();
          waiters.add(waiter);
          outcomeWaiters.set(runtimeSessionId, waiters);
        });
      }
    },
    awaitRuntimeSignal: async () => {
      await new Promise<void>((resolve) => {
        const waiter = () => {
          signalWaiters.delete(waiter);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signalWaiters.delete(waiter);
          resolve();
        }, runtimeSettlementGraceMs);
        timer.unref?.();
        signalWaiters.add(waiter);
      });
    },
    runtime,
    status: supervisor.status,
    statusCuts: () => {
      if (closed || supervisor.status().state !== "attached") return null;
      return {
        projectionWatermark: reader.withSession((projection) => projection.readCut().watermark),
        ledgerRevision: readCurrentLedger((store) => store.readHead()?.revision ?? 0),
      };
    },
    inFlightWork: () =>
      query((projection) =>
        readRepoInFlightWork({
          projection,
          repoId: input.repoId,
          queueDepth: supervisor.status().queueDepth ?? 0,
        }),
      ),
    settlePendingMaterialization: (context) => supervisor.request("settlePendingMaterialization", context),
    backup: (request) => supervisor.request("backup", request),
    close: async () => {
      if (closed) return;
      closed = true;
      runtime.close();
      await terminal.close();
      try {
        await supervisor.close();
      } finally {
        replica.close();
        reader.close();
        // A replaced center can still answer receipts after close; its next read reopens.
        // The drain is awaited like the writer drain above it: a caller that removes the
        // repository after cell close must not race the reader's still-open ledger handle.
        await ledgerReader?.drain();
        ledgerReader = null;
        await lock.close();
      }
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
  if (!validTaskStatusFilter(status)) throw cellCodedError("invalid_command", "Query status is invalid for this read.");
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

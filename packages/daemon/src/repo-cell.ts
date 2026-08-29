import path from "node:path";
import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import {
  blockingOf,
  closeoutReadiness,
  makeTaskEventStore,
  makeTaskProjection,
  type ActorIdentity,
  type DaemonRepoMode,
  type DocSyncReceiptDetail,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatches } from "./dispatch-read.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { blockedCandidateNextAction } from "./doc-sync-details.ts";
import { makeEntityActionCatalogExecutor } from "./entity-action-catalog-executor.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import { withDerivedCommandClass } from "./repo-cell-role-bindings.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { TaskQueryJudgments } from "./task-query-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";

export { causeClassOf, latchReprobeThrottleMs } from "./repo-cell-lock.ts";
export { openRepoCell } from "./repo-cell-open.ts";
export type {
  RepoCell,
  RepoCellBinding,
  RepoCellReadMethod,
  RepoCellStatus,
  RepoTaskAction,
  RuntimeIngressAction,
} from "./repo-cell-types.ts";

export const repoCellTaskQueryJudgments: TaskQueryJudgments = {
  closeout: (snapshot, availability) => closeoutReadiness(snapshot, availability),
  blocking: (tasks, relations, state) => blockingOf(tasks, relations, state),
};

export interface RepoCellCoreInput {
  readonly input: {
    readonly repoId: string;
    readonly killpoint?: Parameters<typeof makeTaskEventStore>[0]["killpoint"];
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  };
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly activeWriterEpochGuard: (() => void) | null;
  readonly activeWriterEpochFence: (<T>(operation: () => T) => T) | null;
  readonly mode: DaemonRepoMode;
  readonly now: () => string;
  readonly runtimeStream: AgentRuntimeStreamHub;
}

export interface RepoCellCore {
  readonly store: ReturnType<typeof makeTaskEventStore>;
  readonly recovery: ReturnType<ReturnType<typeof makeTaskEventStore>["recover"]>;
  readonly projection: ReturnType<typeof makeTaskProjection>;
  readonly entityActionExecutor: ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly runtimeReads: ReturnType<typeof makeAgentRuntimeReadModel>;
  readonly service: ReturnType<typeof makeTaskLifecycleService>;
  readonly replica: ReturnType<typeof openReplicaCutSource>;
}

export function initializeRepoCell(context: RepoCellCoreInput): RepoCellCore {
  let projection: ReturnType<typeof makeTaskProjection> | null = null;
  let pendingSettlementActor: ActorIdentity | null = null;
  const settleAuthoredCandidates = (actor: ActorIdentity): void => {
    const currentProjection = projection;
    if (currentProjection === null) {
      pendingSettlementActor = actor;
      return;
    }
    const binding = withDerivedCommandClass({ actor, source: "local" }, "repo-write");
    void runDocAction({
      action: { kind: "doc-submit", paths: [] },
      binding,
      workspaceId: context.input.repoId,
      rootDir: context.rootDir,
      store,
      projection: currentProjection,
      now: context.now,
      killpoint: context.input.killpoint,
    })
      .then((receipt) => {
        const detail = receipt.detail?.kind === "doc_sync" ? receipt.detail : undefined,
          warning = blockedAuthoredCandidateWarning(detail);
        if (warning) console.warn(warning);
      })
      .catch((error) => {
        console.warn(
          `[wal-materializer] authored doc scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const store = makeTaskEventStore({
      repoId: context.input.repoId,
      rootDir: context.rootDir,
      authoredBranch: context.authoredBranch,
      killpoint: context.input.killpoint,
      afterFlush: settleAuthoredCandidates,
      beforeAppend: () => context.activeWriterEpochGuard?.(),
      withAppendFence: (operation) =>
        context.activeWriterEpochFence ? context.activeWriterEpochFence(operation) : operation(),
      rejectPreparedRecovery: context.mode === "remote-center",
    }),
    recovery = store.recover();
  projection = makeTaskProjection({ rootDir: context.rootDir, eventStore: store, now: context.now });
  if (pendingSettlementActor) settleAuthoredCandidates(pendingSettlementActor);
  const currentSessionIdentity = (binding: RepoCellBinding) => resolveWriteSessionIdentity(binding, projection!);
  const entityActionExecutor = makeEntityActionCatalogExecutor({
    store,
    projection,
    now: context.now,
    sessionIdentity: currentSessionIdentity,
    killpoint: context.input.killpoint,
  });
  const runtimeReads = makeAgentRuntimeReadModel({
      readAttemptChain: (runtimeSessionId) => readRuntimeAttemptChain(context.rootDir, runtimeSessionId),
      readDispatch: (taskId, dispatchId) =>
        readTaskDispatches({ rootDir: context.rootDir, projection, taskId }).dispatches.find(
          (row) => row.dispatchId === dispatchId,
        ) ?? null,
      readDispatches: ({ sessions, events }) =>
        readSessionGroupDispatches({ rootDir: context.rootDir, sessions, events }),
      projection,
      store,
      stream: context.runtimeStream,
      runtimeInstances: context.input.runtimeInstances ?? (() => []),
      now: context.now,
    }),
    service = makeTaskLifecycleService({
      eventStore: store,
      projection,
      killpoint: context.input.killpoint,
    }),
    replica = openReplicaCutSource({
      repoId: context.input.repoId,
      localRoot: path.dirname(path.dirname(projection.path)),
      readBasis: projection.readReplicaBasis,
      readLedgerCut: store.currentCut,
      readContentBlob: store.readContentBlob,
      readEvent: store.readEvent,
      readApplied: projection.readOperation,
    });
  return {
    store,
    recovery,
    projection,
    entityActionExecutor,
    runtimeReads,
    service,
    replica,
  };
}

export function blockedAuthoredCandidateWarning(detail: DocSyncReceiptDetail | undefined): string | null {
  const unresolved = detail?.unresolvedTouches[0],
    deletion = detail?.deletions[0],
    nextAction = unresolved ? blockedCandidateNextAction(unresolved) : deletion ? detail.nextAction : null;
  return nextAction === null ? null : `[wal-materializer] authored doc candidate blocked; ${nextAction}`;
}

export function chainRepoCellWrite<T>(tail: Promise<void>, work: () => T | PromiseLike<T>): Promise<T> {
  return tail.then(work);
}

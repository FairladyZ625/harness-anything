import path from "node:path";
import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import { blockingOf, closeoutReadiness, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readSessionGroupDispatches, readTaskDispatches } from "./dispatch-read.ts";
import { localRepairBinding } from "./daemon-host-binding.ts";
import { makeDecisionActions } from "./decision-actions.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { makeFactActions } from "./fact-actions.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { TaskQueryJudgments } from "./task-query-read.ts";

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

export function initializeRepoCell(context: any): any {
  let projection: ReturnType<typeof makeTaskProjection> | null = null;
  let settlementPending = false;
  const settleAuthoredCandidates = (): void => {
    const currentProjection = projection;
    if (currentProjection === null) {
      settlementPending = true;
      return;
    }
    void runDocAction({
      action: { kind: "doc-submit", paths: [] },
      binding: localRepairBinding,
      workspaceId: context.input.repoId,
      rootDir: context.rootDir,
      store,
      projection: currentProjection,
      now: context.now,
      killpoint: context.input.killpoint,
    })
      .then((receipt) => {
        const detail = receipt.detail?.kind === "doc_sync" ? receipt.detail : undefined,
          blocked = [
            ...(detail?.unresolvedTouches ?? []).map((touch) => `${touch.path} (${touch.requiredRoute})`),
            ...(detail?.deletions ?? []).map((deletion) => `${deletion.path} (deletion)`),
          ];
        if (blocked.length)
          console.warn(`[wal-materializer] authored doc candidates blocked; run ha doc status: ${blocked.join(", ")}`);
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
  if (settlementPending) settleAuthoredCandidates();
  const currentSessionIdentity = (binding: RepoCellBinding) => resolveWriteSessionIdentity(binding, projection!);
  const factActions = makeFactActions({
      store,
      projection,
      now: context.now,
      sessionIdentity: currentSessionIdentity,
      killpoint: context.input.killpoint,
    }),
    decisionActions = makeDecisionActions({
      store,
      projection,
      now: context.now,
      sessionIdentity: currentSessionIdentity,
      killpoint: context.input.killpoint,
    });
  const runtimeReads = makeAgentRuntimeReadModel({
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
    factActions,
    decisionActions,
    runtimeReads,
    service,
    replica,
  };
}

export function chainRepoCellWrite<T>(tail: Promise<void>, work: () => T | PromiseLike<T>): Promise<T> {
  return tail.then(work);
}

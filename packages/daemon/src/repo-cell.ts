import path from "node:path";
import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import {
  blockingOf,
  closeoutReadiness,
  configureLedgerMaintenance,
  consumeKnownError,
  activateEmptyCanonicalGeneration,
  makeTaskEventStore,
  makeTaskProjection,
  type DaemonRepoMode,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import {
  readRuntimeAttemptChain,
  readRuntimeSessionActivityEvidence,
  readSessionGroupDispatches,
  readTaskDispatches,
} from "./dispatch-read.ts";
import { makeEntityActionCatalogExecutor } from "./entity-action-catalog-executor.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { RepoCellAttachProgress, RepoCellBinding } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { TaskQueryJudgments } from "./task-query-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { type WriterEpochFenceDescriptor } from "./writer-epoch.ts";

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
    readonly onMaterializationHealthChange?: Parameters<typeof makeTaskEventStore>[0]["onMaterializationHealthChange"];
    readonly onOpenProgress?: (progress: RepoCellAttachProgress) => void;
    readonly recordLifecycle?: DaemonLifecycleRecorder;
  };
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly activeWriterEpochFence: (<T>(operation: () => T) => T) | null;
  readonly activeWriterEpochFenceDescriptor: WriterEpochFenceDescriptor | null;
  readonly mode: DaemonRepoMode;
  readonly now: () => string;
  readonly runtimeStream: AgentRuntimeStreamHub;
}

export interface RepoCellCore {
  readonly store: ReturnType<typeof makeTaskEventStore>;
  readonly recovery: {
    readonly status: "none" | "indeterminate";
    readonly elapsedMs: number;
    readonly error?: string;
    readonly errorCode?: string;
  };
  readonly projection: ReturnType<typeof makeTaskProjection>;
  readonly entityActionExecutor: ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly runtimeReads: ReturnType<typeof makeAgentRuntimeReadModel>;
  readonly service: ReturnType<typeof makeTaskLifecycleService>;
  readonly replica: ReturnType<typeof openReplicaCutSource>;
}

export async function initializeRepoCell(context: RepoCellCoreInput): Promise<RepoCellCore> {
  let projection: ReturnType<typeof makeTaskProjection> | null = null;
  configureLedgerMaintenance(context.rootDir);
  const store = makeTaskEventStore({
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    authoredBranch: context.authoredBranch,
    activationPreflight: activateEmptyCanonicalGeneration,
    killpoint: context.input.killpoint,
    onMaterializationHealthChange: context.input.onMaterializationHealthChange,
    writerFence: () => {
      const fence = context.activeWriterEpochFenceDescriptor;
      if (!fence) throw new Error("writer epoch fence is unavailable for SQLite acceptance");
      return fence;
    },
    withAppendFence: (operation) =>
      context.activeWriterEpochFence ? context.activeWriterEpochFence(operation) : operation(),
  });
  try {
    context.input.onOpenProgress?.({
      phase: "recovering",
      applied: null,
      total: null,
      watermark: null,
    });
    let recovery: RepoCellCore["recovery"] = { status: "none", elapsedMs: 0 };
    projection = makeTaskProjection({
      rootDir: context.rootDir,
      eventStore: store,
      now: context.now,
      onProgress: (progress) =>
        context.input.onOpenProgress?.({
          phase: "catching-up",
          applied: progress.applied,
          total: progress.total ?? null,
          watermark: progress.watermark,
        }),
    });
    // Attach advances one bounded, complete projection cut. Serving reads never mutates L2; future
    // writer events remain the authority and apply through the normal single-writer path.
    try {
      projection.catchUp?.();
      // Opening a reader generation is also a structural probe: a watermark can
      // be current while a persisted snapshot row is corrupt.
      projection.readTaskIndex();
    } catch (error) {
      consumeKnownError(error);
      recovery = {
        ...recovery,
        status: "indeterminate",
        error: cellErrorMessage(error),
        errorCode: cellErrorCode(error),
      };
    }
    context.input.onOpenProgress?.({
      phase: "opening",
      applied: null,
      total: null,
      watermark: null,
    });
    const currentSessionIdentity = (binding: RepoCellBinding) => resolveWriteSessionIdentity(binding, projection!);
    const entityActionExecutor = makeEntityActionCatalogExecutor({
      rootDir: context.rootDir,
      repositoryId: context.input.repoId,
      store,
      projection,
      now: context.now,
      sessionIdentity: currentSessionIdentity,
      killpoint: context.input.killpoint,
    });
    const runtimeReads = makeAgentRuntimeReadModel({
        readActivityEvidence: (dispatchId) => readRuntimeSessionActivityEvidence(context.rootDir, dispatchId),
        readAttemptChain: (runtimeSessionId) => readRuntimeAttemptChain(context.rootDir, runtimeSessionId),
        readDispatch: (taskId, dispatchId) =>
          readTaskDispatches({ rootDir: context.rootDir, projection: projection!, taskId }).dispatches.find(
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
  } catch (error) {
    projection?.close();
    try {
      await store.drain();
    } catch (cleanupError) {
      consumeKnownError(cleanupError);
    }
    throw error;
  }
}

export function chainRepoCellWrite<T>(tail: Promise<void>, work: () => T | PromiseLike<T>): Promise<T> {
  // One event-loop turn between serialized writes, so timers and I/O are not starved by a write backlog.
  return tail.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(work);
}

import { readRuntimeAttemptChain } from "./runtime-attempt-read.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { makeTaskLifecycleService } from "@harness-anything/application/internal/task-lifecycle-service";
import {
  prepareDaemonRepoStorage,
  activateEmptyCanonicalGeneration,
  applyAttachMigrations,
  makeTaskEventStore,
  makeTaskProjection,
  ProjectionIdentityMismatchError,
} from "@harness-anything/storage";
import {
  blockingOf,
  closeoutReadiness,
  consumeKnownError,
  type DaemonRepoMode,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readSessionGroupDispatches, readTaskDispatchSession } from "./dispatch-read.ts";
import { makeEntityActionCatalogExecutor } from "./entity-action-catalog-executor.ts";
import { cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";
import { readEffectiveCloseoutGates, readRepositorySettings } from "./repo-cell-settings-state.ts";
import { readCompletionDeliveryStatus } from "./task-completion-read.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type {
  RepoCellAttachProgress,
  RepoCellBinding,
  RepoCellQueueObservation,
  RepoCellWriteQueueEntry,
  RepoCellWriteQueueHead,
  RepoCellWriteQueueLabel,
  RepoCellWriteQueueState,
} from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { TaskQueryJudgments } from "./task-query-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { type WriterEpochFenceDescriptor } from "@harness-anything/storage";

export { causeClassOf, latchReprobeThrottleMs } from "./repo-cell-lock.ts";
export type {
  RepoCell,
  RepoCellBinding,
  RepoCellReadMethod,
  RepoCellStatus,
  RepoTaskAction,
  RuntimeIngressAction,
} from "./repo-cell-types.ts";

/** Cold attach replays content-heavy historical events. Committing projection cuts in batches of
 * this size lets the supervisor observe advancing watermarks during reconstruction, before ready. */
const coldAttachCatchUpLimit = 32;

/**
/** Read judgments bound to one projection cut: the closeout verdict follows the effective gate set. */
export function repoCellTaskQueryJudgmentsFor(projection: TaskProjectionQueries): TaskQueryJudgments {
  return {
    closeout: (snapshot, availability, _gates, _delivery, rootDir) =>
      closeoutReadiness(
        snapshot,
        availability,
        readEffectiveCloseoutGates(projection, snapshot),
        readCompletionDeliveryStatus(projection, snapshot, rootDir),
      ),
    blocking: (tasks, relations, state) => blockingOf(tasks, relations, state),
  };
}

export interface RepoCellCoreInput {
  readonly input: {
    readonly repoId: string;
    readonly storage?: import("./repo-cell-open.ts").RepoCellOpenInput["storage"];
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
    readonly status: OperationalStatus.RepoRecoveryStatus;
    readonly elapsedMs: number;
    readonly error?: string;
    readonly errorCode?: string;
  };
  readonly projection: ReturnType<typeof makeTaskProjection>;
  readonly entityActionExecutor: ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly runtimeReads: ReturnType<typeof makeAgentRuntimeReadModel>;
  readonly service: ReturnType<typeof makeTaskLifecycleService>;
  readonly replica: import("./repo-cell-types.ts").ReplicaCutSource;
}

export async function initializeRepoCell(context: RepoCellCoreInput): Promise<RepoCellCore> {
  let projection: ReturnType<typeof makeTaskProjection> | null = null;
  prepareDaemonRepoStorage({
    rootDir: context.rootDir,
    repoId: context.input.repoId,
    mode: context.mode,
    storage: context.input.storage,
  });
  let openProgressSequence = 0;
  context.input.onOpenProgress?.({
    phase: "recovering",
    applied: null,
    total: null,
    watermark: null,
  });
  const store = makeTaskEventStore({
    storage: context.input.storage,
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    authoredBranch: context.authoredBranch,
    activationPreflight: activateEmptyCanonicalGeneration,
    killpoint: context.input.killpoint,
    onMaterializationHealthChange: context.input.onMaterializationHealthChange,
    onOpenProgress: (progress) =>
      context.input.onOpenProgress?.({
        phase: "recovering",
        applied: ++openProgressSequence,
        total: progress.total,
        watermark: null,
      }),
    writerFence: () => {
      const fence = context.activeWriterEpochFenceDescriptor;
      if (!fence) throw new Error("writer epoch fence is unavailable for SQLite acceptance");
      return fence;
    },
    withAppendFence: (operation) =>
      context.activeWriterEpochFence ? context.activeWriterEpochFence(operation) : operation(),
  });
  const migrationProgressOffset = openProgressSequence;
  let attachRecoveryProgress = migrationProgressOffset;
  try {
    // Historical shape upgrades are accepted through the same fenced writer as every other
    // canonical event. Projection opening is deliberately after this step so a cold rebuild
    // never observes an unregistered retired field.
    if (context.mode !== "remote-edge")
      applyAttachMigrations({
        store,
        now: context.now,
        onProgress: (progress) => {
          attachRecoveryProgress = migrationProgressOffset + progress.applied;
          context.input.onOpenProgress?.({
            phase: "recovering",
            applied: attachRecoveryProgress,
            total: migrationProgressOffset + progress.total,
            watermark: null,
          });
        },
      });
    let recovery: RepoCellCore["recovery"] = { status: "none", elapsedMs: 0 };
    projection = makeTaskProjection({
      storage: context.input.storage,
      rootDir: context.rootDir,
      eventStore: store,
      now: context.now,
      catchUpLimit: coldAttachCatchUpLimit,
      onValidationProgress: (progress) =>
        context.input.onOpenProgress?.({
          phase: "recovering",
          applied: attachRecoveryProgress + progress.applied,
          total: attachRecoveryProgress + progress.total,
          watermark: null,
        }),
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
      // Cold attach can replay a large canonical ledger. Yield between bounded batches so the
      // transport can continue serving protocol/status requests while the projection warms.
      if (projection.catchUpAsync) await projection.catchUpAsync();
      else projection.catchUp?.();
      // Opening a reader generation is also a structural probe: a watermark can
      // be current while a persisted snapshot row is corrupt.
      projection.readTaskIndex({ limit: 1 });
    } catch (error) {
      consumeKnownError(error);
      if (error instanceof ProjectionIdentityMismatchError) {
        // A cache pinning another ledger's digest at this ledger's own revision is discardable
        // damage whose reads fail closed until an explicit rebuild (a restored snapshot produces
        // it). Attach performs that rebuild so the repository opens healed instead of stranded on
        // a repair command the latched cell could never reach.
        projection.rebuild();
        projection.readTaskIndex({ limit: 1 });
      } else {
        recovery = {
          ...recovery,
          status: "indeterminate",
          error: cellErrorMessage(error),
          errorCode: cellErrorCode(error),
        };
      }
    }
    // Projection is ready; runtime adoption is the next attach stage. Keep this boundary monotonic
    // so the worker heartbeat remains valid while the first adoption publication is pending.
    context.input.onOpenProgress?.({
      phase: "restoring-runtimes",
      applied: 0,
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
      readSettings: () => readRepositorySettings(projection!),
      killpoint: context.input.killpoint,
    });
    const runtimeReads = makeAgentRuntimeReadModel({
        readAttemptChain: (runtimeSessionId) => readRuntimeAttemptChain(runtimeSessionId, projection!),
        readDispatch: (taskId, dispatchId) => readTaskDispatchSession(projection!, taskId, dispatchId),
        readDispatches: ({ sessions, events, shallow }) =>
          readSessionGroupDispatches({ sessions, events, projection: projection!, ...(shallow ? { shallow } : {}) }),
        projection,
        store,
        rootDir: context.rootDir,
        now: context.now,
      }),
      service = makeTaskLifecycleService({
        eventStore: store,
        projection,
        killpoint: context.input.killpoint,
      }),
      replica = { kick: () => undefined, close: () => undefined, ledgerCut: store.currentCut };
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

export function chainRepoCellWrite<T>(
  tail: Promise<void>,
  work: () => T | PromiseLike<T>,
  options?: {
    readonly queue: RepoCellWriteQueueState;
    readonly label: RepoCellWriteQueueLabel;
    readonly observation?: RepoCellQueueObservation;
  },
): Promise<T> {
  const entry: RepoCellWriteQueueEntry | null =
    options === undefined ? null : { label: options.label, appendedAtMs: options.queue.nowMs() };
  // Capture before pushing this turn: the head then is the write blocking this one. Pushing at append
  // time (not at start) keeps a burst queued in one tick attributable to the turn ahead of it.
  if (entry !== null && options?.observation !== undefined && options.observation.head === undefined)
    options.observation.head = captureRepoCellWriteQueueHead(options.queue);
  if (entry !== null && options !== undefined) options.queue.waiting.push(entry);
  // One event-loop turn between serialized writes, so timers and I/O are not starved by a write backlog.
  const turn = tail.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  return turn.then(() => {
    if (options === undefined || entry === null) return work();
    entry.startedAtMs = options.queue.nowMs();
    // A synchronous throw would skip the finally and leave a settled turn as the head forever.
    try {
      return Promise.resolve(work()).finally(() => remove(entry, options.queue));
    } catch (error) {
      remove(entry, options.queue);
      throw error;
    }
  });
}

function remove(entry: RepoCellWriteQueueEntry, queue: RepoCellWriteQueueState): void {
  const index = queue.waiting.indexOf(entry);
  if (index >= 0) queue.waiting.splice(index, 1);
}

/** The oldest appended turn and how long it has run, or null when the queue is idle. */
export function captureRepoCellWriteQueueHead(queue: RepoCellWriteQueueState): RepoCellWriteQueueHead | null {
  const head = queue.waiting[0];
  if (head === undefined) return null;
  return {
    requestId: head.label.requestId,
    command: head.label.command,
    executingMs: head.startedAtMs === undefined ? 0 : Math.max(0, Math.round(queue.nowMs() - head.startedAtMs)),
  };
}

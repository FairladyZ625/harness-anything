import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import {
  blockingOf,
  closeoutReadiness,
  configureLedgerMaintenance,
  consumeKnownError,
  makeTaskEventStore,
  makeGitEventStore,
  makeTaskProjection,
  localGitWorktreeSettlement,
  readSettingsFacet,
  resolveLedgerGitLayout,
  resolveHarnessLayout,
  runWalMaterializationRequest,
  type ActorIdentity,
  type DaemonRepoMode,
  type DocSyncReceiptDetail,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatches } from "./dispatch-read.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { blockedCandidateNextAction } from "./doc-sync-details.ts";
import { scanAuthoredCandidateInventory, type AuthoredCandidateInventoryV1 } from "./doc-sync-candidate-scanner.ts";
import { makeEntityActionCatalogExecutor } from "./entity-action-catalog-executor.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";
import type { RepoCellAttachProgress, RepoCellBinding } from "./repo-cell-types.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { TaskQueryJudgments } from "./task-query-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { withWriterEpochFenceDescriptor, type WriterEpochFenceDescriptor } from "./writer-epoch.ts";

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
    readonly walMaterializationTestFault?: Parameters<typeof makeTaskEventStore>[0]["walMaterializationTestFault"];
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
    readonly onStoreOpened?: (store: ReturnType<typeof makeTaskEventStore>) => void;
    readonly onMaterializationHealthChange?: Parameters<typeof makeTaskEventStore>[0]["onMaterializationHealthChange"];
    readonly onOpenProgress?: (progress: RepoCellAttachProgress) => void;
  };
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly activeWriterEpochGuard: (() => void) | null;
  readonly activeWriterEpochFence: (<T>(operation: () => T) => T) | null;
  readonly activeWriterEpochFenceDescriptor: WriterEpochFenceDescriptor | null;
  readonly mode: DaemonRepoMode;
  readonly now: () => string;
  readonly runtimeStream: AgentRuntimeStreamHub;
  readonly enqueueAfterFlush: (work: () => Promise<void>) => Promise<void>;
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

export async function initializeRepoCell(context: RepoCellCoreInput): Promise<RepoCellCore> {
  let projection: ReturnType<typeof makeTaskProjection> | null = null;
  let pendingSettlement: { readonly actor: ActorIdentity; readonly inventory: unknown | null } | null = null;
  const settleAuthoredCandidates = (actor: ActorIdentity, inventory: unknown | null): Promise<void> => {
    const currentProjection = projection;
    if (currentProjection === null) {
      pendingSettlement = { actor, inventory };
      return Promise.resolve();
    }
    return context.enqueueAfterFlush(async () => {
      const action = { kind: "doc-submit", paths: [] } as const,
        revision = store.readHead()?.revision ?? 0,
        roleBindings = declaredRoleBindingsForActor(context.rootDir, actor),
        baseBinding: RepoCellBinding = {
          actor,
          source: "local",
          ...(roleBindings === undefined
            ? { authorizationBindingMode: "default" }
            : { authorizationBindingMode: "declared", roleBindings }),
        },
        authorizationDecision = authorizeRepoCellAction({
          action,
          binding: baseBinding,
          actionId: `doc-materializer:${revision}`,
          revision,
          now: context.now(),
        });
      if (authorizationDecision.outcome === "denied") {
        console.warn(`[wal-materializer] document effect denied: ${authorizationDecision.reasonCodes.join(", ")}`);
        return;
      }
      const receipt = await runDocAction({
        action,
        binding: { ...baseBinding, authorizationDecision },
        workspaceId: context.input.repoId,
        rootDir: context.rootDir,
        store,
        projection: currentProjection,
        now: context.now,
        killpoint: context.input.killpoint,
        ...(isAuthoredCandidateInventory(inventory) ? { authoredCandidateInventory: inventory } : {}),
      });
      const detail = receipt.detail?.kind === "doc_sync" ? receipt.detail : undefined,
        warning = blockedAuthoredCandidateWarning(detail);
      if (warning) console.warn(warning);
    });
  };
  const configPath = path.join(resolveHarnessLayout(context.rootDir).authoredRoot, "harness.yaml");
  configureLedgerMaintenance(context.rootDir);
  const store = makeTaskEventStore({
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    authoredBranch: context.authoredBranch,
    killpoint: context.input.killpoint,
    afterFlush: settleAuthoredCandidates,
    onMaterializationHealthChange: context.input.onMaterializationHealthChange,
    walMaterialize: (config, request) => {
      const response = runWalMaterializationRequest(config, request, {
        withFinalizeFence: (fence, operation) => withWriterEpochFenceDescriptor(fence, operation),
      });
      if (response.outcome !== "materialized" || response.settlementIntent === null) return response;
      try {
        const materialized = makeGitEventStore({
            repoId: config.repoId,
            rootDir: config.rootDir,
            ...(config.authoredBranch ? { authoredBranch: config.authoredBranch } : {}),
          }),
          inventory = scanAuthoredCandidateInventory({ rootDir: config.rootDir, store: materialized }),
          ledger = resolveLedgerGitLayout(config.rootDir),
          fingerprint = localGitWorktreeSettlement.changesFingerprint(ledger.rootDir, ledger.authoredPrefix || ".");
        return {
          ...response,
          settlementIntent:
            fingerprint === response.settlementFingerprint ? { ...response.settlementIntent, inventory } : null,
        };
      } catch (error) {
        console.warn(
          "[wal-materializer] authored candidate inventory failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
        consumeKnownError(error);
        return { ...response, settlementIntent: null };
      }
    },
    walMaterializationTestFault: context.input.walMaterializationTestFault,
    walMaterializationFence: () => context.activeWriterEpochFenceDescriptor,
    beforeAppend: () => context.activeWriterEpochGuard?.(),
    withAppendFence: (operation) =>
      context.activeWriterEpochFence ? context.activeWriterEpochFence(operation) : operation(),
    rejectPreparedRecovery: context.mode === "remote-center",
    walFlushPolicy: () => readSettingsFacet(existsSync(configPath) ? readFileSync(configPath, "utf8") : "").walFlush,
  });
  try {
    context.input.onStoreOpened?.(store);
    context.input.onOpenProgress?.({
      phase: "recovering",
      applied: null,
      total: null,
      watermark: null,
    });
    let recovery = store.recover();
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
    const deferredSettlement = pendingSettlement as {
      readonly actor: ActorIdentity;
      readonly inventory: unknown | null;
    } | null;
    if (deferredSettlement) void settleAuthoredCandidates(deferredSettlement.actor, deferredSettlement.inventory);
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

function isAuthoredCandidateInventory(value: unknown): value is AuthoredCandidateInventoryV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { readonly schema?: unknown }).schema === "harness-authored-candidate-inventory/v1" &&
    Array.isArray((value as { readonly rows?: unknown }).rows)
  );
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

import path from "node:path";
import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { makeDecisionActions } from "./decision-actions.ts";
import { makeFactActions } from "./fact-actions.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

export function initializeRepoCell(context: any): any {
  const store = makeTaskEventStore({
      repoId: context.input.repoId,
      rootDir: context.rootDir,
      authoredBranch: context.authoredBranch,
      killpoint: context.input.killpoint,
      beforeAppend: () => context.activeWriterEpochGuard?.(),
      withAppendFence: (operation) =>
        context.activeWriterEpochFence ? context.activeWriterEpochFence(operation) : operation(),
      rejectPreparedRecovery: context.mode === "remote-center",
    }),
    recovery = store.recover(),
    projection = makeTaskProjection({ rootDir: context.rootDir, eventStore: store, now: context.now }),
    currentSessionIdentity = (binding: RepoCellBinding) => resolveWriteSessionIdentity(binding, projection);
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
      projection,
      store,
      stream: context.runtimeStream,
      runtimeInstances: context.input.runtimeInstances ?? (() => []),
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

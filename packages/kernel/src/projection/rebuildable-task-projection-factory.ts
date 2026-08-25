// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  serializeCanonicalEvent,
} from "../domain/doc-sync.contract.ts";
import type { FrozenWritePlan } from "../domain/write-chain.contract.ts";
import { assertMigrationImportWritePlan } from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
} from "../domain/ledger-layout-migration-event.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { assertEntityUpsertWritePlan, isEntityEvent } from "../domain/entity-event.ts";
import { assertTaskBootstrapWritePlan, isTaskBootstrapEvent } from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import {
  assertPresetSnapshotUpgradeWritePlan,
  isPresetSnapshotUpgradeEvent,
} from "../domain/preset-snapshot-upgrade-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { TaskProjection } from "./task-projection-port.ts";
import type { EventStreamPort, ProjectionContext } from "./rebuildable-task-projection-types.ts";
import {
  closeDatabase,
  ProjectionIdentityMismatchError,
  resetDatabase,
  withDatabase,
} from "./rebuildable-task-projection-database.ts";
import { reduceBatch } from "./rebuildable-task-projection-catch-up.ts";
import { listProjection, readProjection, rebuildProjection } from "./rebuildable-task-projection-reads.ts";
import { knowledgeQueryApi } from "./rebuildable-task-projection-knowledge-queries.ts";
import { entityQueryApi } from "./rebuildable-task-projection-entity-api.ts";
import { runtimeLeaseApi } from "./rebuildable-task-projection-runtime-api.ts";
import { taskQueryApi } from "./rebuildable-task-projection-task-queries.ts";
import { markRuntimeSessionsUnknown } from "./rebuildable-task-projection-runtime.ts";
import { readStateDigest, refreshStateDigestAtSourceCut, transaction } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

// Public projection construction and local source-head handling.
export function defaultLifecycleTaskProjectionPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".harness/cache/task.sqlite");
}
export function makeTaskProjection(options: {
  readonly rootDir: string;
  readonly eventStore: EventStreamPort;
  readonly projectionPath?: string;
  readonly catchUpLimit?: number;
  readonly now?: () => string;
}): TaskProjection {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = options.catchUpLimit ?? 4096,
    now = options.now ?? (() => new Date().toISOString()),
    sourceReadHead = options.eventStore.readHead;
  let observedSourceHead = false,
    hotAppliedHead: ReturnType<EventStreamPort["readHead"]> = null;
  // `apply` is the synchronous projection of a just-published event. A headless in-memory
  // source may not expose that event through readHead, but only this live instance may retain it.
  // Once a real source head has been seen, a later null/lower head remains a history regression.
  const readHead = () => {
    const sourceHead = sourceReadHead();
    if (sourceHead !== null) {
      observedSourceHead = true;
      return sourceHead;
    }
    return observedSourceHead ? null : hotAppliedHead;
  };
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
    throw new Error("task projection catch-up limit must be between 1 and 4096");
  if (localRuntimeStateFileSystem.exists(projectionPath)) {
    try {
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          if (markRuntimeSessionsUnknown(db) > 0) refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
        }),
      );
    } catch (error) {
      if (!(error instanceof ProjectionIdentityMismatchError)) throw error;
      if (readHead() === null) resetDatabase(projectionPath, readHead);
      else consumeKnownError(error);
    }
  }
  const closeProjection = () => {
    hotAppliedHead = null;
    closeDatabase(projectionPath, readHead);
  };
  const context: ProjectionContext = {
    projectionPath,
    readHead,
    eventStore: options.eventStore,
    limit,
    now,
  };
  return {
    path: projectionPath,
    close: closeProjection,
    apply: (event, plan) => {
      if (isDocEvent(event)) assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">);
      if (isEntityEvent(event)) assertEntityUpsertWritePlan(event, plan as FrozenWritePlan<"EntityUpsert">);
      if (
        isTaskEvent(event) &&
        ((event.payload.documentClaims?.length ?? 0) > 0 || (event.payload.carriedDocumentClaims?.length ?? 0) > 0)
      )
        assertTaskLifecycleWritePlan(event, plan);
      if (isTaskBootstrapEvent(event)) assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">);
      if (isPresetSnapshotUpgradeEvent(event))
        assertPresetSnapshotUpgradeWritePlan(event, plan as FrozenWritePlan<"PresetSnapshotUpgrade">);
      if (isTaskProgressEvent(event)) assertTaskProgressWritePlan(event, plan);
      if (isFactEvent(event)) assertFactWritePlan(event, plan);
      if (isDecisionEvent(event)) assertDecisionWritePlan(event, plan);
      if (isMigrationImportEvent(event)) assertMigrationImportWritePlan(event, plan);
      if (isLedgerLayoutMigrationEvent(event)) assertLedgerLayoutMigrationWritePlan(event, plan);
      const receipt = withDatabase(projectionPath, readHead, (db) =>
        reduceBatch(db, [event], limit, options.eventStore.readContentBlob, readHead()?.revision ?? 0),
      );
      if (!observedSourceHead)
        hotAppliedHead = {
          revision: event.workspaceRevision,
          eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}`,
        };
      return receipt;
    },
    rebuild: () => {
      hotAppliedHead = null;
      closeDatabase(projectionPath, readHead);
      return rebuildProjection(projectionPath, readHead, options.eventStore, limit);
    },
    readStateDigest: () => withDatabase(projectionPath, readHead, readStateDigest),
    read: (taskId) => readProjection(projectionPath, readHead, options.eventStore, taskId, limit, now),
    list: (query) => listProjection(projectionPath, readHead, options.eventStore, limit, now, query),
    ...entityQueryApi(context),
    ...taskQueryApi(context),
    ...knowledgeQueryApi(context),
    ...runtimeLeaseApi(context),
  };
}

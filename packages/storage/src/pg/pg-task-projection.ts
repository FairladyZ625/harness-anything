import type { TaskProjection, TaskProjectionQueries } from "@harness-anything/kernel";
import { isDecisionEvent } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { isFactEvent } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  isRelationEvent,
  embeddedRelationEventsForReplay,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { isTaskEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { assertFactAdmissionAtCut } from "@harness-anything/kernel/internal/domain/fact-admission.ts";
import { assertDecisionAdmissionAtCut } from "@harness-anything/kernel/internal/domain/decision-admission.ts";
import { createSqlTaskQueryReader } from "./sql-task-query-reader.ts";
import { PG_TASK_QUERY_METHODS } from "./pg-task-query-contract.ts";
import { projectionCatchUpLimit } from "../projection/catch-up-limit.ts";
import { derivedRelationRecordsForReplay } from "../projection/relation-entity-projection.ts";
import type {
  PostgresTaskProjectionFactoryOptions,
  PGliteTaskProjectionFactoryOptions,
} from "../projection/rebuildable-task-projection-factory.ts";

/** Acceptance materializes PG in the canonical transaction; this facade never writes a second projection. */
export function makePgTaskProjection(
  options: PostgresTaskProjectionFactoryOptions | PGliteTaskProjectionFactoryOptions,
): TaskProjection {
  const limit = projectionCatchUpLimit(options.catchUpLimit),
    now = options.now ?? (() => new Date().toISOString()),
    reader = createSqlTaskQueryReader({
      storage: options.storage,
      repoId: options.eventStore.ledgerMetadata().repoId,
      now,
    }),
    queries = Object.fromEntries(
      PG_TASK_QUERY_METHODS.map((method) => [
        method,
        (...args: unknown[]) => reader.withSession((q) => Reflect.apply(q[method], q, args)),
      ]),
    ) as unknown as TaskProjectionQueries,
    catchUpRounds = function* (): Generator<undefined, ReturnType<NonNullable<TaskProjection["catchUp"]>>> {
      for (;;) {
        if (reader.maintainRelationCycleAuditPage().done) break;
        yield;
      }
      const cut = queries.readCut();
      if (cut.status !== "ready") throw new Error(`PG projection is pending at ${cut.watermark}/${cut.sourceRevision}`);
      // A projection written before the artifact timeline existed is completed before any read
      // claims readiness; the marker makes every later catch-up a single cheap check.
      reader.backfillArtifactTimeline();
      reader.backfillDispatchLifecycle();
      const metrics = { storeTransactions: 0, reducedItems: 0, maxBatchItems: 0 };
      for (;;) {
        const page = reader.warmIndexes(limit);
        if (page.processed) {
          metrics.storeTransactions++;
          metrics.reducedItems += page.processed;
          metrics.maxBatchItems = Math.max(metrics.maxBatchItems, page.processed);
          options.onProgress?.({
            applied: metrics.reducedItems,
            total: metrics.reducedItems + page.sourceRevision - page.watermark,
            watermark: page.watermark,
          });
        }
        if (page.watermark === page.sourceRevision) return { watermark: page.watermark, metrics };
        yield;
      }
    },
    catchUp = () => {
      const rounds = catchUpRounds();
      for (;;) {
        const next = rounds.next();
        if (next.done) return next.value;
      }
    };
  return {
    ...queries,
    // A ready cut whose lifecycle model is missing (a projection from before the model, or of
    // another model version) is refolded through the same reducer, never answered empty.
    readDispatchLifecycle: (query) => {
      const read = queries.readDispatchLifecycle(query);
      if (read.status !== "pending" || read.watermark !== read.sourceRevision) return read;
      reader.backfillDispatchLifecycle();
      return queries.readDispatchLifecycle(query);
    },
    path: reader.path,
    close: reader.close,
    apply: (event) => {
      const cut = queries.readCut();
      if (cut.watermark < event.workspaceRevision) throw new Error("PG projection apply requires canonical acceptance");
      if (relationAuditAffected(event))
        for (;;) {
          if (reader.maintainRelationCycleAuditPage().done) break;
        }
      return { metrics: { storeTransactions: 1, reducedItems: 1 } };
    },
    catchUp,
    catchUpAsync: async () => {
      const rounds = catchUpRounds();
      for (;;) {
        const next = rounds.next();
        if (next.done) return next.value;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    rebuild: () => {
      reader.rebuild();
      return {
        ...catchUp(),
        stateDigest: queries.readStateDigest()!,
        relationCycleAudit: queries.readRelationCycleAudit(),
      };
    },
    reserveLease: (lease, at) => reader.changeLease("reserve", lease, at),
    activateLease: (lease) => reader.changeLease("activate", lease, now()),
    renewLease: (lease, expiresAt) => reader.changeLease("renew", lease, now(), expiresAt),
    releaseLease: (lease) => reader.changeLease("release", lease, now()),
    admitFact: (event) =>
      reader.withSession((q) => {
        const ref = "supersedes" in event.payload ? event.payload.supersedes?.factRef : undefined,
          target = ref ? q.readFact(ref.replace(/^fact\//u, "")).fact : null;
        assertFactAdmissionAtCut(
          {
            row: q.readFact(event.factId).fact,
            domainTypes: q.listFactDomainTypes().domainTypes,
            supersededTarget: target,
            relations: target ? q.readFactGraph().edges : [],
          },
          event,
        );
      }),
    admitDecision: (event) =>
      reader.withSession((q) => {
        const document = q.readDecisionDocumentState(event.decisionId),
          ref = `decision/${event.decisionId}`,
          refs =
            document && event.type === "decision_amended"
              ? [...document.chosen, ...document.rejected, ...document.claims].map(({ id }) => `${ref}/${id}`)
              : [],
          relations = refs.flatMap((anchor) => [
            ...q.readRelationQuery({ source: anchor, state: "active" }).rows,
            ...q.readRelationQuery({ target: anchor, state: "active" }).rows,
          ]);
        assertDecisionAdmissionAtCut(
          {
            document,
            relations: relations
              .filter(({ state }) => state === "active")
              .map((row) => ({ relation_id: row.relationId, source_ref: row.sourceRef, target_ref: row.targetRef })),
            hasSupersedes: q
              .readTaskRelationsByTargets([ref], "supersedes")
              .rows.some(
                (row) =>
                  row.state === "active" &&
                  row.sourceRef.startsWith("decision/") &&
                  row.sourceRef !== ref &&
                  !row.sourceRef.startsWith(`${ref}/`),
              ),
          },
          event,
        );
      }),
  };
}

function relationAuditAffected(event: Parameters<NonNullable<TaskProjection["apply"]>>[0]): boolean {
  if (isRelationEvent(event)) return true;
  if (
    (isTaskEvent(event) || isDecisionEvent(event) || isFactEvent(event)) &&
    embeddedRelationEventsForReplay(event).length
  )
    return true;
  return derivedRelationRecordsForReplay(event).length > 0;
}

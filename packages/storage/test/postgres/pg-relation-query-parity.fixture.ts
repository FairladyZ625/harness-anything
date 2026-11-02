import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

type RelationQueries = Pick<
  TaskProjectionQueries,
  | "readTaskRelations"
  | "readTaskRelationsByTargets"
  | "readTaskRelationsBySources"
  | "readEntityVersionWitness"
  | "readRelationEdge"
  | "readRelationQuery"
  | "readRelationCycleAudit"
>;
function relationContract(queries: RelationQueries) {
  const all = queries.readRelationQuery(),
    first = queries.readRelationQuery({ limit: 1 });
  assert.ok(all.rows.length > 1);
  assert.ok(first.page?.nextCursor);
  assert.equal(queries.readRelationEdge("missing"), null);
  assert.deepEqual(queries.readTaskRelationsBySources([], "depends-on").rows, []);
  assert.deepEqual(queries.readTaskRelationsByTargets([], "depends-on").rows, []);
  assert.throws(() => queries.readRelationQuery({ limit: 0 }), /limit/);
  assert.throws(() => queries.readRelationQuery({ cursor: "bad" }), /cursor/);
  assert.throws(() => queries.readTaskRelationsByTargets([""], "depends-on"), /non-empty/);
  const byEdge = all.rows.map(({ relationId }) => queries.readRelationEdge(relationId));
  const filters = all.rows
    .slice(0, 4)
    .flatMap(({ sourceRef, targetRef, relationType, ownerRef, direction, state, freshness }) => [
      queries.readRelationQuery({ source: sourceRef }),
      queries.readRelationQuery({ target: targetRef }),
      queries.readRelationQuery({ entity: sourceRef, relationType }),
      queries.readRelationQuery({ ownerRef, direction, state }),
      queries.readRelationQuery({ freshness, limit: 2 }),
      queries.readTaskRelationsBySources([sourceRef, "missing"], relationType),
      queries.readTaskRelationsByTargets([targetRef, "missing"], relationType),
    ]);
  return {
    all,
    first,
    byEdge,
    filters,
    audit: queries.readRelationCycleAudit(),
    taskOwned: queries.readTaskRelations(),
    next: queries.readRelationQuery({ limit: 1, cursor: first.page.nextCursor }),
    versions: ["task/task-parity", "decision/dec_PG_PARITY", "fact/F-11111111", "task/missing", "external:opaque"].map(
      (ref) => queries.readEntityVersionWitness(ref),
    ),
    dated: queries.readRelationQuery({
      updatedAfter: "2026-01-01T00:00:00.000Z",
      updatedBefore: "2026-12-31T23:59:59.999Z",
    }),
  };
}
export function assertRelationQueryParity(pg: PgTaskQueryMethods, sqlite: TaskProjectionQueries): void {
  assert.deepEqual(relationContract(pg), relationContract(sqlite));
}

import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

type IndexQueries = Pick<
  TaskProjectionQueries,
  | "readTaskIndex"
  | "readTaskChildCounts"
  | "readTaskStatuses"
  | "readTaskExists"
  | "readTaskByIdempotencyKey"
  | "readForTaskContractMigration"
  | "readTaskIdsForTaskContractMigration"
>;
function taskIndexContract(queries: IndexQueries) {
  assert.equal(queries.readTaskExists("task-parity"), true);
  assert.equal(queries.readTaskExists("missing"), false);
  assert.deepEqual(queries.readTaskStatuses([]).rows, []);
  assert.deepEqual(queries.readTaskChildCounts([]), {});
  assert.equal(queries.readTaskByIdempotencyKey("missing"), null);
  const idempotency = queries.readTaskByIdempotencyKey("query-idempotency-key");
  assert.equal(idempotency?.taskId, "task-graph-a");
  const first = queries.readTaskIndex({ limit: 1 });
  assert.equal(first.rows.length, 1);
  assert.ok(first.page?.nextCursor);
  const next = queries.readTaskIndex({ limit: 1, cursor: first.page.nextCursor });
  assert.notDeepEqual(
    next.rows.map(({ taskId }) => taskId),
    first.rows.map(({ taskId }) => taskId),
  );
  assert.throws(() => queries.readTaskIndex({ limit: 0 }), /limit/);
  return {
    first,
    next,
    idempotency,
    empty: queries.readTaskIndex({ taskIds: [] }),
    filtered: queries.readTaskIndex({ taskIds: ["task-parity", "missing"], presentationStatus: true }),
    statuses: queries.readTaskStatuses(),
    someStatuses: queries.readTaskStatuses(["task-parity", "missing"]),
    children: queries.readTaskChildCounts(queries.readTaskIdsForTaskContractMigration()),
    raw: queries.readForTaskContractMigration("task-parity"),
    missingRaw: queries.readForTaskContractMigration("missing"),
    ids: queries.readTaskIdsForTaskContractMigration(),
  };
}
export function assertTaskIndexQueryParity(pg: PgTaskQueryMethods, sqlite: TaskProjectionQueries): void {
  assert.deepEqual(taskIndexContract(pg), taskIndexContract(sqlite));
}

import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { deriveRelationId } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { taskCreated } from "../store/relation-graph-projection.fixtures.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";

export async function appendGraphQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  for (const id of ["task-graph-a", "task-graph-b", "task-graph-c"]) {
    const created = taskCreated(revision(), id);
    if (created.type !== "task_created") throw new Error("task creation fixture is invalid");
    const event = {
      ...created,
      payload: {
        ...created.payload,
        task: {
          ...created.payload.task,
          metadata: {
            idempotencyKey: id === "task-graph-a" ? "query-idempotency-key" : null,
            parentTaskId: null,
            workKind: "test" as const,
            riskTier: "low" as const,
            urgency: null,
            verticalId: "software/coding",
            presetId: "standard-task",
            profileId: "baseline",
            moduleKey: null,
            slug: id,
            surfaces: [],
            fromLegacyId: null,
          },
        },
      },
    };
    await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  }
  for (const [from, to] of [
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
  ]) {
    const source = `task/task-graph-${from}`,
      target = `task/task-graph-${to}`,
      identity = { source, target, type: "depends-on" as const, direction: "directed" as const },
      event = compileRelationCreatedEvent({
        opId: `operation-graph-${from}`,
        workspaceRevision: revision(),
        actor: { principal: { personId: "person-graph" }, executor: null },
        source: "local",
        occurredAt: "2026-09-04T00:00:00.000Z",
        record: {
          relation_id: deriveRelationId(identity),
          ...identity,
          origin: "declared",
          state: "active",
          rationale: "stock cycle fixture",
          targetObservedVersion: null,
        },
      });
    await append({ event, plan: relationEventWritePlan(event), blobs: [] });
  }
}
function contract(queries: TaskProjectionQueries) {
  const seed = "task/task-graph-a",
    base = { seed, direction: "outgoing" as const, relationTypes: ["depends-on" as const], maxDepth: 3, maxNodes: 10 },
    neighborhood = queries.readTaskRelationNeighborhood(base),
    closure = queries.readTaskDependencyClosure([seed], 3);
  assert.equal(neighborhood.truncated, false);
  assert.equal(closure.rows.length, 3);
  assert.throws(() => queries.readTaskDependencyClosure([seed], 1), /depth/);
  assert.throws(() => queries.readTaskRelationNeighborhood({ ...base, maxDepth: 1 }), /depth/);
  assert.throws(() => queries.readTaskRelationNeighborhood({ ...base, maxNodes: 1 }), /node budget/);
  assert.throws(() => queries.readTaskRuntimeBatch({ taskIds: [] }), /unique task ids/);
  assert.throws(() => queries.readTaskRuntimeBatch({ taskIds: ["task-parity", "task-parity"] }), /unique task ids/);
  const batch = queries.readTaskRuntimeBatch({ taskIds: ["task-parity", "missing"], limit: 1 });
  assert.ok(batch.page.nextCursor);
  const member = queries.readRuntimeDispatchesByMember({ agentId: "parity-agent", limit: 1 });
  assert.equal(member.rows.length, 1);
  assert.equal(member.truncated, true);
  assert.throws(() => queries.readRuntimeDispatchesByMember({ limit: 1 }), /exactly one/);
  const coverage = queries.readDecisionCoverage(["dec_E2"]);
  assert.ok(coverage.coverageRows.length);
  assert.equal(queries.readDecisionDocumentState!("missing"), null);
  assert.equal(queries.readFactAnchors([]).rows.length, 0);
  const digest = queries.readStateDigest();
  assert.match(digest!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(queries.readStateDigest(), digest);
  return {
    neighborhood,
    closure,
    summary: queries.readWorkspaceSummary(),
    incoming: queries.readTaskRelationNeighborhood({ ...base, direction: "incoming" }),
    both: queries.readTaskRelationNeighborhood({ ...base, direction: "both" }),
    window: queries.readTaskRelationNeighborhood({ ...base, maxDepth: 1, allowTruncation: true }),
    empty: queries.readTaskRelationNeighborhood({ ...base, seed: "task/missing" }),
    emptyClosure: queries.readTaskDependencyClosure([]),
    batch,
    nextBatch: queries.readTaskRuntimeBatch({
      taskIds: ["task-parity", "missing"],
      limit: 1,
      cursor: batch.page.nextCursor,
    }),
    allBatch: queries.readTaskRuntimeBatch({ taskIds: ["task-parity", "task-graph-a"] }),
    member,
    squadMember: queries.readRuntimeDispatchesByMember({ squadId: "parity-squad", limit: 10 }),
    noMember: queries.readRuntimeDispatchesByMember({ agentId: "missing", limit: 1 }),
    coverage,
    decision: queries.readDecisionDocumentState!("dec_PG_PARITY"),
    decisionGraph: queries.readDecisionGraph(),
    decisionIncoming: queries.readDecisionIncomingRelations("dec_PG_PARITY"),
    factAnchors: queries.readFactAnchors(),
    someFactAnchors: queries.readFactAnchors(["fact/F-11111111", "missing"]),
    factGraph: queries.readFactGraph(),
  };
}
export function assertCompleteQueryParity(pg: TaskProjectionQueries, sqlite: TaskProjectionQueries): void {
  // Digests and paths are backend-local identities. The same invariants above apply to both;
  // the value-bearing query results below are compared without normalization.
  assert.deepEqual(contract(pg), contract(sqlite));
}

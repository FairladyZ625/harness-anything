// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import type { TaskIndexProjectionRow, TaskRelationProjectionRow, TaskProjection } from "@harness-anything/kernel";
import { workTopologyFromProjection } from "../src/work-topology-read.ts";
import { parseDaemonGuiReadResult, validateDaemonWorkTopology } from "../src/protocol/gui-result-validation.ts";
import { daemonGuiReadSchemas } from "../src/protocol/daemon-protocol-schema-registry.ts";
import { validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";

type Status = "planned" | "active" | "blocked" | "done" | "cancelled";

function task(taskId: string, parentTaskId: string | null, status: Status): TaskIndexProjectionRow {
  return {
    taskId,
    title: `Task ${taskId}`,
    status,
    taskClass: "standard",
    pinned: false,
    parentTaskId,
    workKind: null,
    riskTier: null,
    urgency: null,
    packageDisposition: "active",
    supersededBy: null,
    packagePath: `tasks/${taskId}`,
    updatedAt: "2026-10-25T00:00:00.000Z",
    presentedStatus: status,
  };
}

function relation(
  relationId: string,
  sourceRef: string,
  targetRef: string,
  relationType: "depends-on" | "awaits" = "depends-on",
  rationale = "must happen first",
): TaskRelationProjectionRow {
  return {
    relationId,
    sourceRef,
    targetRef,
    relationType,
    direction: "directed",
    strength: "strong",
    origin: "declared",
    state: "active",
    targetObservedVersion: null,
    freshness: "current",
    rationale,
  } as TaskRelationProjectionRow;
}

function projection(input: {
  rows: readonly TaskIndexProjectionRow[];
  relations?: readonly TaskRelationProjectionRow[];
  awaits?: readonly TaskRelationProjectionRow[];
  cut?: { watermark: number; sourceRevision: number };
  mismatchParent?: string;
  eventCount?: number;
}) {
  const cut = input.cut ?? { watermark: 11, sourceRevision: 11 },
    counts = { taskRows: 0, relationRows: 0, eventRows: 0 };
  const readTaskIndex = (
    query: { taskIds?: readonly string[]; parentTaskId?: string; limit?: number; cursor?: string } = {},
  ) => {
    const selected = input.rows
      .filter((row) =>
        query.taskIds !== undefined
          ? query.taskIds.includes(row.taskId)
          : query.parentTaskId !== undefined
            ? row.parentTaskId === query.parentTaskId
            : true,
      )
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    const start = query.cursor === undefined ? 0 : selected.findIndex(({ taskId }) => taskId > query.cursor);
    const pageStart = start < 0 ? selected.length : start,
      pageLimit = query.limit ?? selected.length,
      rows = selected.slice(pageStart, pageStart + pageLimit);
    counts.taskRows += rows.length;
    return {
      status: "ready" as const,
      rows,
      ...(query.limit === undefined
        ? {}
        : {
            page: {
              limit: query.limit,
              nextCursor: pageStart + rows.length < selected.length ? rows.at(-1)!.taskId : null,
            },
          }),
      watermark:
        input.mismatchParent !== undefined && input.mismatchParent === query.parentTaskId
          ? cut.watermark + 1
          : cut.watermark,
      sourceRevision: cut.sourceRevision,
      warnings: [],
    };
  };
  const readTaskRelationsBySources = (refs: readonly string[], type: string) => {
    const rows = (type === "awaits" ? (input.awaits ?? []) : (input.relations ?? [])).filter(({ sourceRef }) =>
      refs.includes(sourceRef),
    );
    counts.relationRows += rows.length;
    return { status: "ready" as const, rows, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
  };
  const stub = {
    readCut: () => ({ status: "ready" as const, ...cut }),
    readTaskIndex,
    readTaskRelationsBySources,
    readEventList: () => {
      counts.eventRows += input.eventCount ?? 0;
      return [];
    },
  } as unknown as TaskProjection;
  return { stub, counts };
}

const baseRows = [
  task("root", null, "active"),
  task("member", "root", "planned"),
  task("leaf", "member", "done"),
  task("outside", null, "done"),
];
const baseRelations = [
  relation("rel-root-member", "task/root", "task/member"),
  relation("rel-member-outside", "task/member", "task/outside"),
];

test("reads the full subtree and direct dependency boundary from one cut; derives frontier and longest remaining path", () => {
  const { stub } = projection({ rows: baseRows, relations: baseRelations });
  const read = workTopologyFromProjection(stub, { workRootTaskId: "root" });

  assert.equal(read.schema, "daemon.work-topology/v1");
  assert.equal(read.watermark, 11);
  assert.equal(read.sourceRevision, 11);
  assert.deepEqual(
    read.members.map(({ taskId }) => taskId),
    ["root", "leaf", "member"],
  );
  assert.deepEqual(
    read.boundaryTasks.map(({ taskId, topologyState }) => ({ taskId, topologyState })),
    [{ taskId: "outside", topologyState: "boundary" }],
  );
  assert.deepEqual(
    read.edges.map(({ from, to }) => [from, to]),
    [
      ["task/member", "task/outside"],
      ["task/root", "task/member"],
    ],
  );
  assert.deepEqual(read.frontier, ["member"]);
  assert.deepEqual(read.criticalPath, ["member", "root"]);
  assert.equal(read.members.find(({ taskId }) => taskId === "root")?.topologyState, "in-flight");
  assert.deepEqual(validateDaemonWorkTopology(read), []);
  assert.deepEqual(parseDaemonGuiReadResult("repo.work.topology.read", read), read);
});

test("marks a work partial when a bounded read crosses projection cuts", () => {
  const { stub } = projection({ rows: baseRows, relations: baseRelations, mismatchParent: "root" });
  assert.throws(() => workTopologyFromProjection(stub, { workRootTaskId: "root" }), /crossed a cut/u);
});

test("missing dependency endpoints make state unknown and prevent a false frontier", () => {
  const { stub } = projection({
    rows: baseRows.slice(0, 3),
    relations: [relation("rel-missing", "task/member", "task/missing")],
  });
  const read = workTopologyFromProjection(stub, { workRootTaskId: "root" });
  assert.equal(read.completeness, "partial");
  assert.equal(read.criticalPath, null);
  assert.deepEqual(read.frontier, []);
  assert.equal(read.members.find(({ taskId }) => taskId === "member")?.topologyState, "unknown");
  assert.match(read.warnings.join(" "), /task\/missing/u);
});

test("awaits relations surface awaiting-ruling state instead of a ready frontier", () => {
  const { stub } = projection({
    rows: baseRows.slice(0, 3),
    awaits: [relation("rel-await", "task/root", "person/owner", "awaits", "question:please rule")],
  });
  const read = workTopologyFromProjection(stub, { workRootTaskId: "root" });
  assert.equal(read.members.find(({ taskId }) => taskId === "root")?.topologyState, "awaiting-ruling");
  assert.deepEqual(read.frontier, ["member"]);
});

test("active depends-on cycles are reported and do not produce a critical path", () => {
  const { stub } = projection({
    rows: baseRows.slice(0, 2),
    relations: [
      relation("rel-root-member", "task/root", "task/member"),
      relation("rel-member-root", "task/member", "task/root"),
    ],
  });
  const read = workTopologyFromProjection(stub, { workRootTaskId: "root" });
  assert.equal(read.criticalPath, null);
  assert.equal(read.completeness, "partial");
  assert.equal(read.members.find(({ taskId }) => taskId === "root")?.topologyState, "blocked");
  assert.equal(read.members.find(({ taskId }) => taskId === "member")?.topologyState, "blocked");
  assert.match(read.warnings.join(" "), /cycle/u);
});

test("cost budget: 200 and 2000 unrelated events produce the same bounded projection row reads", () => {
  const run = (eventCount: number) => {
    const { stub, counts } = projection({ rows: baseRows, relations: baseRelations, eventCount });
    const read = workTopologyFromProjection(stub, { workRootTaskId: "root" });
    return { read, counts };
  };
  const small = run(200),
    large = run(2_000);
  assert.deepEqual(small.counts, { taskRows: 4, relationRows: 2, eventRows: 0 });
  assert.deepEqual(large.counts, small.counts);
  assert.deepEqual(large.read, small.read);
});

test("invalid work topology result shape fails protocol validation", () => {
  const invalid = {
    ...workTopologyFromProjection(projection({ rows: baseRows }).stub, { workRootTaskId: "root" }),
    members: [{ taskId: 1 }],
  };
  assert.notDeepEqual(validateDaemonWorkTopology(invalid), []);
  assert.throws(() => parseDaemonGuiReadResult("repo.work.topology.read", invalid), /work-topology/u);
});

test("topology read protocol registers its result contract and validates only the root id payload", () => {
  const schema = daemonGuiReadSchemas.find(({ id }) => id === "daemon.work-topology/v1");
  assert.ok(schema);
  assert.deepEqual(schema.negativeFixtures, ["packages/daemon/fixtures/contracts/daemon-work-topology-invalid.json"]);
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.work.topology.read",
      params: { repo: { repoId: "repo" }, payload: { workRootTaskId: "root" } },
    }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      method: "repo.work.topology.read",
      params: { repo: { repoId: "repo" }, payload: { workRootTaskId: "root", limit: 10 } },
    }),
    [],
  );
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationProjectionRead,
  type TaskRelationQuery,
} from "../../kernel/src/index.ts";
import { seedRelationProjection } from "../../kernel/test/store/relation-graph-projection.fixtures.ts";
import { canonicalRoot, validateDaemonRelationGraph } from "../src/protocol/daemon-protocol.contract.ts";
import { wipSnapshotEntries, type TaskQueryCell } from "../src/repo-cell-task-query.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";

type ProjectionCut = {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
};

const readyCut: ProjectionCut = { status: "ready", watermark: 7, sourceRevision: 7 };
const eventEdge = {
  relationId: "rel_event_truth",
  sourceRef: "decision/dec_event/CH1",
  targetRef: "task/task_event",
  relationType: "derives" as const,
  direction: "directed" as const,
  strength: "strong" as const,
  origin: "declared" as const,
  state: "active" as const,
  targetObservedVersion: 7,
  currentTargetVersion: 7,
  freshness: "current" as const,
  rationale: "Event truth",
  ownerRef: "decision/dec_event",
  sourcePath: "events/decision.json",
  recordIndex: 0,
};
const secondEventEdge = {
  ...eventEdge,
  relationId: "rel_event_truth_second",
  sourceRef: "task/task_event",
  targetRef: "task/task_second",
  relationType: "depends-on" as const,
  ownerRef: "task/task_event",
};

test("wide and narrow relation reads ignore an authored-only L1/L2 edge", (t) => {
  const rootDir = legacyRoot(t),
    read = queryRead(rootDir, projectionStub());

  assert.deepEqual(legacyRelationIds(rootDir), ["rel_positive"]);
  const wide = read.relationGraph(),
    narrow = read.relationGraphPage({ state: "active" });

  assert.deepEqual(wide.edges, [{ ...eventEdge, current: true }]);
  assert.deepEqual(narrow.edges, wide.edges);
  assert.deepEqual(projectionCut(wide), readyCut);
  assert.deepEqual(projectionCut(narrow), readyCut);
});

test("pending event truth stays pending and never borrows L1 readiness", (t) => {
  const rootDir = legacyRoot(t),
    pendingCut = { status: "pending" as const, watermark: 6, sourceRevision: 7 },
    result = queryRead(rootDir, projectionStub({ cut: pendingCut })).relationGraph();

  assert.deepEqual(result.edges, [{ ...eventEdge, current: true }]);
  assert.deepEqual(projectionCut(result), pendingCut);
  assert.equal(result.warnings[0]?.code, "relation_truth_unavailable");
});

test("relation filters, facets, and pages select one event-backed edge universe", () => {
  const calls: TaskRelationQuery[] = [],
    read = queryRead(process.cwd(), projectionStub({ calls, edges: [eventEdge, secondEventEdge] })),
    wide = read.relationGraph(),
    filtered = read.relationGraphPage({ relationType: "derives" }),
    first = read.relationGraphPage({ limit: 1 }),
    second = read.relationGraphPage({ limit: 1, cursor: first.page?.nextCursor }),
    facet = read.relationGraphFacet({ facet: "edges" });

  assert.deepEqual(
    filtered.edges.map(({ relationId }) => relationId),
    [eventEdge.relationId],
  );
  assert.deepEqual(
    [...first.edges, ...second.edges].map(({ relationId }) => relationId),
    wide.edges.map(({ relationId }) => relationId),
  );
  assert.deepEqual(
    facet.edges.map(({ relationId }) => relationId),
    wide.edges.map(({ relationId }) => relationId),
  );
  assert.deepEqual(projectionCut(first), readyCut);
  assert.deepEqual(projectionCut(facet), readyCut);
  assert.deepEqual(
    calls.map(({ relationType, limit, cursor }) => ({ relationType, limit, cursor })),
    [
      { relationType: undefined, limit: undefined, cursor: undefined },
      { relationType: "derives", limit: undefined, cursor: undefined },
      { relationType: undefined, limit: 1, cursor: undefined },
      { relationType: undefined, limit: 1, cursor: "page-2" },
      { relationType: undefined, limit: undefined, cursor: undefined },
    ],
  );
});

test("task control, review queue, and decision detail expose one real cut", () => {
  const read = queryRead(process.cwd(), projectionStub()),
    tasks = read.guiTasks(),
    agenda = read.agenda(),
    detail = read.relationGraph();

  assert.deepEqual(projectionCut(tasks), readyCut);
  assert.deepEqual(projectionCut(agenda), readyCut);
  assert.deepEqual(projectionCut(detail), readyCut);
});

test("task control narrows graph, status, and decision reads to the selected lifecycle page", () => {
  const dependencyCalls: string[][] = [],
    targetCalls: { targetRefs: readonly string[]; relationType: string }[] = [],
    statusCalls: string[][] = [],
    decisionCalls: string[][] = [],
    dependency = { ...secondEventEdge, sourceRef: "task/task_event", targetRef: "task/task_blocker" },
    derives = { ...eventEdge, sourceRef: "decision/dec_event", targetRef: "task/task_event" },
    projection = projectionStub({
      taskRows: [activeTaskRow("task_event")],
      edges: [dependency, derives],
      dependencyCalls,
      targetCalls,
      statusCalls,
      decisionCalls,
    });

  const result = queryRead(process.cwd(), projection).guiTasks({ limit: 1 });

  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.invalidRows, []);
  assert.deepEqual(dependencyCalls, [["task/task_event"]]);
  assert.deepEqual(targetCalls, [{ targetRefs: ["task/task_event"], relationType: "derives" }]);
  assert.deepEqual(statusCalls, [["task_event", "task_blocker"]]);
  assert.deepEqual(decisionCalls, [["dec_event"]]);
});

test("task snapshot list isolates an invalid row and continues serving valid rows", () => {
  const invalidWitness = {
      schema: "code-doc-witness/v1",
      witnessId: "",
      taskId: "task_invalid",
      executionId: "execution-invalid",
      commitSha: "a".repeat(40),
      iteration: 0,
      paths: ["packages/daemon/src/task-query-read.ts"],
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local",
      reconciledAt: "2026-09-01T00:00:00.000Z",
    },
    result = queryRead(
      process.cwd(),
      projectionStub({
        taskRows: [protocolTaskRow("task_valid"), protocolTaskRow("task_invalid", [invalidWitness])],
      }),
    ).guiTasks();

  process.stdout.write(
    `[ROW-ISOLATION] inputRows=2 validRows=${result.rows.length} invalidRows=${result.invalidRows.length} ` +
      `field=${result.invalidRows[0]?.field ?? "missing"}\n`,
  );
  assert.deepEqual(
    result.rows.map(({ taskId }) => taskId),
    ["task_valid"],
  );
  assert.deepEqual(
    result.invalidRows.map(({ message: _message, ...diagnostic }) => diagnostic),
    [{ rowIndex: 1, taskId: "task_invalid", field: "rows[1].snapshot.codeDocWitnesses[0]" }],
  );
  assert.match(result.invalidRows[0]!.message, /^actual=.*Task snapshot field is invalid\.$/u);
});

test("a surface fails closed instead of stitching mismatched projection cuts", () => {
  const projection = projectionStub({ decisionCut: { ...readyCut, watermark: 8, sourceRevision: 8 } }),
    read = queryRead(process.cwd(), projection);
  assert.throws(() => read.relationGraph(), /relation graph spans multiple event projection cuts/u);
  assert.throws(() => read.guiTasks(), /task control surface spans multiple event projection cuts/u);
  assert.throws(() => read.agenda(), /task control surface spans multiple event projection cuts/u);
});

test("task reads fail closed when event truth has no packageDisposition", () => {
  const row = taskRowWithoutDisposition(),
    projection = projectionStub({ taskRows: [row] }),
    read = queryRead(process.cwd(), projection),
    cell = { projection } as unknown as TaskQueryCell;

  assert.throws(() => read.guiTasks(), /missing packageDisposition for task_missing/u);
  assert.throws(() => wipSnapshotEntries(cell), /missing packageDisposition for task_missing/u);
});

test("relation graph validator accepts the canonical cut and rejects invented fields", () => {
  const result = queryRead(process.cwd(), projectionStub()).relationGraph();
  assert.deepEqual(validateDaemonRelationGraph(result), []);
  assert.match(
    validateDaemonRelationGraph({ ...result, projection: { schema: "event-projection-cut/v1", ...readyCut } })[0]!,
    /entity=.*field=projection .*actual=/u,
  );
  const { sourceRevision: _sourceRevision, ...missingCut } = result;
  assert.match(validateDaemonRelationGraph(missingCut)[0]!, /entity=.*field=sourceRevision .*actual=/u);
});

function queryRead(rootDir: string, projection: TaskProjection) {
  return makeTaskQueryReadModel({
    rootDir: canonicalRoot(rootDir),
    projection,
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: (() => []) as never,
    },
  });
}

function legacyRoot(t: TestContext): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "g3b-read-truth-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedRelationProjection(path.join(rootDir, ".harness/cache/projections.sqlite"));
  return rootDir;
}

function legacyRelationIds(rootDir: string): readonly string[] {
  const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT relation_id FROM relation_edges ORDER BY relation_id")
      .all()
      .map((row) => String(row.relation_id));
  } finally {
    db.close();
  }
}

function projectionCut(value: ProjectionCut): ProjectionCut {
  return { status: value.status, watermark: value.watermark, sourceRevision: value.sourceRevision };
}

function projectionStub(
  options: {
    readonly cut?: ProjectionCut;
    readonly decisionCut?: ProjectionCut;
    readonly edges?: TaskRelationProjectionRead["rows"];
    readonly calls?: TaskRelationQuery[];
    readonly taskRows?: readonly unknown[];
    readonly dependencyCalls?: string[][];
    readonly targetCalls?: { targetRefs: readonly string[]; relationType: string }[];
    readonly statusCalls?: string[][];
    readonly decisionCalls?: string[][];
  } = {},
): TaskProjection {
  const cut = options.cut ?? readyCut,
    decisionCut = options.decisionCut ?? cut,
    edges = options.edges ?? [eventEdge],
    taskRows = options.taskRows ?? [];
  return {
    list: (query: TaskProjectionListQuery = {}) => ({
      ...cut,
      rows: taskRows,
      warnings: [],
      ...(query.limit === undefined
        ? {}
        : { page: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: null } }),
    }),
    readTaskRelations: () => ({ ...cut, rows: edges }),
    readTaskDependencyClosure: (sourceRefs: readonly string[]) => {
      options.dependencyCalls?.push([...sourceRefs]);
      return {
        ...cut,
        rows: edges.filter((edge) => edge.relationType === "depends-on" && sourceRefs.includes(edge.sourceRef)),
      };
    },
    readTaskRelationsByTargets: (targetRefs: readonly string[], relationType: string) => {
      options.targetCalls?.push({ targetRefs: [...targetRefs], relationType });
      return {
        ...cut,
        rows: edges.filter((edge) => edge.relationType === relationType && targetRefs.includes(edge.targetRef)),
      };
    },
    readRelationQuery: (query: TaskRelationQuery = {}) => {
      options.calls?.push(query);
      let rows = edges.filter(
        (edge) =>
          (query.entity === undefined || edge.sourceRef === query.entity || edge.targetRef === query.entity) &&
          (query.source === undefined || edge.sourceRef === query.source) &&
          (query.target === undefined || edge.targetRef === query.target) &&
          (query.relationType === undefined || edge.relationType === query.relationType) &&
          (query.state === undefined || edge.state === query.state),
      );
      if (query.cursor !== undefined) rows = rows.slice(1);
      const page =
        query.limit === undefined
          ? {}
          : {
              page: {
                limit: query.limit,
                cursor: query.cursor ?? null,
                nextCursor: query.cursor === undefined && rows.length > query.limit ? "page-2" : null,
              },
            };
      return { ...cut, rows: query.limit === undefined ? rows : rows.slice(0, query.limit), ...page };
    },
    readDecisionGraph: () => ({ ...decisionCut, decisions: [], edges: [], coverageRows: [] }),
    readFactGraph: () => ({ ...cut, facts: [], edges: [], factAnchors: [] }),
    searchFacts: () => ({ ...cut, facts: [] }),
    readFactAnchors: () => ({ ...cut, rows: [] }),
    readTaskStatuses: (taskIds: readonly string[]) => {
      options.statusCalls?.push([...taskIds]);
      return { ...cut, rows: [] };
    },
    readDecisions: (decisionIds: readonly string[]) => {
      options.decisionCalls?.push([...decisionIds]);
      return {
        ...decisionCut,
        decisions: decisionIds.includes("dec_event")
          ? [{ decisionId: "dec_event", appliesTo: { modules: [], productLines: [] } }]
          : [],
      };
    },
    listDecisions: () => ({ ...decisionCut, decisions: [] }),
    listDecisionAgendaPage: (query) => ({
      ...decisionCut,
      decisions: [],
      page: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: null },
    }),
  } as unknown as TaskProjection;
}

function activeTaskRow(taskId: string) {
  return protocolTaskRow(taskId);
}

function protocolTaskRow(taskId: string, codeDocWitnesses: readonly unknown[] = []) {
  return {
    taskId,
    packagePath: null,
    generation: "v1",
    workspaceRevision: 7,
    createdAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    snapshot: {
      revision: 7,
      task: {
        schema: "task/v2",
        taskId,
        title: taskId,
        taskClass: "standard",
        status: "planned",
        graph: {},
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        packageDisposition: "active",
      },
      executions: [],
      reviews: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
      consents: [],
      codeDocWitnesses,
      gateWitnesses: [],
    },
  };
}

function taskRowWithoutDisposition() {
  return {
    taskId: "task_missing",
    packagePath: null,
    generation: "v1",
    workspaceRevision: 7,
    createdAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    snapshot: {
      revision: 7,
      task: { title: "Missing", status: "planned", taskClass: "standard" },
      executions: [],
      reviews: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
    },
  };
}

// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  blockingOf,
  closeoutReadiness,
  taskBoardPlacement,
  taskCapabilities,
  taskVisibility,
  type TaskProjection,
  type TaskProjectionListQuery,
} from "../../kernel/src/index.ts";
type TaskBoardRowInput = Parameters<typeof taskBoardPlacement>[0];
import { canonicalRoot, validateDaemonTaskSnapshotList } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";

/**
 * The positive control 4.2 deletes its renderer judgments against. Each mirror below is the GUI
 * predicate it replaces, restated verbatim with the file, line and frozen exemption key it stands
 * for, and asserted equal to the new `repo.tasks.list` field on every row of one snapshot cut. If a
 * mirror and a field disagree, the field is not a substitute and the exemption may not be deleted.
 */

/** packages/gui/src/renderer/task-actions.ts:74-84 — gui-status-044 / 045 / 046. */
const guiIsTaskStartable = (row: BoardRow): boolean =>
  row.origin === "native" &&
  row.packageDisposition === "active" &&
  row.canonicalStatus === "planned" &&
  row.blocking === "clear";

/** packages/gui/src/renderer/graph/territoryProgress.ts:88-105 — gui-status-023 … 028. */
const guiStatusBucket = (status: string): string => {
  if (status === "done" || status === "active" || status === "blocked") return status;
  if (status === "in_review") return "in_review";
  if (status === "planned") return "planned";
  return "unknown";
};

/** packages/gui/src/renderer/graph/territoryProgress.ts:216-230 — gui-status-029. */
const guiStatusWeight = (status: string): number => {
  switch (status) {
    case "blocked":
      return 0;
    case "active":
      return 1;
    case "in_review":
      return 2;
    case "planned":
      return 3;
    case "done":
      return 4;
    default:
      return 5;
  }
};

/** packages/gui/src/api/view-model.ts:86-88 — gui-status-001. The board column a bucket falls in. */
const guiBoardColumnOfBucket: Readonly<Record<string, string | null>> = {
  planned: "open",
  active: "open",
  blocked: "blocked",
  in_review: "in_review",
  done: "terminal",
  unknown: null,
};

/** packages/gui/src/api/view-model.ts:113-115 and :128-130 — gui-status-003 / 004. */
const guiKeepsRow = (row: BoardRow): boolean => row.packageDisposition === "active";

/** packages/gui/src/renderer/model/taskFilters.ts:48-52 — gui-status-033 / 034. */
const guiIsTaskArchiveNoise = (row: BoardRow): boolean =>
  row.packageDisposition !== "active" || row.coordinationStatus === "cancelled";

test("board.columnId and board.rank equal the renderer's bucket and sort weight on every row", () => {
  const rows = boardRows();
  assert.equal(rows.length, 7, "the cut must exercise every column");
  for (const row of rows) {
    const bucket = guiStatusBucket(row.coordinationStatus);
    assert.equal(row.board.rank, guiStatusWeight(row.coordinationStatus), `${row.taskId} rank`);
    // cancelled is the one deliberate correction: the renderer buckets it as `unknown`
    // (territoryProgress.ts:104), the kernel calls it terminal (lifecycle-status.ts:18).
    const expected = row.coordinationStatus === "cancelled" ? "terminal" : guiBoardColumnOfBucket[bucket];
    assert.equal(row.board.columnId, expected, `${row.taskId} column`);
  }
  process.stdout.write(
    `[BOARD] ${rows.map((row) => `${row.taskId}=${row.coordinationStatus}->${row.board.columnId}/${row.board.rank}`).join(" ")}\n`,
  );
});

test("visibility.archived equals the renderer's disposition filter on every row", () => {
  const rows = boardRows();
  for (const row of rows) {
    assert.equal(row.visibility.archived, !guiKeepsRow(row), `${row.taskId} archived`);
    // gui-status-034 is *not* covered: archive noise is disposition OR cancelled, and a cancelled
    // task with an active package is not archived. The renderer keeps that half of the judgment.
    if (row.coordinationStatus !== "cancelled")
      assert.equal(row.visibility.archived, guiIsTaskArchiveNoise(row), `${row.taskId} noise`);
  }
  const cancelled = rows.find((row) => row.coordinationStatus === "cancelled")!;
  assert.equal(guiIsTaskArchiveNoise(cancelled), true);
  assert.equal(cancelled.visibility.archived, false, "negative control: the two judgments really differ");
  process.stdout.write(`[VISIBILITY] ${rows.map((row) => `${row.taskId}=${row.visibility.archived}`).join(" ")}\n`);
});

test("capabilities.start.available equals isTaskStartable on every row", () => {
  const rows = boardRows();
  for (const row of rows)
    assert.equal(capability(row, "start").available, guiIsTaskStartable(row), `${row.taskId} start`);
  assert.equal(
    rows.filter((row) => guiIsTaskStartable(row)).length,
    1,
    "negative control: the assertion must separate startable rows from the rest",
  );
  // The kernel adds `canStartExecution` (no active lease, current round) to the renderer's four
  // conditions. That only bites on a planned row already holding a lease; the cut has none.
  assert.deepEqual(
    rows.filter((row) => row.canonicalStatus === "planned" && row.snapshot.lease !== null).map((row) => row.taskId),
    [],
  );
  process.stdout.write(
    `[CAPABILITIES] ${rows.map((row) => `${row.taskId}=${row.capabilities.map((c) => `${c.id}:${c.available ? "yes" : (c.reason ?? "?")}`).join(",")}`).join(" | ")}\n`,
  );
});

test("the projected rows are admissible on the wire and carry no free-text reason", () => {
  const result = read().guiTasks();
  assert.deepEqual(result.invalidRows, []);
  assert.deepEqual(validateDaemonTaskSnapshotList(result), []);
  const tampered = {
    ...result,
    rows: result.rows.map((row, index) =>
      index === 0
        ? { ...row, capabilities: row.capabilities.map((c) => ({ ...c, reason: "该任务已归档，无法操作" })) }
        : row,
    ),
  };
  assert.notDeepEqual(validateDaemonTaskSnapshotList(tampered), [], "prose in reason must be rejected");
});

test("no capability, column or archived flag is recomputed outside the kernel judgment", () => {
  // CH4's negative criterion, asserted on the shipped rows rather than by reading source: the
  // daemon's own output is byte-identical to calling the kernel judgment on the same input.
  const rows = boardRows();
  for (const row of rows) {
    const recomputed = {
      board: kernelBoard(row),
      visibility: kernelVisibility(row),
      capabilities: kernelCapabilities(row),
    };
    assert.deepEqual({ board: row.board, visibility: row.visibility, capabilities: row.capabilities }, recomputed);
  }
});

type BoardRow = ReturnType<ReturnType<typeof read>["guiTasks"]>["rows"][number] & {
  readonly canonicalStatus: string;
  readonly blocking: string;
  readonly packageDisposition: string;
  readonly origin: string;
};

function kernelInput(row: BoardRow): TaskBoardRowInput {
  return {
    snapshot: row.snapshot,
    blockingState: row.blockingAssessment.state,
    packageDisposition: row.placement.packageDisposition,
    origin: row.placement.origin,
    closeoutReadiness: row.closeoutAssessment.readiness,
  };
}

const kernelBoard = (row: BoardRow) => taskBoardPlacement(kernelInput(row));
const kernelVisibility = (row: BoardRow) => taskVisibility(kernelInput(row));
const kernelCapabilities = (row: BoardRow) => taskCapabilities(kernelInput(row));

function capability(row: BoardRow, id: string) {
  return row.capabilities.find((entry) => entry.id === id)!;
}

function boardRows(): readonly BoardRow[] {
  return read()
    .guiTasks()
    .rows.map((row) => ({
      ...row,
      canonicalStatus: row.snapshot.task!.status,
      blocking: row.blockingAssessment.state,
      packageDisposition: row.placement.packageDisposition,
      origin: row.placement.origin,
    }));
}

function read() {
  return makeTaskQueryReadModel({
    rootDir: canonicalRoot(process.cwd()),
    projection: projectionStub(),
    judgments: { closeout: closeoutReadiness, blocking: blockingOf },
  });
}

const cut = { status: "ready" as const, watermark: 7, sourceRevision: 7 };

const dependsOnEdge = {
  relationId: "rel_board_blocked",
  sourceRef: "task/task_blocked",
  targetRef: "task/task_planned",
  relationType: "depends-on" as const,
  direction: "directed" as const,
  strength: "strong" as const,
  freshness: "current" as const,
  origin: "declared" as const,
  state: "active" as const,
  rationale: "Board fixture blocker",
  ownerRef: "task/task_blocked",
  sourcePath: "events/task.json",
  recordIndex: 0,
};

/**
 * One snapshot cut with a row per board column plus an archived package: planned, planned-behind-a
 * -dependency, active-with-lease, in_review-with-a-submitted-execution, done, cancelled, archived.
 */
function fixtureRows(): readonly unknown[] {
  return [
    taskRow("task_planned", "planned"),
    taskRow("task_blocked", "planned"),
    taskRow("task_active", "active", { lease: heldLease() }),
    taskRow("task_in_review", "in_review", { executions: [submittedExecution()] }),
    taskRow("task_done", "done"),
    taskRow("task_cancelled", "cancelled"),
    taskRow("task_archived", "planned", { packageDisposition: "archived" }),
  ];
}

function projectionStub(): TaskProjection {
  const rows = fixtureRows();
  const statuses = rows.map((row) => {
    const task = (row as { snapshot: { task: { taskId: string; status: string } } }).snapshot.task;
    return { taskId: task.taskId, status: task.status };
  });
  return {
    list: (_query: TaskProjectionListQuery = {}) => ({ ...cut, rows, warnings: [] }),
    readTaskDependencyClosure: (sourceRefs: readonly string[]) => ({
      ...cut,
      rows: [dependsOnEdge].filter((edge) => sourceRefs.includes(edge.sourceRef)),
    }),
    readTaskRelationsByTargets: () => ({ ...cut, rows: [] }),
    readTaskStatuses: () => ({ ...cut, rows: statuses }),
    readDecisions: () => ({ ...cut, decisions: [] }),
  } as unknown as TaskProjection;
}

function heldLease() {
  return {
    schema: "lease/v1",
    taskId: "task_active",
    executionId: "execution-active",
    actor: { principal: { personId: "person-owner" }, executor: null },
    source: "local",
    phase: "held",
    expiresAt: "2026-09-03T00:00:00.000Z",
    ttlMs: 900_000,
    version: 1,
  };
}

function submittedExecution() {
  return {
    schema: "execution/v1",
    executionId: "execution-review",
    taskId: "task_in_review",
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person-owner" }, executor: null },
    claimedAt: "2026-09-01T00:00:00.000Z",
    submittedAt: "2026-09-01T01:00:00.000Z",
    closedAt: null,
    submission: {
      completionClaim: "Board fixture submission",
      deliverables: ["fixture"],
      outputs: ["fixture"],
      verificationNotes: ["fixture"],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
    },
  };
}

function taskRow(
  taskId: string,
  status: string,
  overrides: {
    readonly lease?: unknown;
    readonly executions?: readonly unknown[];
    readonly packageDisposition?: string;
  } = {},
) {
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
        status,
        graph: {},
        currentNode: status === "in_review" ? "review" : "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        packageDisposition: overrides.packageDisposition ?? "active",
      },
      executions: overrides.executions ?? [],
      reviews: [],
      edgesTaken: [],
      lease: overrides.lease ?? null,
      decisionRelations: [],
      consents: [],
      codeDocWitnesses: [],
      gateWitnesses: [],
    },
  };
}

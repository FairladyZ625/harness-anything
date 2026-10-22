// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  isolateDaemonTaskSnapshotRows,
  validateDaemonTaskSnapshotList,
} from "../src/protocol/daemon-protocol.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const gateWitness = {
  schema: "completion-gate-witness/v1",
  subjects: [],
  predicateType: "human/v1",
  predicate: {},
  diagnostic: "human attestation",
  witnessId: "gate-run-0123456789abcdef",
  receiptId: "receipt-0123456789abcdef",
  checkerId: "signoff",
  gateId: "signoff",
  result: "pass",
  taskId: "task-repoint",
  executionId: "execution-repoint",
  commitSha: "a".repeat(40),
  iteration: 0,
  actor,
  source: "local",
  verifiedAt: "2026-08-25T00:00:00.000Z",
  observed: true,
  basis: {
    executionId: "execution-repoint",
    iteration: 0,
    submissionDigest: `sha256:${"a".repeat(64)}`,
    codeCommit: "a".repeat(40),
  },
  provenance: {
    source: "human",
    adapterId: "manual-attest",
    runId: "attest-repoint",
    rawResult: "approved",
  },
} as const;
const row = {
  taskId: "task-repoint",
  packagePath: null,
  generation: "v1",
  workspaceRevision: 1,
  createdAt: null,
  completedAt: null,
  updatedAt: "2026-08-25T00:00:00.000Z",
  snapshot: {
    revision: 1,
    task: null,
    executions: [],
    reviews: [],
    edgesTaken: [],
    lease: null,
    decisionRelations: [],
    consents: [],
    gateWitnesses: [gateWitness],
  },
  coordinationStatus: "unknown",
  snapshotAvailability: { consents: "known", gateWitnesses: "known" },
  closeoutAssessment: { readiness: "missing", blocker: "execution", gates: [] },
  blockingAssessment: { taskId: "task-repoint", state: "clear", label: "none", blockers: [], warnings: [] },
  deliveryStage: null,
  placement: {
    productLines: [],
    spawningDecisionIds: [],
    parentTaskId: null,
    origin: "native",
    engine: "kernel/task-lifecycle/v1",
    packageDisposition: "active",
    provenance: [{ kind: "canonical-event", ref: "task/task-repoint" }],
  },
  executionEvidence: [],
  // A row whose task the projection could not resolve sits in no board column and affords nothing.
  board: { columnId: null, rank: 6 },
  visibility: { archived: false, noise: false },
  capabilities: [
    { id: "start", available: false, reason: "unknown" },
    { id: "progress", available: false, reason: "unknown" },
    { id: "submit", available: false, reason: "unknown" },
    { id: "adjudicate", available: false, reason: "unknown" },
    { id: "review", available: false, reason: "unknown" },
    { id: "complete", available: false, reason: "unknown" },
  ],
  phase: { index: null, reason: "phase_unresolved", steps: ["planned", "active", "submitted", "in_review", "done"] },
  risk: { flagged: true },
  workspace: null,
} as const;
const list = {
  ok: true,
  status: "ready",
  watermark: 1,
  sourceRevision: 1,
  warnings: [],
  rows: [row],
  invalidRows: [],
} as const;

test("task snapshot protocol accepts audited gate witnesses", () => {
  assert.deepEqual(validateDaemonTaskSnapshotList(list), []);
});

test("task snapshot protocol requires the completedAt projection field", () => {
  const { completedAt: _completedAt, ...rowWithoutCompletedAt } = row;
  assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...list, rows: [rowWithoutCompletedAt] }), []);
});

test("task snapshot protocol tolerates rows from daemon builds before deliveryStage", () => {
  // GUI 是 attach-only:新 GUI 的入站校验会读到旧构建 daemon 的行(isTaskSnapshotProjectionRow
  // 对 completedAt 的同一先例)。缺 deliveryStage 放行;出现即必须是词表里的阶段词。
  const { deliveryStage: _deliveryStage, ...rowWithoutStage } = row;
  assert.deepEqual(validateDaemonTaskSnapshotList({ ...list, rows: [rowWithoutStage] }), []);
  const isolated = isolateDaemonTaskSnapshotRows([{ ...row, deliveryStage: "shipping" }]);
  assert.deepEqual(
    isolated.invalidRows.map(({ field }) => field),
    ["rows[0].deliveryStage"],
  );
});

test("task snapshot protocol isolates a malformed field with its source row identity", () => {
  const malformed = {
      ...row,
      taskId: "task-invalid",
      snapshot: { ...row.snapshot, gateWitnesses: [{ ...gateWitness, result: "" }] },
    },
    isolated = isolateDaemonTaskSnapshotRows([row, malformed]),
    result = { ...list, ...isolated };

  assert.deepEqual(isolated.rows, [row]);
  assert.deepEqual(
    isolated.invalidRows.map(({ message: _message, ...diagnostic }) => diagnostic),
    [{ rowIndex: 1, taskId: "task-invalid", field: "rows[1].snapshot.gateWitnesses[0]" }],
  );
  assert.match(isolated.invalidRows[0]!.message, /^actual=.*Task snapshot field is invalid\.$/u);
  assert.deepEqual(validateDaemonTaskSnapshotList(result), []);
});

test("task snapshot protocol accepts a named review disposition and isolates a malformed one", () => {
  const disposition = {
      schema: "review-disposition/v1",
      dispositionId: "disposition-0123456789abcdef",
      taskId: "task-repoint",
      executionId: "execution-repoint",
      iteration: 0,
      submissionDigest: `sha256:${"b".repeat(64)}`,
      disposedReviewIds: ["review-changes-requested"],
      rationale: "The requested change is out of this cut's scope.",
      actor,
      source: "local",
      disposedAt: "2026-08-25T00:00:00.000Z",
    } as const,
    disposed = { ...row, snapshot: { ...row.snapshot, reviewDispositions: [disposition] } },
    unnamed = {
      ...row,
      taskId: "task-unnamed-disposition",
      snapshot: { ...row.snapshot, reviewDispositions: [{ ...disposition, disposedReviewIds: [] }] },
    },
    isolated = isolateDaemonTaskSnapshotRows([row, disposed, unnamed]);

  assert.deepEqual(isolated.rows, [row, disposed]);
  assert.deepEqual(
    isolated.invalidRows.map(({ field }) => field),
    ["rows[2].snapshot.reviewDispositions"],
  );
});

test("task snapshot protocol accepts tasks with archiveOnComplete boolean flag", () => {
  const lightweightTask = {
    schema: "task/v2",
    taskId: "task-light",
    title: "Lightweight task with auto-archive",
    taskClass: "standard",
    status: "active",
    graph: {},
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
    archiveOnComplete: true,
  } as const;
  const lightRow = {
    ...row,
    taskId: "task-light",
    snapshot: { ...row.snapshot, task: lightweightTask },
  };

  const isolated = isolateDaemonTaskSnapshotRows([lightRow]);
  assert.equal(isolated.invalidRows.length, 0);
  assert.deepEqual(isolated.rows, [lightRow]);
  assert.deepEqual(validateDaemonTaskSnapshotList({ ...list, rows: [lightRow] }), []);
});

test("task snapshot protocol isolates tasks with non-boolean archiveOnComplete", () => {
  const invalidTask = {
    schema: "task/v2",
    taskId: "task-bad-archive",
    title: "Task with malformed archiveOnComplete",
    taskClass: "standard",
    status: "active",
    graph: {},
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
    archiveOnComplete: "true", // invalid: string instead of boolean
  };
  const badRow = {
    ...row,
    taskId: "task-bad-archive",
    snapshot: { ...row.snapshot, task: invalidTask as never },
  };

  const isolated = isolateDaemonTaskSnapshotRows([badRow]);
  assert.equal(isolated.rows.length, 0);
  assert.equal(isolated.invalidRows.length, 1);
  assert.equal(isolated.invalidRows[0]?.taskId, "task-bad-archive");
  assert.equal(isolated.invalidRows[0]?.field, "rows[0].snapshot.task");
});

// Verbatim shape of a real offline-converted task (task_w5r_rehearsal_anchor in the canonical
// ledger): contractVersion 1, no completion gates, and the presetSnapshotGap marker naming the
// acceptance whose preset bytes were never retained.
const gapTask = {
  schema: "task/v2",
  taskId: "task_w5r_rehearsal_anchor",
  title: "W5-R Fleet center rehearsal anchor",
  taskClass: "standard",
  status: "done",
  graph: {},
  currentNode: "implementation",
  iteration: 0,
  createdBy: actor,
  completionGateIds: [],
  presetSnapshotDigest: "sha256:9a0127b2e842a20a0f009e6183d51c6c3ec1fb03ff3a36cf741d0757ae172688",
  pinned: false,
  contractVersion: 1,
  presetSnapshotGap: { reason: "snapshot-bytes-unavailable", sourceGeneration: 2, sourceRevision: 41344 },
} as const;

test("task snapshot protocol keeps offline-converted tasks that carry a presetSnapshotGap", () => {
  const gapRow = {
    ...row,
    taskId: "task_w5r_rehearsal_anchor",
    snapshot: { ...row.snapshot, task: gapTask },
  };

  const isolated = isolateDaemonTaskSnapshotRows([gapRow]);
  assert.deepEqual(isolated.invalidRows, []);
  assert.deepEqual(isolated.rows, [gapRow]);
  assert.deepEqual(validateDaemonTaskSnapshotList({ ...list, rows: [gapRow] }), []);
});

test("task snapshot protocol isolates a malformed presetSnapshotGap", () => {
  for (const [label, gap] of [
    ["wrong reason", { reason: "bytes-missing", sourceGeneration: 2, sourceRevision: 41344 }],
    ["unknown generation", { reason: "snapshot-bytes-unavailable", sourceGeneration: 3, sourceRevision: 41344 }],
    ["non-positive revision", { reason: "snapshot-bytes-unavailable", sourceGeneration: 2, sourceRevision: 0 }],
    [
      "stray gap field",
      { reason: "snapshot-bytes-unavailable", sourceGeneration: 2, sourceRevision: 41344, note: "x" },
    ],
  ] as const) {
    const isolated = isolateDaemonTaskSnapshotRows([
      { ...row, taskId: "task-bad-gap", snapshot: { ...row.snapshot, task: { ...gapTask, presetSnapshotGap: gap } } },
    ]);
    assert.equal(isolated.rows.length, 0, label);
    assert.equal(isolated.invalidRows[0]?.field, "rows[0].snapshot.task", label);
  }
  // A gap without its digest anchor names an acceptance that cannot be identified.
  const unanchored = isolateDaemonTaskSnapshotRows([
    {
      ...row,
      taskId: "task-bad-gap",
      snapshot: { ...row.snapshot, task: { ...gapTask, presetSnapshotDigest: null } },
    },
  ]);
  assert.equal(unanchored.rows.length, 0);
  assert.equal(unanchored.invalidRows[0]?.field, "rows[0].snapshot.task");
});

test("task snapshot protocol carries this node's view of a task's derived workspace, never a stored one", () => {
  const binding = { kind: "worktree", branch: "task-bound", path: ".worktrees/task-bound" } as const,
    boundTask = {
      schema: "task/v2",
      taskId: "task-bound",
      title: "Bound task",
      taskClass: "standard",
      status: "active",
      graph: {},
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: false,
    } as const,
    boundRow = {
      ...row,
      taskId: "task-bound",
      snapshot: { ...row.snapshot, task: boundTask },
      workspace: { ...binding, state: "materialized" },
    } as const,
    packageRow = { ...row, workspace: { kind: "task-package", path: "harness/tasks/task-bound" } } as const;
  assert.deepEqual(validateDaemonTaskSnapshotList({ ...list, rows: [boundRow, packageRow] }), []);

  const isolated = isolateDaemonTaskSnapshotRows([
    { ...boundRow, workspace: { ...binding, state: "checked-out" } } as never,
    {
      ...boundRow,
      snapshot: { ...boundRow.snapshot, task: { ...boundTask, worktree: binding } },
    } as never,
  ]);
  assert.deepEqual(
    isolated.invalidRows.map(({ field }) => field),
    ["rows[0].workspace", "rows[1].snapshot.task"],
  );
});

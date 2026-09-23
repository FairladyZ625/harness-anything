// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  isolateDaemonTaskSnapshotRows,
  validateDaemonTaskSnapshotList,
} from "../src/protocol/daemon-protocol.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const repoint = {
  schema: "code-doc-witness-repoint/v1",
  recordId: "code-doc-repoint-0123456789abcdef",
  supersedes: "code-doc-0123456789abcdef",
  taskId: "task-repoint",
  executionId: "execution-repoint",
  commitSha: "a".repeat(40),
  iteration: 0,
  paths: ["tasks/task-repoint/report.md"],
  disposition: "repointed",
  reason: "Correct the ledger-root path.",
  actor,
  source: "local",
  repointedAt: "2026-08-25T00:00:00.000Z",
} as const;
const row = {
  taskId: "task-repoint",
  packagePath: null,
  generation: "v1",
  workspaceRevision: 1,
  createdAt: null,
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
    codeDocWitnesses: [repoint],
    gateWitnesses: [],
  },
  coordinationStatus: "unknown",
  snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
  closeoutAssessment: { readiness: "missing", blocker: "execution", gates: [] },
  blockingAssessment: { taskId: "task-repoint", state: "clear", label: "none", blockers: [], warnings: [] },
  placement: {
    moduleKeys: [],
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

test("task snapshot protocol accepts audited code-doc repoints", () => {
  assert.deepEqual(validateDaemonTaskSnapshotList(list), []);
});

test("task snapshot protocol isolates a malformed field with its source row identity", () => {
  const malformed = {
      ...row,
      taskId: "task-invalid",
      snapshot: { ...row.snapshot, codeDocWitnesses: [{ ...repoint, reason: "" }] },
    },
    isolated = isolateDaemonTaskSnapshotRows([row, malformed]),
    result = { ...list, ...isolated };

  assert.deepEqual(isolated.rows, [row]);
  assert.deepEqual(
    isolated.invalidRows.map(({ message: _message, ...diagnostic }) => diagnostic),
    [{ rowIndex: 1, taskId: "task-invalid", field: "rows[1].snapshot.codeDocWitnesses[0]" }],
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

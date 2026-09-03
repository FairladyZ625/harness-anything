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
  board: { columnId: null, rank: 5 },
  visibility: { archived: false, noise: false },
  capabilities: [
    { id: "start", available: false, reason: "unknown" },
    { id: "progress", available: false, reason: "unknown" },
    { id: "submit", available: false, reason: "unknown" },
    { id: "review", available: false, reason: "unknown" },
    { id: "complete", available: false, reason: "unknown" },
  ],
  phase: { index: null, reason: "phase_unresolved", steps: ["planned", "active", "in_review", "done"] },
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

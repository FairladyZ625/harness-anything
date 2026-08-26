// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  FLEET_CHUNK_BYTES,
  FLEET_FRAME_BYTES,
  FLEET_KEY_SEND_WINDOW_BYTES,
  FLEET_SESSION_SEND_WINDOW_BYTES,
  FleetContractError,
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
} from "../src/fleet/contract.ts";

const cut = { revision: 7, headDigest: `sha256:${"b".repeat(64)}` } as const;
const ledgerCut = { repoId: "repo", ...cut } as const;
const blob = { sha256: "c".repeat(64), size: 3, mediaType: "text/markdown" } as const;
const frames = [
  {
    schema: "fleet.session.hello/v1",
    messageId: "m1",
    protocolVersion: { major: 1, minor: 0 },
    nodeId: "node-1",
    credential: "secret",
  },
  {
    schema: "fleet.session.ready/v1",
    messageId: "m2",
    inReplyTo: "m1",
    sessionId: "s1",
    maxFrameBytes: FLEET_FRAME_BYTES,
    chunkBytes: FLEET_CHUNK_BYTES,
  },
  { schema: "fleet.assignment.get/v1", messageId: "m3", assignmentId: "a1" },
  {
    schema: "fleet.assignment.result/v1",
    messageId: "m4",
    inReplyTo: "m3",
    assignmentId: "a1",
    repoId: "repo",
    taskId: "task",
    executionId: "exec",
    paths: ["tasks/task/a.md"],
    baseLedgerSha: ledgerCut,
    expiresAt: "2099-01-01T00:00:00.000Z",
    writerEpoch: 1,
  },
  { schema: "fleet.receipt.get/v1", messageId: "m4-receipt-get", assignmentId: "a1", opId: "op1" },
  {
    schema: "fleet.receipt.result/v1",
    messageId: "m4-receipt-result",
    inReplyTo: "m4-receipt-get",
    opId: "op1",
    receipt: { outcome: "op_rejected", code: "operation_not_published" },
  },
  { schema: "fleet.upload.begin/v1", messageId: "m5", assignmentId: "a1", content: blob },
  {
    schema: "fleet.upload.ready/v1",
    messageId: "m6",
    inReplyTo: "m5",
    uploadId: "u1",
    resumeOffset: 0,
    status: "receiving",
  },
  { schema: "fleet.upload.chunk/v1", messageId: "m7", uploadId: "u1", offset: 0, dataBase64: "YWJj" },
  { schema: "fleet.upload.finish/v1", messageId: "m8", uploadId: "u1" },
  {
    schema: "fleet.upload.result/v1",
    messageId: "m9",
    inReplyTo: "m8",
    status: "staged",
    descriptor: { ref: "doc-sync-claims/u1", ...blob },
  },
  {
    schema: "fleet.doc.submit/v1",
    messageId: "m10",
    assignmentId: "a1",
    executionId: null,
    writerEpoch: 1,
    baseLedgerSha: ledgerCut,
    changes: [
      {
        path: "tasks/task/a.md",
        baseBlobSha256: null,
        policyId: "markdown-body-replaceable/v1",
        candidate: { ref: "doc-sync-claims/u1", ...blob },
      },
    ],
  },
  {
    schema: "fleet.doc.result/v1",
    messageId: "m11",
    inReplyTo: "m10",
    outcome: "applied",
    opId: "op1",
    revision: 7,
    code: null,
  },
  { schema: "fleet.replica.pull/v1", messageId: "m11-pull", assignmentId: "a1" },
  {
    schema: "fleet.replica.current/v1",
    messageId: "m11-current",
    inReplyTo: "m11-pull",
    repoId: "repo",
    viewId: "v1",
    cut,
    manifestDigest: "d".repeat(64),
  },
  {
    schema: "fleet.snapshot.begin/v1",
    messageId: "m12",
    transferId: "t1",
    repoId: "repo",
    viewId: "v1",
    cut,
    manifest: { digest: "d".repeat(64), entryCount: 1, totalBytes: 3 },
  },
  {
    schema: "fleet.snapshot.page/v1",
    messageId: "m13",
    transferId: "t1",
    pageIndex: 0,
    entries: [{ path: "tasks/task/a.md", blob }],
  },
  {
    schema: "fleet.snapshot.chunk/v1",
    messageId: "m14",
    transferId: "t1",
    blobSha256: blob.sha256,
    offset: 0,
    dataBase64: "YWJj",
  },
  { schema: "fleet.snapshot.finish/v1", messageId: "m15", transferId: "t1", manifestDigest: "d".repeat(64) },
  {
    schema: "fleet.delta.begin/v1",
    messageId: "m16",
    transferId: "t2",
    repoId: "repo",
    viewId: "v1",
    fromCut: { ...cut, revision: 6 },
    toCut: cut,
    changeCount: 2,
    resultManifestDigest: "d".repeat(64),
  },
  {
    schema: "fleet.delta.page/v1",
    messageId: "m17",
    transferId: "t2",
    pageIndex: 0,
    changes: [
      { op: "put", path: "tasks/task/a.md", blob },
      { op: "delete", path: "tasks/task/b.md" },
    ],
  },
  {
    schema: "fleet.delta.chunk/v1",
    messageId: "m18",
    transferId: "t2",
    blobSha256: blob.sha256,
    offset: 0,
    dataBase64: "YWJj",
  },
  { schema: "fleet.delta.finish/v1", messageId: "m19", transferId: "t2", resultManifestDigest: "d".repeat(64) },
  { schema: "fleet.ack/v1", messageId: "m20", transferId: "t1", cut, manifestDigest: "d".repeat(64) },
  {
    schema: "fleet.ack.result/v1",
    messageId: "m21",
    inReplyTo: "m20",
    outcome: "applied",
    viewId: "v1",
    ackCut: 7,
    code: null,
  },
  {
    schema: "fleet.task.command/v1",
    messageId: "m22-task",
    assignmentId: "a1",
    writerEpoch: 1,
    opId: "op-task-1",
    repoId: "repo",
    taskId: "task_abc",
    action: { kind: "task-start", taskId: "task_abc", ttlMs: 86_400_000 },
    waitMs: 30_000,
    docChanges: null,
    mirrorBaseCut: null,
  },
  {
    schema: "fleet.task.result/v1",
    messageId: "m22-result",
    inReplyTo: "m22-task",
    outcome: "applied",
    opId: "op-task-1",
    revision: 8,
    code: null,
    receipt: { outcome: "applied", taskId: "task_abc" },
    lease: { taskId: "task_abc", executionId: "exe-1", assignmentId: "a1", expiresAt: "2099-01-01T00:00:00.000Z" },
    queuePosition: null,
  },
  {
    schema: "fleet.error/v1",
    messageId: "m22",
    inReplyTo: "m20",
    code: "invalid_ack",
    retryable: false,
    resumeOffset: null,
    nextAction: "refresh",
  },
] as const;

test("Fleet transport union round-trips every closed wire variant", () => {
  assert.equal(FLEET_KEY_SEND_WINDOW_BYTES, 256 * 1024);
  assert.equal(FLEET_SESSION_SEND_WINDOW_BYTES, 512 * 1024);
  for (const frame of frames) assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame, frame.schema);
  const taskCommand = frames.find((frame) => frame.schema === "fleet.task.command/v1")!;
  for (const action of [
    {
      kind: "task-create",
      title: "Fleet task",
      riskTier: "high",
      registerModule: { key: "kernel", title: "Kernel", prefix: "task", scope: "repo" },
      surfaces: ["ha task start"],
      relations: [{ type: "depends-on", target: "task/task_parent", rationale: "ordered" }],
    },
    { kind: "task-start", taskId: "task_abc", executionId: "exe_abc", ttlMs: 60_000, dryRun: true },
    {
      kind: "task-progress-append",
      taskId: "task_abc",
      executionId: "exe_abc",
      text: "progress",
      evidence: [{ type: "test", path: "reports/result.txt", summary: "pass" }],
      baseDocumentSha256: null,
    },
    {
      kind: "task-submit",
      taskId: "task_abc",
      executionId: "exe_abc",
      submission: { completionClaim: "complete", deliverables: [] },
    },
    { kind: "task-release", taskId: "task_abc", reason: "handoff" },
    { kind: "task-transition", taskId: "task_abc", status: "blocked", reason: "provider fallback exhausted" },
  ])
    assert.deepEqual(parseFleetFrame({ ...taskCommand, taskId: "task_abc", action }).action, action);
});

test("Fleet codec rejects unknown provenance, nested fields, malformed values, and limits", () => {
  const taskCommand = frames.find((frame) => frame.schema === "fleet.task.command/v1")!,
    snapshotPage = frames.find((frame) => frame.schema === "fleet.snapshot.page/v1")!,
    snapshotChunk = frames.find((frame) => frame.schema === "fleet.snapshot.chunk/v1")!,
    snapshotCurrent = frames.find((frame) => frame.schema === "fleet.replica.current/v1")!;
  const spoofFields = [
    "actor",
    "executor",
    "root",
    "canonicalRoot",
    "workspaceId",
    "expectedRevision",
    "eventId",
    "occurredAt",
    "gitCredential",
    "credential",
    "createMode",
  ];
  for (const invalid of [
    { ...frames[6], actor: { principal: { personId: "spoof" } } },
    { ...frames[6], content: { ...blob, extra: true } },
    { ...snapshotPage, entries: Array.from({ length: 129 }, (_, index) => ({ path: `tasks/task/${index}.md`, blob })) },
    { ...snapshotChunk, dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES + 1).toString("base64") },
    { ...snapshotPage, entries: [{ path: "../escape", blob }] },
    { ...snapshotCurrent, cut: { ...cut, commitSha: "a".repeat(40) } },
    { ...taskCommand, action: { kind: "task-start", taskId: "task_abc", actor: { principal: { personId: "spoof" } } } },
    { ...taskCommand, action: { kind: "host-run", command: "anything" } },
    { ...taskCommand, action: { kind: "task-create", title: "t", createMode: "admin" } },
    { ...taskCommand, action: { kind: "task-release", taskId: "task_abc", ttlMs: 1 } },
    { ...taskCommand, action: { kind: "task-transition", taskId: "task_abc", status: "cancelled", reason: "no" } },
    { ...taskCommand, action: { kind: "task-start", taskId: "task_abc", ttlMs: "forever" } },
    { ...taskCommand, action: { kind: "task-create", title: "t", riskTier: "critical" } },
    {
      ...taskCommand,
      action: {
        kind: "task-create",
        title: "t",
        registerModule: { key: "m", title: "M", prefix: "m", scope: "repo", actor: "spoof" },
      },
    },
    { ...taskCommand, action: { kind: "task-submit", taskId: "task_abc", submission: "not-an-object" } },
    ...spoofFields.map((field) => ({
      ...taskCommand,
      action: {
        kind: "task-start",
        taskId: "task_abc",
        [field]: field === "actor" ? { principal: { personId: "spoof" } } : "spoof",
      },
    })),
    { ...frames[0], schema: "fleet.unknown/v1" },
  ])
    assert.throws(() => parseFleetFrame(invalid), FleetContractError);
  assert.throws(
    () =>
      parseFleetFrame(
        `{"schema":"fleet.session.hello/v1","messageId":"m","protocolVersion":{"major":1,"minor":0},"nodeId":"n","credential":"${"x".repeat(FLEET_FRAME_BYTES)}"}`,
      ),
    /frame exceeds/u,
  );
  assert.throws(() => new FleetUtf8LineDecoder().push(Buffer.from([0xc3, 0x28])), /encoded data/u);
});

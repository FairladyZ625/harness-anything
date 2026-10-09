// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { READ_MODEL_SCHEMA_GENERATION } from "@harness-anything/kernel";
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

const cut = {
  revision: 7,
  headDigest: `sha256:${"b".repeat(64)}`,
  schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
} as const;
const ledgerCut = { repoId: "repo", revision: cut.revision, headDigest: cut.headDigest } as const;
const blob = { sha256: "c".repeat(64), size: 3, mediaType: "text/markdown" } as const;
test("fleet authentication metadata admits a standard JWT and remains separate from closed action fields", () => {
  const frame = {
    schema: "fleet.task.command/v1",
    messageId: "human",
    writerEpoch: 1,
    opId: "human-op",
    repoId: "repo",
    taskId: "task",
    action: { kind: "task-review-consent", taskId: "task", reviewId: "review" },
    docChanges: null,
    mirrorBaseCut: null,
    accessToken: "a".repeat(2_048),
  };
  assert.deepEqual(parseFleetFrame(frame), frame);
  assert.throws(() => parseFleetFrame({ ...frame, accessToken: "a".repeat(16 * 1024 + 1) }), FleetContractError);
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { ...frame.action, accessToken: frame.accessToken } }),
    FleetContractError,
  );
});
test("replica cut identity requires schema generation", () => {
  const frame = frames.find((candidate) => candidate.schema === "fleet.replica.head-hint/v1")!;
  const { schemaGeneration: _generation, ...revisionOnly } = cut;
  assert.throws(() => parseFleetFrame({ ...frame, cut: revisionOnly }), FleetContractError);
  assert.deepEqual(parseFleetFrame(frame), frame);
});
test("runtime dispatch frames carry typed center admission context without mirrored budget state", () => {
  const frame = {
    schema: "fleet.runtime.event/v1",
    messageId: "dispatch",
    writerEpoch: 1,
    repoId: "repo",
    opId: "dispatch-op",
    eventType: "runtime_dispatch_requested",
    payload: {},
    result: null,
    dispatchContext: { role: "reviewer", taskId: "task", executionId: "execution" },
  };
  assert.deepEqual(parseFleetFrame(frame), frame);
  const { dispatchContext: _context, ...missing } = frame;
  assert.throws(() => parseFleetFrame(missing), FleetContractError);
  assert.throws(
    () =>
      parseFleetFrame({
        ...frame,
        dispatchContext: {
          ...frame.dispatchContext,
          reviewReturnBudget: 99,
        },
      }),
    FleetContractError,
  );
});
test("fleet runtime await admits only the parked operational wait", () => {
  const frame = {
    schema: "fleet.runtime.await/v1",
    messageId: "wait",
    repoId: "repo",
    method: "repo.agentRuntime.sessions.await",
    payload: { runtimeSessionIds: ["runtime-one"] },
  };
  assert.deepEqual(parseFleetFrame(frame), frame);
  assert.throws(() => parseFleetFrame({ ...frame, schema: "fleet.runtime.read/v1" }), FleetContractError);
  assert.throws(() => parseFleetFrame({ ...frame, method: "repo.agentRuntime.overview" }), FleetContractError);
  assert.throws(() => parseFleetFrame({ ...frame, method: "repo.task.run" }), FleetContractError);
  assert.throws(() => parseFleetFrame({ ...frame, method: "repo.agentRuntime.spawn" }), FleetContractError);
});
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
  { schema: "fleet.repo.metadata.get/v1", messageId: "m3", repoId: "a1" },
  {
    schema: "fleet.repo.metadata.result/v1",
    messageId: "m4",
    inReplyTo: "m3",
    personId: "person-owner",
    actionAllowed: null,
    repoId: "repo",
    baseLedgerSha: ledgerCut,
    writerEpoch: 1,
  },
  { schema: "fleet.receipt.get/v1", messageId: "m4-receipt-get", repoId: "a1", opId: "op1" },
  {
    schema: "fleet.receipt.result/v1",
    messageId: "m4-receipt-result",
    inReplyTo: "m4-receipt-get",
    opId: "op1",
    receipt: { outcome: "op_rejected", code: "operation_not_published" },
  },
  { schema: "fleet.upload.begin/v1", messageId: "m5", repoId: "a1", content: blob },
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
    repoId: "a1",
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
  { schema: "fleet.replica.pull/v1", messageId: "m11-pull", repoId: "a1" },
  { schema: "fleet.replica.preparing/v1", messageId: "m11-preparing", inReplyTo: "m11-pull", repoId: "a1" },
  { schema: "fleet.replica.watch/v1", messageId: "m11-watch", repoId: "a1", afterRevision: 7 },
  { schema: "fleet.replica.head-hint/v1", messageId: "m11-hint", inReplyTo: "m11-watch", repoId: "a1", cut },
  {
    schema: "fleet.replica.current/v1",
    messageId: "m11-current",
    inReplyTo: "m11-pull",
    repoId: "repo",
    viewId: "v1",
    cut,
    manifestDigest: "d".repeat(64),
    authorizationOwner: "person-owner",
    authorizationShapeDigest: "d".repeat(64),
  },
  {
    schema: "fleet.snapshot.begin/v1",
    messageId: "m12",
    transferId: "t1",
    repoId: "repo",
    viewId: "v1",
    cut,
    manifest: { digest: "d".repeat(64), entryCount: 1, totalBytes: 3 },
    authorizationOwner: "person-owner",
    authorizationShapeDigest: "d".repeat(64),
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
    authorizationOwner: "person-owner",
    authorizationShapeDigest: "d".repeat(64),
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
    writerEpoch: 1,
    opId: "op-task-1",
    repoId: "repo",
    taskId: "task_abc",
    action: { kind: "task-start", taskId: "task_abc", ttlMs: 86_400_000 },
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
  },
  {
    schema: "fleet.schedule.command/v1",
    messageId: "m22-schedule",
    writerEpoch: 1,
    opId: "op-schedule-1",
    repoId: "repo",
    scheduleId: "probe",
    action: {
      kind: "schedule-create",
      scheduleId: "probe",
      name: "Probe",
      mode: "detect",
      everyMs: 60_000,
      agentId: "probe-agent",
      runtimeInstanceId: "probe-instance",
      mission: "Run the probe.",
    },
  },
  {
    schema: "fleet.schedule.result/v1",
    messageId: "m22-schedule-result",
    inReplyTo: "m22-schedule",
    opId: "op-schedule-1",
    outcome: "applied",
    revision: 9,
    code: null,
    receipt: { outcome: "applied", scheduleId: "probe" },
  },
  {
    schema: "fleet.error/v1",
    messageId: "m22",
    inReplyTo: "m20",
    code: "invalid_ack",
    message: "ACK does not match the current transfer.",
    retryable: false,
    resumeOffset: null,
  },
] as const;

// The real-machine edge retest (F-31931F21) had a 950-character plan rejected because the
// create action reused the 512-character short-scalar text check for a document body.
test("task-create carries the plan as a document body bounded by the frame budget, not the short text cap", () => {
  const taskCommand = frames.find((frame) => frame.schema === "fleet.task.command/v1")!;
  const filler = "边缘节点提交的多段计划正文，含 🛰 星外字符与 é 组合标记，逐字穿过 Fleet 通道。";
  const head = "# 边缘计划\n\n## Brief\n",
    tail = "\n## Verification\n跑通本回归测试并逐字读回。\n";
  let body = "";
  while (head.length + body.length + tail.length < 950) body += `${filler}\n`;
  const plan = head + body.slice(0, 950 - head.length - tail.length) + tail;
  assert.equal(plan.length, 950);
  const frame = { ...taskCommand, action: { kind: "task-create", title: "Edge plan task", plan } };
  const parsed = parseFleetFrame(frame) as typeof frame;
  assert.equal(parsed.action.plan, plan, "the plan body parses verbatim, combining marks and astral chars intact");
  assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame, "serialize→parse round-trips the plan body");
  // The body budget itself still binds before the frame cap sees the frame.
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { ...frame.action, plan: "x".repeat(32 * 1024 + 1) } }),
    FleetContractError,
  );
  // A character-count-legal plan of multi-byte text cannot push the frame past 96 KiB.
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { ...frame.action, plan: "字".repeat(32 * 1024) } }),
    /frame exceeds/u,
  );
  // The short-scalar cap was not relaxed globally: title keeps the 512-character bound.
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { kind: "task-create", title: "t".repeat(513) } }),
    FleetContractError,
  );
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { kind: "task-create", title: "t", plan: "" } }),
    FleetContractError,
  );
});

test("Fleet transport union round-trips every closed wire variant", () => {
  assert.equal(FLEET_KEY_SEND_WINDOW_BYTES, 256 * 1024);
  assert.equal(FLEET_SESSION_SEND_WINDOW_BYTES, 512 * 1024);
  for (const frame of frames) assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame, frame.schema);
  const taskCommand = frames.find((frame) => frame.schema === "fleet.task.command/v1")!;
  for (const action of [
    { kind: "task-settle", taskId: "task_abc" },
    { kind: "task-submit", taskId: "task_abc", amend: true, asOwner: true },
    {
      kind: "task-create",
      title: "Fleet task",
      riskTier: "high",
      parentTaskId: "task_root",
      taskClass: "work",
      surfaces: ["ha task start"],
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
    },
    { kind: "task-complete", taskId: "task_abc" },
    {
      kind: "task-review-execution",
      taskId: "task_abc",
      reviewId: "review_abc",
      verdict: "approved",
      reason: "checked",
      evidenceChecked: ["tests"],
    },
    { kind: "task-review-consent", taskId: "task_abc", reviewId: "review_abc" },
    { kind: "task-release", taskId: "task_abc", reason: "handoff" },
    { kind: "task-transition", taskId: "task_abc", status: "blocked", reason: "manual review required" },
  ]) {
    let parsed: ReturnType<typeof parseFleetFrame> | undefined;
    assert.doesNotThrow(() => {
      parsed = parseFleetFrame({ ...taskCommand, taskId: "task_abc", action });
    }, action.kind);
    assert.deepEqual((parsed as typeof taskCommand).action, action);
  }
  const scheduleCommand = frames.find((frame) => frame.schema === "fleet.schedule.command/v1")!;
  for (const action of [
    {
      kind: "schedule-update",
      scheduleId: "probe",
      name: "Updated probe",
      model: null,
      reasoningEffort: null,
      cwd: null,
      idempotencyKey: "update-probe",
    },
    {
      kind: "schedule-update",
      scheduleId: "probe",
      cronExpression: "30 2 * * *",
      timezone: "Asia/Taipei",
    },
    { kind: "schedule-delete", scheduleId: "probe", reason: "retired", idempotencyKey: "delete-probe" },
    {
      kind: "schedule-run-now",
      scheduleId: "probe",
      scheduledFor: "2099-01-01T00:00:00.000Z",
      observedDefinitionRevision: 7,
      idempotencyKey: "timer-probe",
    },
    {
      kind: "schedule-missed",
      scheduleId: "probe",
      from: "2099-01-01T00:00:00.000Z",
      to: "2099-01-01T01:00:00.000Z",
      count: 2,
      reason: "scheduler_unavailable",
      observedDefinitionRevision: 7,
      idempotencyKey: "missed-probe",
    },
    {
      kind: "schedule-dispatch-link",
      scheduleId: "probe",
      claimFence: "claim-probe",
      dispatchId: "dispatch-probe",
      runtimeSessionId: "runtime-probe",
      idempotencyKey: "link-probe",
    },
    {
      kind: "schedule-settle",
      scheduleId: "probe",
      claimFence: "claim-probe",
      outcome: "succeeded",
      endedAt: "2099-01-01T01:00:00.000Z",
      idempotencyKey: "settle-probe",
    },
  ])
    assert.deepEqual(parseFleetFrame({ ...scheduleCommand, action }).action, action);
  for (const kind of ["schedule-show", "schedule-runs", "schedule-list", "schedule-reckon"])
    assert.throws(
      () => parseFleetFrame({ ...scheduleCommand, action: { kind, scheduleId: "probe" } }),
      FleetContractError,
    );
});

test("Fleet codec rejects unknown provenance, nested fields, malformed values, and limits", () => {
  const taskCommand = frames.find((frame) => frame.schema === "fleet.task.command/v1")!,
    scheduleCommand = frames.find((frame) => frame.schema === "fleet.schedule.command/v1")!,
    subject = frames.find((frame) => frame.schema === "fleet.repo.metadata.result/v1")!,
    taskResult = frames.find((frame) => frame.schema === "fleet.task.result/v1")!,
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
    { ...taskCommand, action: { kind: "task-complete", taskId: "task_abc", consentId: "old" } },
    { ...taskCommand, action: { kind: "task-complete", taskId: "task_abc", consent: true } },
    { ...taskCommand, action: { kind: "task-review-consent", taskId: "task_abc", jsonInput: "{}" } },
    { ...taskCommand, action: { kind: "task-review-consent", taskId: "task_abc", fromFile: "packet.json" } },
    { ...taskCommand, action: { kind: "host-run", command: "anything" } },
    {
      ...taskCommand,
      action: {
        kind: "task-fallback-exhausted",
        taskId: "task_abc",
        executionId: "exe_abc",
        reason: "retired action",
      },
    },
    { ...taskCommand, action: { kind: "task-create", title: "t", createMode: "admin" } },
    { ...taskCommand, action: { kind: "task-release", taskId: "task_abc", ttlMs: 1 } },
    { ...taskCommand, action: { kind: "task-transition", taskId: "task_abc", status: "cancelled", reason: "no" } },
    { ...taskCommand, action: { kind: "task-start", taskId: "task_abc", ttlMs: "forever" } },
    { ...taskCommand, action: { kind: "task-create", title: "t", riskTier: "critical" } },
    // dec_5F7E74F1 retired the module grouping and the milestone class from the create command.
    { ...taskCommand, action: { kind: "task-create", title: "t", moduleKey: "m" } },
    { ...taskCommand, action: { kind: "task-create", title: "t", taskClass: "milestone" } },
    { ...taskCommand, action: { kind: "task-submit", taskId: "task_abc", submission: "not-an-object" } },
    { ...scheduleCommand, action: { kind: "schedule-create", scheduleId: "probe" } },
    { ...scheduleCommand, action: { kind: "schedule-update", scheduleId: "probe" } },
    { ...scheduleCommand, action: { kind: "schedule-run-now", scheduleId: "probe", daemonRoute: "/tmp/socket" } },
    {
      ...scheduleCommand,
      action: {
        kind: "schedule-settle",
        scheduleId: "probe",
        claimFence: "claim",
        outcome: "passed",
        endedAt: "2099-01-01T00:00:00.000Z",
      },
    },
    { ...subject, expiresAt: "2099-01-01T08:00:00+08:00" },
    { ...taskResult, lease: {} },
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

// Retired authority is rejected at the wire boundary instead of ignored.
test("fleet metadata and commands reject static assignment and broker fields", () => {
  const metadata = frames.find((frame) => frame.schema === "fleet.repo.metadata.result/v1")!;
  const command = frames.find((frame) => frame.schema === "fleet.task.command/v1")!;
  const result = frames.find((frame) => frame.schema === "fleet.task.result/v1")!;
  for (const frame of [
    { schema: "fleet.assignment.get/v1", messageId: "old", assignmentId: "old" },
    { ...metadata, scope: { kind: "task", taskId: "task", executionId: "exe", paths: [] } },
    { ...metadata, expiresAt: "2099-01-01T00:00:00.000Z" },
    { ...command, assignmentId: "old" },
    { ...command, waitMs: 1_000 },
    { ...result, queuePosition: 1 },
    { ...result, lease: { executionId: "old" } },
  ])
    assert.throws(() => parseFleetFrame(frame), FleetContractError);
});

test("Fleet error requires and preserves the center's diagnostic message", () => {
  const error = frames.find((frame) => frame.schema === "fleet.error/v1")!;
  const message = "Runtime result construction failed: ".repeat(30);
  assert.deepEqual(parseFleetFrame(serializeFleetFrame({ ...error, message })), { ...error, message });
  const { message: omitted, ...withoutMessage } = error;
  assert.equal(typeof omitted, "string");
  assert.throws(() => parseFleetFrame(withoutMessage), FleetContractError);
});

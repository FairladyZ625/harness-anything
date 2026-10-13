// harness-test-tier: contract
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): 新 Fleet 复制 wire 合同。
// 本文件锁定 packages/daemon/src/fleet/protocol.ts 的公共编码面:basebackup / 复制流 / ACK
// 消息的正反两向合同,以及行解码器的"多帧一 chunk 合法、容量只作用于未完成 remainder"边界。
// 待对齐: protocol.ts 为 A 分片待落地模块,本文件按设计第 7 节拟名引用其导出
// (parseFleetFrame / serializeFleetFrame / FleetContractError / FleetUtf8LineDecoder /
// FLEET_FRAME_BYTES / FLEET_CHUNK_BYTES / FleetFrameV1);帧字段名为 C 分片提案,A 落地时对齐。
import assert from "node:assert/strict";
import test from "node:test";
import {
  FLEET_CHUNK_BYTES,
  FLEET_FRAME_BYTES,
  FleetContractError,
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
} from "../src/fleet/protocol.ts";

const historyId = "h".repeat(40),
  packageDigest = "a".repeat(64),
  transferId = "backup-1";
const header = {
  schema: "fleet.basebackup.header/v1",
  messageId: "m-header",
  inReplyTo: "m-request",
  transferId,
  repoId: "repo",
  historyId,
  revision: 7,
  sequence: 9,
  ledgerGeneration: 3,
  projectionSchema: 11,
  packageBytes: 4096,
  packageDigest,
} as const;
const frames = [
  {
    schema: "fleet.basebackup.request/v1",
    messageId: "m-request",
    repoId: "repo",
    historyId: null,
    fromSequence: null,
  },
  header,
  { schema: "fleet.basebackup.chunk/v1", messageId: "m-chunk", transferId, offset: 0, dataBase64: "YWJj" },
  { schema: "fleet.basebackup.finish/v1", messageId: "m-finish", transferId, packageDigest },
  { schema: "fleet.basebackup.installed/v1", messageId: "m-installed", transferId, revision: 7, sequence: 9 },
  { schema: "fleet.replication.start/v1", messageId: "m-start", repoId: "repo", historyId, fromSequence: 9 },
  {
    schema: "fleet.replication.record/v1",
    messageId: "m-record",
    sequence: 10,
    firstRevision: 8,
    lastRevision: 8,
    opId: "op-record",
    outcomeStatus: "accepted_durable",
    rejectionCode: null,
    events: [
      {
        revision: 8,
        opId: "op-record",
        type: "task_progress_appended",
        payload: { text: "progress" },
        occurredAt: "2026-10-13T12:00:00.000Z",
        recordedAt: "2026-10-13T12:00:00.001Z",
        digest: "c".repeat(64),
      },
    ],
    contentRefs: [{ ref: "objects/sha256/aa", sha256: "b".repeat(64), size: 3, mediaType: "text/markdown" }],
  },
  {
    schema: "fleet.replication.record/v1",
    messageId: "m-record-noevent",
    sequence: 11,
    firstRevision: null,
    lastRevision: null,
    opId: "op-rejected",
    outcomeStatus: "rejected",
    rejectionCode: "operation_rejected",
    events: [],
    contentRefs: [],
  },
  {
    schema: "fleet.replication.ack/v1",
    messageId: "m-ack",
    repoId: "repo",
    historyId,
    received: 11,
    durable: 11,
    applied: 10,
  },
  {
    schema: "fleet.replication.resync-required/v1",
    messageId: "m-resync",
    inReplyTo: "m-start",
    code: "cursor_out_of_window",
    message: "Acknowledged position fell outside the retention window.",
  },
] as const;

test("replication wire union round-trips every new basebackup, stream and ACK frame", () => {
  for (const frame of frames) assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame, frame.schema);
});

test("basebackup header carries whole-package identity: N/S, schema pair and package digest", () => {
  // The backup is one archive with one digest; losing any identity member must fail closed.
  for (const omitted of [
    "historyId",
    "revision",
    "sequence",
    "ledgerGeneration",
    "projectionSchema",
    "packageBytes",
    "packageDigest",
  ] as const) {
    const { [omitted]: _dropped, ...missing } = header;
    assert.throws(() => parseFleetFrame(missing), FleetContractError, `missing ${omitted}`);
  }
  for (const invalid of [
    { ...header, packageDigest: "not-a-digest" },
    { ...header, revision: -1 },
    { ...header, sequence: 1.5 },
    { ...header, historyId: 42 },
    { ...header, transferId: "../escape" },
    { ...header, extra: true },
  ])
    assert.throws(() => parseFleetFrame(invalid), FleetContractError);
  // The chunk body stays frame-bounded: package framing is byte offsets, not per-file negotiation.
  assert.throws(
    () =>
      parseFleetFrame({
        schema: "fleet.basebackup.chunk/v1",
        messageId: "m-chunk-big",
        transferId,
        offset: 0,
        dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES + 1).toString("base64"),
      }),
    FleetContractError,
  );
});

test("replication records cover no-event commits and reject identity or sequence corruption", () => {
  const record = frames.find((frame) => frame.schema === "fleet.replication.record/v1")!;
  // A rejected command with no events still advances the commit sequence (design §1 最小验证).
  assert.deepEqual(
    parseFleetFrame({
      ...record,
      messageId: "m-record-empty",
      sequence: 12,
      firstRevision: null,
      lastRevision: null,
      outcomeStatus: "rejected",
      rejectionCode: "operation_rejected",
      events: [],
    }),
    {
      ...record,
      messageId: "m-record-empty",
      sequence: 12,
      firstRevision: null,
      lastRevision: null,
      outcomeStatus: "rejected",
      rejectionCode: "operation_rejected",
      events: [],
    },
  );
  for (const invalid of [
    { ...record, sequence: -1 },
    { ...record, sequence: 0.5 },
    { ...record, lastRevision: 7 }, // interval end below its start
    { ...record, outcomeStatus: "maybe" },
    { ...record, outcomeStatus: "rejected", rejectionCode: null },
    { ...record, outcomeStatus: "accepted_durable", rejectionCode: "operation_rejected" },
    {
      ...record,
      contentRefs: [{ ref: "objects/sha256/aa", sha256: "z".repeat(64), size: 3, mediaType: "text/markdown" }],
    },
    { ...record, contentRefs: [{ ref: "../../escape", sha256: "b".repeat(64), size: 3, mediaType: "text/markdown" }] },
    { ...record, opId: "../escape" },
    { ...record, actor: { principal: { personId: "spoof" } } },
    { ...record, eventId: "spoof" },
    // Events carried by a record must sit inside its declared revision interval; the
    // receiver trusts the interval to place rows, so a stray revision corrupts the mirror.
    { ...record, events: [{ ...record.events[0], revision: 99 }] },
    { ...record, events: [{ ...record.events[0], opId: "other-op" }] },
    { ...record, events: [{ ...record.events[0], occurredAt: "2026-10-13T12:00:00+08:00" }] },
  ])
    assert.throws(() => parseFleetFrame(invalid), FleetContractError);
});

test("ACK separates received, durable and applied and requires their monotone order", () => {
  const ack = frames.find((frame) => frame.schema === "fleet.replication.ack/v1")!;
  assert.deepEqual(parseFleetFrame(serializeFleetFrame(ack)), ack);
  // The center may only recycle up to durable and readers wait on applied, so the wire keeps
  // the three positions ordered instead of trusting the receiver to send them consistently.
  for (const invalid of [
    { ...ack, durable: 12 }, // durable beyond received
    { ...ack, applied: 12 }, // applied beyond durable
    { ...ack, received: -1 },
    { ...ack, historyId: null },
    { ...ack, manifestDigest: "d".repeat(64) }, // retired manifest-based cursor vocabulary
  ])
    assert.throws(() => parseFleetFrame(invalid), FleetContractError);
});

test("resync-required keeps a closed cause vocabulary", () => {
  const resync = frames.find((frame) => frame.schema === "fleet.replication.resync-required/v1")!;
  for (const code of ["history_mismatch", "cursor_out_of_window", "basebackup_incomplete"])
    assert.deepEqual(parseFleetFrame({ ...resync, code }).code, code);
  for (const invalid of [
    { ...resync, code: "unknown" },
    { ...resync, code: null },
    { ...resync, retryable: true },
  ])
    assert.throws(() => parseFleetFrame(invalid), FleetContractError);
});

test("retired snapshot, delta, watch and manifest-ACK frames are rejected at the wire boundary", () => {
  // dec_9284BD61: one basebackup package plus one ordered stream replace the whole
  // pull/watch/manifest family; accepting any retired frame would keep two protocols alive.
  const cut = { revision: 7, headDigest: `sha256:${"b".repeat(64)}`, schemaGeneration: 11 };
  for (const retired of [
    { schema: "fleet.replica.pull/v1", messageId: "m", repoId: "repo" },
    { schema: "fleet.replica.watch/v1", messageId: "m", repoId: "repo", afterRevision: 7 },
    { schema: "fleet.replica.head-hint/v1", messageId: "m", inReplyTo: "m", repoId: "repo", cut, knownHead: cut },
    {
      schema: "fleet.replica.current/v1",
      messageId: "m",
      inReplyTo: "m",
      repoId: "repo",
      viewId: "v1",
      cut,
      knownHead: cut,
      manifestDigest: "d".repeat(64),
      readerProfile: { personId: "person-owner", nodeId: "node-one" },
      authorizationShapeDigest: "d".repeat(64),
    },
    {
      schema: "fleet.snapshot.begin/v1",
      messageId: "m",
      transferId: "t1",
      repoId: "repo",
      viewId: "v1",
      cut,
      manifest: { digest: "d".repeat(64), entryCount: 1, totalBytes: 3 },
    },
    { schema: "fleet.snapshot.page/v1", messageId: "m", transferId: "t1", pageIndex: 0, entries: [] },
    {
      schema: "fleet.snapshot.chunk/v1",
      messageId: "m",
      transferId: "t1",
      blobSha256: "b".repeat(64),
      offset: 0,
      dataBase64: "YWJj",
    },
    { schema: "fleet.snapshot.finish/v1", messageId: "m", transferId: "t1", manifestDigest: "d".repeat(64) },
    {
      schema: "fleet.delta.begin/v1",
      messageId: "m",
      transferId: "t2",
      repoId: "repo",
      viewId: "v1",
      fromCut: cut,
      toCut: cut,
      changeCount: 0,
      resultManifestDigest: "d".repeat(64),
    },
    { schema: "fleet.delta.page/v1", messageId: "m", transferId: "t2", pageIndex: 0, changes: [] },
    { schema: "fleet.delta.finish/v1", messageId: "m", transferId: "t2", resultManifestDigest: "d".repeat(64) },
    { schema: "fleet.ack/v1", messageId: "m", transferId: "t1", cut, manifestDigest: "d".repeat(64) },
  ])
    assert.throws(() => parseFleetFrame(retired), FleetContractError, retired.schema);
});

test("unchanged write-command frames still parse under the unified protocol module", () => {
  const frame = {
    schema: "fleet.task.command/v1",
    messageId: "m-task",
    writerEpoch: 1,
    opId: "op-task",
    repoId: "repo",
    taskId: "task_abc",
    action: { kind: "task-start", taskId: "task_abc", executionId: "exe_abc" },
    docChanges: null,
    mirrorBaseCut: null,
    accessToken: "owner-session",
  };
  assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame);
  assert.throws(
    () => parseFleetFrame({ ...frame, action: { ...frame.action, actor: { principal: { personId: "spoof" } } } }),
    FleetContractError,
  );
  assert.throws(
    () =>
      parseFleetFrame(
        `{"schema":"fleet.replication.record/v1","messageId":"m","contentRefs":[{"ref":"${"x".repeat(FLEET_FRAME_BYTES)}"}]}`,
      ),
    /frame exceeds/u,
  );
});

test("line decoder accepts many frames in one chunk and bounds only the pending remainder", () => {
  const request = frames[0]!,
    start = frames.find((frame) => frame.schema === "fleet.replication.start/v1")!,
    installed = frames.find((frame) => frame.schema === "fleet.basebackup.installed/v1")!;
  // Several complete frames sharing one transport chunk are all legal at once.
  const decoder = new FleetUtf8LineDecoder(),
    chunk = Buffer.from([request, start, installed].map(serializeFleetFrame).join(""));
  const lines = decoder.push(chunk);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(parseFleetFrame), [request, start, installed]);
  // A frame split across chunks is held as an incomplete remainder, then completes.
  const split = new FleetUtf8LineDecoder(),
    bytes = Buffer.from(serializeFleetFrame(start)),
    half = Math.floor(bytes.length / 2);
  assert.deepEqual(split.push(bytes.subarray(0, half)), []);
  assert.deepEqual(split.push(bytes.subarray(half)).map(parseFleetFrame), [start]);
  assert.deepEqual(split.finish(), []);
  // The capacity bound applies to the unfinished remainder, not to the chunk that
  // carried several complete frames (backend boundary: complete units first).
  const legal = new FleetUtf8LineDecoder();
  assert.equal(legal.push(Buffer.from(`${serializeFleetFrame(request)}${serializeFleetFrame(start)}`)).length, 2);
  const bounded = new FleetUtf8LineDecoder();
  assert.throws(
    () => bounded.push(Buffer.concat([Buffer.from(`{"padding":"`), Buffer.alloc(FLEET_FRAME_BYTES + 1, 0x61)])),
    /exceeds/u,
  );
  // Truncated streams surface their own error instead of a silent partial frame.
  const truncated = new FleetUtf8LineDecoder();
  truncated.push(Buffer.from(serializeFleetFrame(start).slice(0, -5)));
  assert.throws(() => truncated.finish(), /mid-frame/u);
  assert.throws(() => new FleetUtf8LineDecoder().push(Buffer.from([0xc3, 0x28])), /encoded data/u);
});

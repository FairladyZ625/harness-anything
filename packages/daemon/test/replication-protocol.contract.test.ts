// harness-test-tier: contract
// dec_9284BD6119D453EEECEED62450 分片 C: 新复制 wire 合同(对齐 A 分片落地的 protocol.ts)。
// 锁定公共编码面的正反两向合同:replica.* 帧族、BaseBackupMetadata 身份、提交易形
// parseReplicationCommit 的区间一致性,以及 ReplicationDecoder 的"多帧一 chunk 合法、
// 容量只作用于未完成 remainder"边界。A 分片的核心集成测试覆盖快乐路径;本文件补齐
// 合同层负例:未知类型、身份字段损坏、超限数据、旧 fleet 帧不是复制帧、区间不一致的提交。
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLICATION_CHUNK_BYTES,
  REPLICATION_FRAME_BYTES,
  ReplicationDecoder,
  parseReplicationCommit,
  parseReplicationFrame,
  serializeReplicationFrame,
  type ReplicationFrame,
} from "../src/fleet/protocol.ts";

const position = { history: "history-a", sequence: 9, revision: 7 } as const,
  digest = `sha256:${"a".repeat(64)}`,
  metadata = {
    schema: "fleet-basebackup/v2",
    repoId: "replica-repo",
    position,
    ledgerGeneration: 3,
    projectionSchema: 11,
  } as const;
const frames: readonly ReplicationFrame[] = [
  { type: "replica.start", position: null },
  { type: "replica.start", position },
  { type: "replica.backup", metadata, size: 4096, sha256: "b".repeat(64) },
  { type: "replica.data", offset: 0, data: Buffer.from("abc").toString("base64") },
  { type: "replica.backup.end" },
  { type: "replica.commit", size: 128 },
  { type: "replica.object", sha256: "c".repeat(64), size: 3 },
  { type: "replica.object.end" },
  { type: "replica.commit.end" },
  { type: "replica.ack", durable: position, applied: position },
  { type: "replica.progress", head: position },
  { type: "replica.resync", reason: "replication window unavailable" },
];

test("replication wire union round-trips every replica frame", () => {
  for (const frame of frames)
    assert.deepEqual(parseReplicationFrame(serializeReplicationFrame(frame).trimEnd()), frame, frame.type);
});

test("backup frames carry whole-package identity and reject damaged members", () => {
  const backup = frames.find((frame) => frame.type === "replica.backup")!;
  for (const invalid of [
    { ...backup, sha256: "not-a-hash" },
    { ...backup, sha256: "B".repeat(64) },
    { ...backup, size: -1 },
    { ...backup, size: 1.5 },
    { ...backup, metadata: { ...metadata, schema: "fleet-basebackup/v1" } },
    { ...backup, metadata: { ...metadata, position: { history: "h", sequence: 9 } } },
    { ...backup, metadata: { ...metadata, position: { history: "h", sequence: 9, revision: 7, extra: 1 } } },
    { ...backup, metadata: { ...metadata, repoId: "" } },
    { ...backup, metadata: { ...metadata, ledgerGeneration: -2 } },
    { ...backup, extra: true },
  ])
    assert.throws(() => parseReplicationFrame(JSON.stringify(invalid)), undefined, JSON.stringify(invalid));
  // Data stays frame-bounded; the capacity bound is per chunk, package framing is byte offsets.
  assert.throws(() => {
    const oversized = {
      type: "replica.data",
      offset: 0,
      data: Buffer.alloc(REPLICATION_CHUNK_BYTES + 1).toString("base64"),
    };
    parseReplicationFrame(JSON.stringify(oversized));
  });
  assert.throws(() => parseReplicationFrame(JSON.stringify({ type: "replica.data", offset: -1, data: "YWJj" })));
  assert.throws(() => parseReplicationFrame(JSON.stringify({ type: "replica.data", offset: 0, data: "not base64!" })));
});

test("ACK and progress positions are complete ordered identities", () => {
  const ack = frames.find((frame) => frame.type === "replica.ack")!,
    progress = frames.find((frame) => frame.type === "replica.progress")!;
  for (const invalid of [
    { ...ack, durable: { history: "h", sequence: 1 } },
    { ...ack, applied: null },
    { ...ack, received: position },
    { ...progress, head: { history: "", sequence: 0, revision: 0 } },
    { type: "replica.resync", reason: "" },
    { type: "replica.resync", reason: null },
  ])
    assert.throws(() => parseReplicationFrame(JSON.stringify(invalid)));
});

test("retired fleet frames are not replication frames and neither are unknown types", () => {
  const cut = { revision: 7, headDigest: `sha256:${"b".repeat(64)}`, schemaGeneration: 11 };
  for (const foreign of [
    { schema: "fleet.replica.pull/v1", messageId: "m", repoId: "repo" },
    { schema: "fleet.replica.watch/v1", messageId: "m", repoId: "repo", afterRevision: 7 },
    {
      schema: "fleet.snapshot.begin/v1",
      messageId: "m",
      transferId: "t",
      repoId: "repo",
      viewId: "v",
      cut,
      manifest: { digest: "d".repeat(64), entryCount: 1, totalBytes: 3 },
    },
    { schema: "fleet.delta.finish/v1", messageId: "m", transferId: "t", resultManifestDigest: "d".repeat(64) },
    { schema: "fleet.ack/v1", messageId: "m", transferId: "t", cut, manifestDigest: "d".repeat(64) },
    {
      schema: "fleet.task.command/v1",
      messageId: "m",
      writerEpoch: 1,
      opId: "op",
      repoId: "repo",
      taskId: null,
      action: { kind: "task-start" },
      docChanges: null,
      mirrorBaseCut: null,
    },
    { type: "replica.pull" },
    { type: "replica.snapshot" },
    { type: 42 },
    {},
  ])
    assert.throws(() => parseReplicationFrame(JSON.stringify(foreign)), undefined, JSON.stringify(foreign));
});

const eventRow = (revision: number) => ({
    revision,
    opId: `op-${revision}`,
    eventJson: JSON.stringify({ eventId: `event-${revision}` }),
    occurredAt: "2026-10-13T12:00:00.000Z",
    recordedAt: "2026-10-13T12:00:00.001Z",
    digest,
  }),
  outcomeFor = (rows: ReturnType<typeof eventRow>[], rejectionCode: string | null) => ({
    opId: rows.at(-1)?.opId ?? "op-rejected",
    status: rejectionCode === null ? "accepted_durable" : "rejected",
    firstRevision: rows[0]?.revision ?? null,
    lastRevision: rows.at(-1)?.revision ?? null,
    intentDigest: digest,
    summary: "commit summary",
    rejectionCode,
    recordedAt: "2026-10-13T12:00:00.002Z",
    memberOpIds: rows.map((row) => row.opId),
  });

test("commit envelopes cover eventless outcomes and reject interval corruption", () => {
  const eventless = {
      position: { history: "history-a", sequence: 11, revision: 8 },
      events: [],
      outcome: outcomeFor([], "operation_rejected"),
      writer: { repoId: "replica-repo", holder: "primary", epoch: 1 },
    },
    // S advances on a rejected command while the event revision stays put (design §1 最小验证).
    parsed = parseReplicationCommit(Buffer.from(JSON.stringify(eventless)));
  assert.equal(parsed.outcome?.status, "rejected");
  assert.equal(parsed.events.length, 0);
  const rows = [eventRow(9), eventRow(10)],
    withEvents = {
      position: { history: "history-a", sequence: 12, revision: 10 },
      events: rows,
      outcome: outcomeFor(rows, null),
      writer: null,
    };
  assert.equal(parseReplicationCommit(Buffer.from(JSON.stringify(withEvents))).events.length, 2);
  for (const invalid of [
    // Revision interval must be contiguous and end exactly at the position revision.
    { ...withEvents, events: [eventRow(9), eventRow(11)] },
    { ...withEvents, position: { history: "history-a", sequence: 12, revision: 11 } },
    // Outcome bounds must bracket exactly the carried events, member by member.
    { ...withEvents, outcome: { ...outcomeFor(rows, null), lastRevision: 9 } },
    { ...withEvents, outcome: { ...outcomeFor(rows, null), memberOpIds: ["op-9"] } },
    { ...withEvents, outcome: { ...outcomeFor(rows, null), status: "maybe" } },
    // An outcome-less envelope cannot carry events.
    { ...withEvents, outcome: null },
    { ...withEvents, events: [{ ...rows[0]!, digest: "f".repeat(71) }] },
    { ...withEvents, events: [{ ...rows[0]!, revision: 1.5 }] },
  ])
    assert.throws(
      () => parseReplicationCommit(Buffer.from(JSON.stringify(invalid))),
      undefined,
      JSON.stringify(invalid).slice(0, 120),
    );
});

test("decoder accepts many frames per chunk and bounds only the pending remainder", () => {
  const start = frames[0]!,
    backup = frames[2]!,
    ack = frames.find((frame) => frame.type === "replica.ack")!;
  // Several complete frames sharing one transport chunk are all legal at once.
  const decoder = new ReplicationDecoder(),
    chunk = Buffer.from([start, backup, ack].map((frame) => serializeReplicationFrame(frame)).join(""));
  assert.deepEqual(decoder.push(chunk), [start, backup, ack]);
  // A frame split across chunks is held as an incomplete remainder, then completes.
  const split = new ReplicationDecoder(),
    bytes = Buffer.from(serializeReplicationFrame(ack)),
    half = Math.floor(bytes.length / 2);
  assert.deepEqual(split.push(bytes.subarray(0, half)), []);
  assert.deepEqual(split.push(bytes.subarray(half)), [ack]);
  split.finish();
  // The capacity bound applies to the unfinished remainder, not to the chunk that
  // carried several complete frames (complete units first, then bound the remainder).
  assert.equal(
    new ReplicationDecoder().push(
      Buffer.from(`${serializeReplicationFrame(start)}${serializeReplicationFrame(backup)}`),
    ).length,
    2,
  );
  assert.throws(() =>
    new ReplicationDecoder().push(
      Buffer.concat([
        Buffer.from(`{"type":"replica.resync","reason":"`),
        Buffer.alloc(REPLICATION_FRAME_BYTES + 1, 0x61),
      ]),
    ),
  );
  // Truncated streams surface their own error instead of a silent partial frame.
  const truncated = new ReplicationDecoder();
  truncated.push(Buffer.from(serializeReplicationFrame(ack).slice(0, -5)));
  assert.throws(() => truncated.finish());
  assert.throws(() => new ReplicationDecoder().push(Buffer.from([0xc3, 0x28])));
  // The line serializer keeps the frame budget itself.
  assert.throws(() =>
    serializeReplicationFrame({ type: "replica.resync", reason: "x".repeat(REPLICATION_FRAME_BYTES) }),
  );
});

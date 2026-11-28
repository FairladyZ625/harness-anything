// harness-test-tier: contract
// dec_9284BD6119D453EEECEED62450 分片 C: 新复制 wire 合同(对齐 A 分片落地的 protocol.ts)。
// 锁定公共编码面的正反两向合同:replica.* 帧族、BaseBackupMetadata 身份、提交易形
// parseReplicationCommit 的区间一致性,以及 ReplicationDecoder 的"多帧一 chunk 合法、
// 容量只作用于未完成 remainder"边界。A 分片的核心集成测试覆盖快乐路径;本文件补齐
// 合同层负例:未知类型、身份字段损坏、超限数据、旧 fleet 帧不是复制帧、区间不一致的提交。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BASEBACKUP_V4_CAPABILITY,
  BINARY_DATA_FRAME_TAG,
  BINARY_DATA_HEADER_BYTES,
  CENTER_MOVED_DETAILS_CAPABILITY,
  REPLICATION_BINARY_CHUNK_BYTES,
  REPLICATION_CHUNK_BYTES,
  REPLICATION_FRAME_BYTES,
  REPLICATION_OBJECT_MANIFEST_BATCH,
  ReplicationDecoder,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  parseReplicationCommit,
  parseReplicationFrame,
  serializeReplicationFrame,
  serializeReplicationWireFrame,
  type ReplicationFrame,
} from "../src/fleet-sync/fleet/protocol.ts";
import {
  sendCenterMovedReplicaFailure,
  sendCenterMovedReplicaReject,
} from "../src/daemon-host/fleet/center-listener-errors.ts";

const position = { history: "history-a", sequence: 9, revision: 7 } as const,
  digest = `sha256:${"a".repeat(64)}`,
  metadata = {
    schema: "fleet-basebackup/v3",
    readerProfile: { personId: "owner", nodeId: "node" },
    repoId: "replica-repo",
    position,
    ledgerGeneration: 3,
    projectionSchema: 11,
  } as const;
const frames: readonly ReplicationFrame[] = [
  {
    type: "replica.start",
    repoId: "repo",
    position,
    edgeBuildCommit: "5b496c24",
    taskEventShapeVersion: 1,
  },
  {
    type: "replica.accept",
    centerBuildCommit: "86d1398",
    taskEventShapeVersion: 2,
  },
  {
    type: "replica.reject",
    code: "edge_upgrade_required",
    message: "Upgrade to 86d1398",
    centerBuildCommit: "86d1398",
    taskEventShapeVersion: 2,
  },
  { type: "replica.failure", code: "invalid_schema", message: "completion contract is invalid" },
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

test("the center can recognize a pre-versioned replica start and reject it explicitly", () => {
  assert.deepEqual(parseReplicationFrame('{"type":"replica.start","repoId":"repo","position":null}'), {
    type: "replica.start",
    repoId: "repo",
    position: null,
  });
});

test("a v2 base-backup frame names the required center upgrade", () => {
  assert.throws(
    () =>
      parseReplicationFrame(
        JSON.stringify({
          type: "replica.backup",
          metadata: {
            ...metadata,
            schema: "fleet-basebackup/v2",
          },
          size: 0,
          sha256: "a".repeat(64),
        }),
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "center_upgrade_required");
      assert.match(String(error), /fleet-basebackup\/v2/u);
      return true;
    },
  );
});

test("decode failures summarize the offending frame across chunks without logging its payload", () => {
  const invalid = { type: "replica.unknown", data: "do-not-log-this-content" },
    line = JSON.stringify(invalid),
    decoder = new ReplicationDecoder();
  // The chunk starts with a legal frame and half the bad frame. Summarize only the bad frame
  // when it completes, rather than a transport chunk or the preceding valid frame.
  decoder.push(Buffer.from(`${serializeReplicationFrame(frames[0]!)}${line.slice(0, 10)}`));
  assert.throws(
    () => decoder.push(Buffer.from(`${line.slice(10)}\n`)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.deepEqual(JSON.parse(error.message.split("; frame=")[1]!), {
        bytes: Buffer.byteLength(line),
        type: "replica.unknown",
        schema: null,
        metadataSchema: null,
      });
      assert.doesNotMatch(error.message, /do-not-log-this-content/u);
      return true;
    },
  );
  assert.throws(() => parseReplicationFrame("do-not-log-this-content"), /invalid replication JSON; frame=/u);
  assert.throws(
    () => parseReplicationFrame(JSON.stringify({ type: "x".repeat(1024) })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(JSON.parse(error.message.split("; frame=")[1]!).type.length, 128);
      return true;
    },
  );
});

test("backup frames carry whole-package identity and reject damaged members", () => {
  const backup = frames.find((frame) => frame.type === "replica.backup")!;
  for (const invalid of [
    { ...backup, sha256: "not-a-hash" },
    { ...backup, sha256: "B".repeat(64) },
    { ...backup, size: -1 },
    { ...backup, size: 1.5 },
    { ...backup, metadata: { ...metadata, schema: "fleet-basebackup/v1" } },
    { ...backup, metadata: { ...metadata, schema: "fleet-basebackup/v2" } },
    { ...backup, metadata: { ...metadata, position: { history: "h", sequence: 9 } } },
    { ...backup, metadata: { ...metadata, position: { history: "h", sequence: 9, revision: 7, extra: 1 } } },
    { ...backup, metadata: { ...metadata, readerProfile: { personId: "", nodeId: "node" } } },
    { ...backup, metadata: { ...metadata, readerProfile: { personId: "owner" } } },
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
  assert.throws(
    () => new ReplicationDecoder().push(Buffer.from([0xc3, 0x28])),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_ENCODING_INVALID_ENCODED_DATA");
      assert.match(String(error), /"chunkBytes":2/u);
      return true;
    },
  );
  // The line serializer keeps the frame budget itself.
  assert.throws(() =>
    serializeReplicationFrame({ type: "replica.resync", reason: "x".repeat(REPLICATION_FRAME_BYTES) }),
  );
});

test("snapshot-resume/v1 protocol extensions round-trip and preserve legacy backward compatibility", () => {
  const extendedFrames: readonly ReplicationFrame[] = [
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      edgeBuildCommit: "5b496c24",
      taskEventShapeVersion: 1,
      capabilities: [SNAPSHOT_RESUME_CAPABILITY],
      resumeSnapshot: { snapshotId: "snap-123", offset: 65536 },
    },
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      capabilities: [SNAPSHOT_RESUME_CAPABILITY],
    },
    {
      type: "replica.accept",
      centerBuildCommit: "86d1398",
      taskEventShapeVersion: 2,
      capabilities: [SNAPSHOT_RESUME_CAPABILITY],
    },
    {
      type: "replica.backup",
      metadata,
      size: 4096,
      sha256: "b".repeat(64),
      snapshotId: "snap-123",
      resumeOffset: 1024,
    },
  ];
  for (const frame of extendedFrames) {
    assert.deepEqual(parseReplicationFrame(serializeReplicationFrame(frame).trimEnd()), frame, frame.type);
  }
  // Legacy 4-key/5-key replica.start still parses cleanly.
  assert.deepEqual(
    parseReplicationFrame(
      JSON.stringify({
        type: "replica.start",
        repoId: "repo",
        position: null,
        edgeBuildCommit: null,
        taskEventShapeVersion: 1,
      }),
    ),
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      edgeBuildCommit: null,
      taskEventShapeVersion: 1,
    },
  );
  // Reject invalid resumeOffset > size, negative offset, unknown keys, or mismatched version fields.
  for (const invalid of [
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      edgeBuildCommit: null,
    },
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      resumeSnapshot: { snapshotId: "snap-1", offset: -1 },
    },
    {
      type: "replica.start",
      repoId: "repo",
      position: null,
      extra: true,
    },
    {
      type: "replica.accept",
      centerBuildCommit: null,
      taskEventShapeVersion: 1,
      capabilities: ["ok"],
      extra: 1,
    },
    {
      type: "replica.backup",
      metadata,
      size: 100,
      sha256: "b".repeat(64),
      snapshotId: "snap-1",
      resumeOffset: 101,
    },
    {
      type: "replica.backup",
      metadata,
      size: 100,
      sha256: "b".repeat(64),
      snapshotId: "snap-1",
    },
  ]) {
    assert.throws(() => parseReplicationFrame(JSON.stringify(invalid)), undefined, JSON.stringify(invalid));
  }
});

test("snapshot-binary-wire/v1 and snapshot-object-pack/v1 round-trip mixed binary and JSON frames", () => {
  const payload = Buffer.from("binary-snapshot-payload-\x00\xff\x7b", "latin1");
  const binFrame: ReplicationFrame = { type: "replica.data.bin", offset: 1024 * 1024, data: payload };
  const backupPack: ReplicationFrame = {
    type: "replica.backup",
    metadata,
    size: 4096,
    sha256: "b".repeat(64),
    snapshotId: "snap-pack-1",
    resumeOffset: 0,
    objectsMode: "pack",
    objectCount: 2,
  };
  const manifest: ReplicationFrame = {
    type: "replica.objects.manifest",
    entries: [
      { sha256: "a".repeat(64), size: 12 },
      { sha256: "c".repeat(64), size: 34 },
    ],
    done: true,
  };
  const want: ReplicationFrame = { type: "replica.objects.want", sha256s: ["c".repeat(64)] };
  const packHeader: ReplicationFrame = { type: "replica.objects.pack", totalBytes: 72 + 34, count: 1 };
  const packEnd: ReplicationFrame = { type: "replica.objects.pack.end" };

  for (const jsonFrame of [backupPack, manifest, want, packHeader, packEnd]) {
    assert.deepEqual(parseReplicationFrame(serializeReplicationFrame(jsonFrame).trimEnd()), jsonFrame);
  }

  const wireBin = serializeReplicationWireFrame(binFrame);
  assert.ok(Buffer.isBuffer(wireBin));
  assert.equal(wireBin[0], BINARY_DATA_FRAME_TAG);
  assert.equal(wireBin.length, BINARY_DATA_HEADER_BYTES + payload.length);
  assert.throws(() => serializeReplicationFrame(binFrame), /binary wire/u);

  const combined = Buffer.concat([
    Buffer.from(serializeReplicationFrame(backupPack)),
    wireBin,
    Buffer.from(serializeReplicationFrame(manifest)),
  ]);
  const decoder = new ReplicationDecoder();
  const decoded: ReplicationFrame[] = [];
  for (let i = 0; i < combined.length; i += 7) {
    decoded.push(...decoder.push(combined.subarray(i, i + 7)));
  }
  decoder.finish();
  assert.equal(decoded.length, 3);
  assert.deepEqual(decoded[0], backupPack);
  assert.equal(decoded[1]!.type, "replica.data.bin");
  if (decoded[1]!.type === "replica.data.bin") {
    assert.equal(decoded[1]!.offset, 1024 * 1024);
    assert.deepEqual(Buffer.from(decoded[1]!.data), payload);
  }
  assert.deepEqual(decoded[2], manifest);

  // Reject oversized or zero-length binary frames and invalid capability strings.
  const badLen = Buffer.alloc(BINARY_DATA_HEADER_BYTES);
  badLen[0] = BINARY_DATA_FRAME_TAG;
  badLen.writeUInt32BE(REPLICATION_BINARY_CHUNK_BYTES + 1, 9);
  assert.throws(() => new ReplicationDecoder().push(badLen), /invalid binary replication frame/u);
  assert.equal(SNAPSHOT_BINARY_WIRE_CAPABILITY, "snapshot-binary-wire/v1");
  assert.equal(SNAPSHOT_OBJECT_PACK_CAPABILITY, "snapshot-object-pack/v1");
  assert.equal(SNAPSHOT_RESUME_CAPABILITY, "snapshot-resume/v1");
  assert.equal(CENTER_MOVED_DETAILS_CAPABILITY, "center-moved-details/v1");
});

test("center-moved-details/v1 capability preserves exact N-1 baseline reject/failure frames for legacy edges", async () => {
  const details = {
      newExternalUrl: "https://center-b.example.invalid:9443",
      newLoginUrl: "https://login-b.example.invalid",
      newEpoch: 5,
      spkiSha256: `sha256:${"d".repeat(64)}`,
    },
    error = Object.assign(new Error("The center has moved to center-b."), {
      code: "CENTER_MOVED",
      centerMoved: details,
    }),
    sent: ReplicationFrame[] = [],
    peer = {
      send: async (frame: ReplicationFrame) => {
        sent.push(frame);
      },
      receive: async () => {
        throw new Error("unused");
      },
    };

  // N-1 edge without center-moved-details/v1 capability: exact baseline key count and zero centerMoved key.
  await sendCenterMovedReplicaReject({
    peer,
    error,
    centerBuildCommit: "abcdef1",
    taskEventShapeVersion: 1,
    includeCenterMovedDetails: false,
  });
  await sendCenterMovedReplicaFailure({ peer, error, includeCenterMovedDetails: false });
  assert.equal(sent.length, 2);
  const legacyReject = JSON.parse(serializeReplicationFrame(sent[0]!).trimEnd()) as Record<string, unknown>,
    legacyFailure = JSON.parse(serializeReplicationFrame(sent[1]!).trimEnd()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(legacyReject).sort(), [
    "centerBuildCommit",
    "code",
    "message",
    "taskEventShapeVersion",
    "type",
  ]);
  assert.equal(Object.hasOwn(legacyReject, "centerMoved"), false);
  assert.equal(legacyReject.code, "CENTER_MOVED");
  assert.deepEqual(Object.keys(legacyFailure).sort(), ["code", "message", "type"]);
  assert.equal(Object.hasOwn(legacyFailure, "centerMoved"), false);
  assert.equal(legacyFailure.code, "CENTER_MOVED");
  assert.deepEqual(parseReplicationFrame(JSON.stringify(legacyReject)), sent[0]);
  assert.deepEqual(parseReplicationFrame(JSON.stringify(legacyFailure)), sent[1]);

  // Capable edge declaring center-moved-details/v1: receives structured centerMoved metadata.
  await sendCenterMovedReplicaReject({
    peer,
    error,
    centerBuildCommit: "abcdef1",
    taskEventShapeVersion: 1,
    includeCenterMovedDetails: true,
  });
  await sendCenterMovedReplicaFailure({ peer, error, includeCenterMovedDetails: true });
  assert.equal(sent.length, 4);
  const modernReject = parseReplicationFrame(serializeReplicationFrame(sent[2]!).trimEnd()),
    modernFailure = parseReplicationFrame(serializeReplicationFrame(sent[3]!).trimEnd());
  assert.equal(modernReject.type, "replica.reject");
  assert.deepEqual(modernReject.type === "replica.reject" ? modernReject.centerMoved : null, details);
  assert.equal(modernFailure.type, "replica.failure");
  assert.deepEqual(modernFailure.type === "replica.failure" ? modernFailure.centerMoved : null, details);
});

test("fleet-basebackup/v4 supports v4 metadata schema, hot/cold manifest tiers, and 4096-entry manifest/want batches", () => {
  assert.equal(BASEBACKUP_V4_CAPABILITY, "fleet-basebackup/v4");
  assert.equal(REPLICATION_OBJECT_MANIFEST_BATCH, 4096);
  const v4Backup: ReplicationFrame = {
    type: "replica.backup",
    metadata: { ...metadata, schema: "fleet-basebackup/v4" },
    size: 8192,
    sha256: "e".repeat(64),
    objectsMode: "pack",
    objectCount: 4096,
  };
  assert.deepEqual(parseReplicationFrame(serializeReplicationFrame(v4Backup).trimEnd()), v4Backup);

  const entries = Array.from({ length: 4096 }, (_, i) => ({
    sha256: i.toString(16).padStart(64, "0"),
    size: i + 1,
    tier: i % 2 === 0 ? ("hot" as const) : ("cold" as const),
  }));
  const largeManifest: ReplicationFrame = { type: "replica.objects.manifest", entries, done: true };
  const largeWant: ReplicationFrame = {
    type: "replica.objects.want",
    sha256s: entries.map((e) => e.sha256),
  };
  const decoder = new ReplicationDecoder();
  const decoded = decoder.push(
    Buffer.concat([
      Buffer.from(serializeReplicationFrame(largeManifest)),
      Buffer.from(serializeReplicationFrame(largeWant)),
    ]),
  );
  decoder.finish();
  assert.deepEqual(decoded, [largeManifest, largeWant]);

  // Reject invalid tier values and >4096 entries.
  assert.throws(() =>
    parseReplicationFrame(
      JSON.stringify({
        type: "replica.objects.manifest",
        entries: [{ sha256: "a".repeat(64), size: 1, tier: "warm" }],
        done: true,
      }),
    ),
  );
  assert.throws(() =>
    parseReplicationFrame(
      JSON.stringify({
        type: "replica.objects.want",
        sha256s: [...entries.map((e) => e.sha256), "f".repeat(64)],
      }),
    ),
  );
});

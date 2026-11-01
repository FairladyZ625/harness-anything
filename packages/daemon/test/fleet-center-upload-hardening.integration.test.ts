// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { resolveHarnessLayout, sha256Bytes } from "@harness-anything/kernel";
import { FLEET_UPLOAD_MAX_BYTES, type FleetFrameV1 } from "../src/fleet/command-protocol.ts";
import { fleetFixture, rawPeer, replicaQuota } from "./fleet-tls-session.fixture.ts";

const beginFrame = (repoId: string, messageId: string, size: number, seed = messageId): FleetFrameV1 => ({
  schema: "fleet.upload.begin/v1",
  opId: "op-upload-test",
  messageId,
  repoId,
  content: { sha256: sha256Bytes(Buffer.from(seed)), size, mediaType: "text/plain" },
});

const chunkFrame = (uploadId: string, offset: number, body: string): FleetFrameV1 => ({
  schema: "fleet.upload.chunk/v1",
  opId: "op-upload-test",
  messageId: `chunk-${offset}-${body}`,
  uploadId,
  offset,
  dataBase64: Buffer.from(body, "utf8").toString("base64"),
});

const errorCode = (frame: FleetFrameV1): string => {
  assert.equal(frame.schema, "fleet.error/v1", JSON.stringify(frame));
  if (frame.schema !== "fleet.error/v1") throw new Error("unreachable");
  return frame.code;
};

test("upload begin and chunk require the node owner's repository-read grant", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  mkdirSync(fixture.stateRoot, { recursive: true });
  writeFileSync(
    path.join(fixture.stateRoot, "state.json"),
    JSON.stringify({
      uploads: {
        "own-upload": {
          nodeId: fixture.subject.nodeId,
          repoId: fixture.subject.repoId,
          content: { sha256: "a".repeat(64), size: 4, mediaType: "text/plain" },
          descriptor: null,
        },
      },
    }),
  );
  const center = await fixture.center(),
    nodeId = fixture.subject.nodeId,
    repoId = fixture.subject.repoId;
  // Positive control first: a granted owner uploads through the same port.
  const granted = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
    allowed = await granted.request(beginFrame(repoId, "granted-begin", 5, "granted"));
  assert.equal(allowed.schema, "fleet.upload.ready/v1", JSON.stringify(allowed));
  granted.close();
  fixture.owners.keycloak.revoke("person-owner", fixture.subject.repoId, ["repository-read"]);
  const denied = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret");
  assert.equal(
    errorCode(await denied.request(beginFrame(repoId, "denied-begin", 5, "denied"))),
    "authorization_denied",
  );
  // The seeded unfinished upload belongs to this node, so only the repository grant is missing.
  assert.equal(errorCode(await denied.request(chunkFrame("own-upload", 0, "abcd"))), "authorization_denied");
  denied.close();
});

test("a chunk may never write past the declared upload size", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    ready = await peer.request(beginFrame(fixture.subject.repoId, "bounded-begin", 4, "bounded"));
  assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
  if (ready.schema !== "fleet.upload.ready/v1") return;
  // A chunk that fills the declaration exactly is still accepted.
  const exact = await peer.request(chunkFrame(ready.uploadId, 0, "abcd"));
  assert.equal(exact.schema, "fleet.upload.ready/v1", JSON.stringify(exact));
  const past = await peer.request(chunkFrame(ready.uploadId, 0, "abcdefgh"));
  assert.equal(errorCode(past), "upload_oversize");
  // The rejected chunk left the durable prefix untouched.
  const replay = await peer.request(chunkFrame(ready.uploadId, 0, "abcd"));
  assert.equal(replay.schema, "fleet.upload.ready/v1", JSON.stringify(replay));
  peer.close();
});

test("upload declarations above the wire bound are invalid frames", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
  // An honest edge client refuses to even send an over-bound declaration; a hostile client that
  // skips its own validation still meets the same bound at the center's frame parser.
  await assert.rejects(
    peer.request(beginFrame(fixture.subject.repoId, "huge-begin", FLEET_UPLOAD_MAX_BYTES + 1)),
    /violates closed schema fleet.upload.begin/u,
  );
  assert.equal(
    errorCode(await peer.raw(beginFrame(fixture.subject.repoId, "huge-begin-raw", FLEET_UPLOAD_MAX_BYTES + 1))),
    "invalid_frame",
  );
  // A declaration at the bound is admitted; no bytes need to follow it.
  const bounded = await peer.request(
    beginFrame(fixture.subject.repoId, "bound-begin", FLEET_UPLOAD_MAX_BYTES, "bound"),
  );
  assert.equal(bounded.schema, "fleet.upload.ready/v1", JSON.stringify(bounded));
  peer.close();
});

test("one node cannot hold more than its share of active uploads across sessions", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    repoId = fixture.subject.repoId,
    first = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    second = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
  for (let index = 0; index < 8; index += 1) {
    for (const [label, peer] of [
      ["first", first],
      ["second", second],
    ] as const) {
      const ready = await peer.request(beginFrame(repoId, `cap-${label}-${index}`, 9, `cap-${label}-${index}`));
      assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
    }
  }
  // Sixteen active uploads are already this node's; a fresh session's first begin is refused even
  // though its own session window and the global recovery window both have room.
  const third = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    refused = await third.request(beginFrame(repoId, "cap-seventeenth", 9, "cap-seventeenth"));
  assert.equal(errorCode(refused), "busy");
  if (refused.schema === "fleet.error/v1") assert.match(refused.message, /16 active uploads/u);
  first.close();
  second.close();
  third.close();
});

test("an unauthenticated connection is cut after the hello window", { timeout: 15_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(replicaQuota, { helloTimeoutMs: 300 }),
    socket = await new Promise<TLSSocket>((resolve, reject) => {
      const candidate = connect(
        { host: "127.0.0.1", port: center.port, ca: fixture.cert, servername: "localhost" },
        () => resolve(candidate),
      );
      candidate.once("error", reject);
    });
  fixture.track(() => socket.destroy());
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await closed;
  // An authenticated session on the same center is unaffected: the window covers only the hello.
  const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    ready = await peer.request(beginFrame(fixture.subject.repoId, "after-idle-cut", 5, "after-idle-cut"));
  assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
  peer.close();
});

test("rotating the claimed node id cannot refill the hello failure budget", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center();
  // Every hello claims a different, unregistered id from the same source address.
  for (let attempt = 0; attempt < 5; attempt += 1)
    await assert.rejects(
      rawPeer(fixture.track, center.port, fixture.cert, `rotated-${attempt}`, "wrong-machine-secret"),
      /authentication_failed/u,
    );
  // The real node's id was never claimed, yet the shared source budget is spent: its valid credential
  // is refused locally instead of buying a sixth credential check.
  await assert.rejects(
    rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    /authentication_failed/u,
  );
});

test("a third party's failed hellos do not lock a node out from another source", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  // A dual-stack listener lets one center see ::1 and 127.0.0.1 as distinct pre-authentication sources.
  let center;
  try {
    center = await fixture.center(replicaQuota, { hostname: "::" });
  } catch {
    t.skip("requires dual-stack loopback (IPv4 and IPv6 on one listener) to present two peer addresses");
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1)
    await assert.rejects(
      rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "wrong-machine-secret", {
        host: "::1",
      }),
      /authentication_failed/u,
    );
  // A different source address carries its own budget: the real node still authenticates.
  let peer;
  try {
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "EADDRNOTAVAIL") {
      t.skip("requires dual-stack loopback (IPv4 and IPv6 on one listener) to present two peer addresses");
      return;
    }
    throw error;
  }
  const ready = await peer.request(beginFrame(fixture.subject.repoId, "source-budget-peer", 5, "source-budget-peer"));
  assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
  peer.close();
});

test(
  "completed uploads release recovery capacity while finish replay remains idempotent",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
    let first: Extract<FleetFrameV1, { schema: "fleet.upload.result/v1" }> | undefined;
    let firstId = "";
    for (let index = 0; index < 65; index += 1) {
      const body = `completed-${index}`,
        ready = await peer.request(
          beginFrame(fixture.subject.repoId, `complete-${index}`, Buffer.byteLength(body), body),
        );
      assert.equal(ready.schema, "fleet.upload.ready/v1", `upload ${index}: ${JSON.stringify(ready)}`);
      if (ready.schema !== "fleet.upload.ready/v1") throw new Error("ready expected");
      await peer.request(chunkFrame(ready.uploadId, 0, body));
      const result = await peer.request({
        schema: "fleet.upload.finish/v1",
        messageId: `finish-${index}`,
        opId: "op-upload-test",
        uploadId: ready.uploadId,
      });
      assert.equal(result.schema, "fleet.upload.result/v1", JSON.stringify(result));
      if (index === 0 && result.schema === "fleet.upload.result/v1") {
        first = result;
        firstId = ready.uploadId;
      }
    }
    // Replaying completed claims never spends the eight receiving slots of this session.
    for (let index = 0; index < 9; index += 1) {
      const body = `completed-${index}`;
      const replayed = await peer.request(
        beginFrame(fixture.subject.repoId, `staged-${index}`, Buffer.byteLength(body), body),
      );
      assert.equal(replayed.schema, "fleet.upload.ready/v1", JSON.stringify(replayed));
    }
    const replay = await peer.request({
      schema: "fleet.upload.finish/v1",
      messageId: "finish-replay",
      opId: "op-upload-test",
      uploadId: firstId,
    });
    assert.equal(replay.schema, "fleet.upload.result/v1");
    if (replay.schema !== "fleet.upload.result/v1") throw new Error("result expected");
    assert.equal(replay.status, "already_staged");
    assert.deepEqual(replay.descriptor, first!.descriptor);
    const staged = await peer.request(beginFrame(fixture.subject.repoId, "begin-replay", 11, "completed-0"));
    assert.equal(staged.schema, "fleet.upload.ready/v1");
    if (staged.schema === "fleet.upload.ready/v1") {
      assert.equal(staged.status, "already_staged");
      assert.equal(staged.resumeOffset, 11);
    }
    peer.close();
    await center.close();
    const restarted = await fixture.center(),
      afterRestart = await rawPeer(
        fixture.track,
        restarted.port,
        fixture.cert,
        fixture.subject.nodeId,
        "machine-secret",
      ),
      stillStaged = await afterRestart.request({
        schema: "fleet.upload.finish/v1",
        messageId: "finish-after-restart",
        opId: "op-upload-test",
        uploadId: firstId,
      });
    assert.equal(stillStaged.schema, "fleet.upload.result/v1", JSON.stringify(stillStaged));
    if (stillStaged.schema === "fleet.upload.result/v1") assert.deepEqual(stillStaged.descriptor, first!.descriptor);
    afterRestart.close();
  },
);

test(
  "startup heals 64 historical completed records and preserves an interrupted durable prefix",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const local = resolveHarnessLayout(fixture.repo).localRoot,
      claims = path.join(local, "doc-sync-claims"),
      parts = path.join(local, "fleet-uploads"),
      content = { sha256: sha256Bytes(Buffer.from("staged")), size: 6, mediaType: "text/plain" },
      uploads: Record<string, unknown> = {};
    mkdirSync(claims, { recursive: true });
    mkdirSync(parts, { recursive: true });
    mkdirSync(fixture.stateRoot, { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      const id = `historical-${index}`;
      uploads[id] = {
        nodeId: fixture.subject.nodeId,
        repoId: fixture.subject.repoId,
        content,
        descriptor: { ref: `doc-sync-claims/${id}`, ...content },
      };
      // Half are awaiting consumption; the other half were already consumed before a crash.
      if (index < 32) writeFileSync(path.join(claims, id), "staged");
    }
    const stateFile = path.join(fixture.stateRoot, "state.json");
    writeFileSync(stateFile, JSON.stringify({ uploads }));
    const center = await fixture.center(),
      peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
    const healed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(Object.keys(healed.uploads).length, 32, "only consumed metadata is removed on startup");
    assert.equal(readFileSync(path.join(claims, "historical-0"), "utf8"), "staged");
    const begin = beginFrame(fixture.subject.repoId, "interrupt", 8, "abcdefgh"),
      ready = await peer.request(begin);
    assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
    if (ready.schema !== "fleet.upload.ready/v1") throw new Error("ready expected");
    await peer.request(chunkFrame(ready.uploadId, 0, "abcd"));
    peer.close();
    await center.close();
    const restarted = await fixture.center(),
      resumed = await rawPeer(fixture.track, restarted.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
      prefix = await resumed.request({ ...begin, messageId: "resume" });
    assert.equal(prefix.schema, "fleet.upload.ready/v1", JSON.stringify(prefix));
    if (prefix.schema !== "fleet.upload.ready/v1") throw new Error("ready expected");
    assert.equal(prefix.resumeOffset, 4);
    await resumed.request(chunkFrame(prefix.uploadId, 0, "abcd"));
    await resumed.request(chunkFrame(prefix.uploadId, 4, "efgh"));
    const finished = await resumed.request({
      schema: "fleet.upload.finish/v1",
      messageId: "resume-finish",
      opId: "op-upload-test",
      uploadId: prefix.uploadId,
    });
    assert.equal(finished.schema, "fleet.upload.result/v1", JSON.stringify(finished));
    resumed.close();
  },
);

test("recovery window errors and center status name receiving and staged occupancy", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  mkdirSync(fixture.stateRoot, { recursive: true });
  const uploads = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `partial-${index}`,
      {
        nodeId: `node-${index % 4}`,
        repoId: fixture.subject.repoId,
        content: { sha256: "a".repeat(64), size: 8, mediaType: "text/plain" },
        descriptor: null,
      },
    ]),
  );
  writeFileSync(path.join(fixture.stateRoot, "state.json"), JSON.stringify({ uploads }));
  const center = await fixture.center(),
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    refused = await peer.request(beginFrame(fixture.subject.repoId, "full-window", 8));
  assert.equal(errorCode(refused), "busy");
  if (refused.schema !== "fleet.error/v1") throw new Error("error expected");
  assert.match(refused.message, /receiving=64/u);
  assert.match(refused.message, /staged=0/u);
  assert.match(refused.message, /limit=64/u);
  const status = center.status();
  assert.equal(status.uploads.receiving, 64);
  assert.equal(status.uploads.staged, 0);
  assert.equal(status.uploads.limit, 64);
  assert.equal(
    Object.keys(JSON.parse(readFileSync(path.join(fixture.stateRoot, "state.json"), "utf8")).uploads).length,
    64,
  );
  peer.close();
});

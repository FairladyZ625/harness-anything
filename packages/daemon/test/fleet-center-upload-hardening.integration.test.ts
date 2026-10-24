// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { sha256Bytes } from "@harness-anything/kernel";
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

test("hello authentication failures are rate limited per node", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center();
  for (let attempt = 0; attempt < 5; attempt += 1)
    await assert.rejects(
      rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "wrong-machine-secret"),
      /authentication_failed/u,
    );
  // The failure budget is spent: even the valid credential is now rejected locally.
  await assert.rejects(
    rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    /authentication_failed/u,
  );
  // Another node's budget is untouched by this node's failures.
  const other = await rawPeer(fixture.track, center.port, fixture.cert, fixture.peerSubject.nodeId, "machine-secret"),
    ready = await other.request(beginFrame(fixture.subject.repoId, "rate-limit-peer", 5, "rate-limit-peer"));
  assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
  other.close();
});

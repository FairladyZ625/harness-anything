// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { openPeer } from "../src/fleet/edge.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";

test("a preparing pull does not block other replies on the same TLS session", { timeout: 15_000 }, async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  f.host.replica(f.subject.repoId).prepare = () => new Promise(() => {});
  const center = await f.center();
  const peer = await openPeer({
    readAccessToken: async () => `device-token-${f.subject.nodeId}`,
    port: center.port,
    ca: f.cert,
    nodeId: f.subject.nodeId,
    credential: "machine-secret",
  });
  t.after(() => peer.close());
  await peer.send({ schema: "fleet.replica.pull/v1", messageId: peer.messageId(), repoId: f.subject.repoId });
  assert.equal((await peer.next()).schema, "fleet.replica.preparing/v1");
  const metadata = await peer.request({
    schema: "fleet.repo.metadata.get/v1",
    messageId: peer.messageId(),
    repoId: f.subject.repoId,
  });
  assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
});

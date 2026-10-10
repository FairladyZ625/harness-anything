// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { openPeer, readFleetLoginAuthorityClient } from "../src/fleet/edge.ts";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";

// dec_F01770FD0DCF72683B7C4C7A47: the same TLS connection rechecks a user's device session.
test("Fleet reader frames require an active owner session on every request", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetFixture(t),
    center = await fixture.center();
  let token: string | undefined = undefined;
  const peer = await openPeer({
    port: center.port,
    ca: fixture.cert,
    servername: "localhost",
    nodeId: fixture.subject.nodeId,
    credential: "machine-secret",
    readAccessToken: async () => token,
  });
  t.after(peer.close);
  const read = () =>
    peer.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: peer.messageId(),
      repoId: fixture.subject.repoId,
    });
  await assert.rejects(read(), { code: "authentication_required" });
  token = await fixture.owners.readAccessToken(fixture.subject.nodeId)();
  const admitted = await read();
  assert.equal(admitted.schema, "fleet.repo.metadata.result/v1");
  assert.equal("personId" in admitted && admitted.personId, "person-owner");
  fixture.owners.keycloak.endInteractiveSession(token);
  await assert.rejects(read(), { code: "human_confirmation_required" });
  fixture.owners.keycloak.interactiveSession("person-owner", fixture.peerSubject.nodeId, fixture.owners.url, token);
  await assert.rejects(read(), { code: "human_confirmation_required" });
  fixture.owners.keycloak.account("person-other");
  fixture.owners.keycloak.interactiveSession("person-other", fixture.subject.nodeId, fixture.owners.url, token);
  await assert.rejects(read(), { code: "human_confirmation_required" });
  fixture.owners.keycloak.interactiveSession("person-owner", fixture.subject.nodeId, fixture.owners.url, token);
  assert.equal((await read()).schema, "fleet.repo.metadata.result/v1");
});

// Starting approval replaces only this device's native consent; no old user token is needed.
test("fresh device approval revokes its prior consent before returning login authority", async (t) => {
  const fixture = await fleetFixture(t),
    center = await fixture.center();
  const connect = (nodeId: string) => ({
    port: center.port,
    ca: fixture.cert,
    servername: "localhost",
    nodeId,
    credential: "machine-secret",
  });
  const a = await openPeer({
    ...connect(fixture.subject.nodeId),
    readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
  });
  const b = await openPeer({
    ...connect(fixture.peerSubject.nodeId),
    readAccessToken: fixture.owners.readAccessToken(fixture.peerSubject.nodeId),
  });
  t.after(a.close);
  t.after(b.close);
  const read = (peer: typeof a) =>
    peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: peer.messageId(), repoId: fixture.subject.repoId });
  assert.equal((await read(a)).schema, "fleet.repo.metadata.result/v1");
  const authority = await readFleetLoginAuthorityClient({ ...connect(fixture.subject.nodeId), resetSession: true });
  assert.equal(authority.clientId, `harness-node-${fixture.subject.nodeId}`);
  await assert.rejects(read(a), { code: "human_confirmation_required" });
  assert.equal((await read(b)).schema, "fleet.repo.metadata.result/v1");
  fixture.owners.keycloak.interactiveSession(
    "person-owner",
    fixture.subject.nodeId,
    fixture.owners.url,
    `device-token-${fixture.subject.nodeId}`,
  );
  assert.equal((await read(a)).schema, "fleet.repo.metadata.result/v1");
});

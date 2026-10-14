// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openPeer, readFleetLoginAuthorityClient } from "../src/fleet/peer.ts";
import { readEdgeRepository, withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { fleetFixture, replicaQuota } from "./fleet-tls-session.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";

// The replica's revoked marker is the same signal the production edge read path checks
// (fleet-edge-task-read.ts: existsSync(`${viewDir}/revoked`)).
const isReadDenied = (viewDir: string): boolean => existsSync(path.join(viewDir, "revoked"));

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
  // An account claim which does not match its native user remains rejected.
  fixture.owners.keycloak.interactiveSession("person-other", fixture.subject.nodeId, fixture.owners.url, token);
  [...fixture.owners.keycloak.users.values()].find(
    (user) => user.username === "person-other",
  )!.attributes.harness_person_id = ["person-owner"];
  await assert.rejects(read(), { code: "human_confirmation_required" });
  fixture.owners.keycloak.interactiveSession("person-owner", fixture.subject.nodeId, fixture.owners.url, token);
  assert.equal((await read()).schema, "fleet.repo.metadata.result/v1");
});

test("device session failures preserve the admitted replica while repository revocation withholds it", async (t) => {
  const fixture = await fleetFixture(t),
    center = await fixture.center(),
    { repoId, nodeId, taskId } = fixture.subject,
    viewRoot = path.join(fixture.root, "view"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId);
  const deviceToken = await fixture.owners.readAccessToken(nodeId)();
  let token: string | undefined = deviceToken;
  const pull = () =>
    catchUpReplica({
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
      repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
      readAccessToken: async () => token,
    });
  const local = (principalId = "person-owner") =>
    withEdgeReadModel({ viewRoot, repoId, nodeId, principalId }, (projection) => {
      assert.ok(projection.read(taskId).snapshot.task);
      return { outcome: "applied" };
    });
  await pull();
  assert.equal(isReadDenied(viewDir), false);
  token = undefined;
  await assert.rejects(pull(), { code: "authentication_required" });
  assert.equal(isReadDenied(viewDir), false);
  token = deviceToken;
  fixture.owners.keycloak.endInteractiveSession(deviceToken);
  await assert.rejects(pull(), { code: "human_confirmation_required" });
  assert.equal(isReadDenied(viewDir), false);
  assert.throws(() => local("person-other"), { code: "authorization_denied" });
  fixture.owners.keycloak.interactiveSession("person-owner", nodeId, fixture.owners.url, deviceToken);
  // Restored device approval can read its admitted cut without a network round trip.
  const offlineRead = () =>
    readEdgeRepository(
      { viewRoot, repoId, nodeId, action: { kind: "task-show", taskId } },
      async () => {
        throw new Error("Center offline");
      },
      async () => local(),
    );
  assert.equal((await offlineRead()).outcome, "applied");
  fixture.owners.keycloak.revoke("person-owner", repoId, ["repository-read"]);
  await assert.rejects(pull(), { code: "authorization_denied" });
  assert.equal(isReadDenied(viewDir), true);
  assert.equal((await offlineRead()).code, "authorization_denied");
  fixture.owners.keycloak.permit("person-owner", repoId, ["repository-read"]);
  assert.equal((await offlineRead()).code, "authorization_denied");
  await pull();
  assert.equal((await offlineRead()).outcome, "applied");
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

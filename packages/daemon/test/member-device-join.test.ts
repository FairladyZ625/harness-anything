// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { accessAdminFixture, edgeJoinCenter } from "./access-admin-service.fixture.ts";
import { keycloakUrl } from "./keycloak.fixtures.ts";
import type { EdgeJoinLink } from "../src/fleet/edge-join.ts";

const request = { operation: "edge-join-create", joinMode: "member-device", repoIds: ["repo-a"] } as const;
const linkFrom = (reply: Record<string, unknown>): EdgeJoinLink =>
  JSON.parse(Buffer.from(String(reply.link).slice("harness-edge://join/".length), "base64url").toString("utf8"));

async function member(
  t: Parameters<typeof accessAdminFixture>[0],
  ports: Parameters<typeof accessAdminFixture>[1] = {},
) {
  const f = await edgeJoinCenter(t, await accessAdminFixture(t, ports));
  f.keycloak.account("alice");
  f.keycloak.account("bob");
  f.keycloak.permit("alice", "repo-a", ["repository-read"]);
  f.signIn("alice", []);
  f.keycloak.writes.length = 0;
  t.after(() => f.admin.close());
  return f;
}

test("an ordinary member issues a pinned token-free link for herself without changing any grants", async (t) => {
  const f = await member(t),
    issued = await f.run(request),
    link = linkFrom(issued);
  assert.equal(issued.ok, true);
  assert.equal(Object.hasOwn(link, "token"), false);
  assert.equal(link.version, 2);
  assert.equal(link.centerOrigin, "https://center.example:7545");
  assert.match(link.spkiSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(link.repoIds, ["repo-a"]);
  const record = f.journal().find((entry) => entry.record?.joinId === link.joinId).record;
  assert.equal(record.personId, "alice");
  assert.equal(record.mode, "member-device");
  assert.equal(Object.hasOwn(record, "tokenDigest"), false);
  assert.deepEqual(
    f.keycloak.writes.filter((entry) => /^(POST|PUT|PATCH|DELETE) /u.test(entry)),
    [],
    "issuing a device link creates no account or authorization grant",
  );
  await assert.rejects(f.run({ ...request, personId: "bob" }), { code: "authorization_denied" });
  await assert.rejects(f.run({ ...request, groupIds: ["admin"] }), { code: "authorization_denied" });
  await assert.rejects(f.run({ ...request, repoIds: ["repo-b"] }), { code: "authorization_denied" });
  await assert.rejects(f.run({ ...request, repoIds: ["missing"] }), { code: "repo_namespace_unknown" });
  await assert.rejects(f.run({ ...request, joinMode: "invitation", personId: "alice", groupIds: ["viewer"] }), {
    code: "authorization_denied",
  });
  assert.deepEqual(
    f.keycloak.writes.filter((entry) => /^(POST|PUT|PATCH|DELETE) /u.test(entry)),
    [],
  );
});

test("the same member adds two independent nodes; repeated or competing joins never mint twice", async (t) => {
  const f = await member(t),
    first = linkFrom(await f.run(request)),
    second = linkFrom(await f.run(request));
  f.keycloak.interactiveSession("alice", "existing-device", keycloakUrl, "alice-login", first.loginClientId);
  const admit = (joinId: string) => f.admin.admitEdgeJoin({ joinId, accessToken: "alice-login" });
  const nodesBefore = f.keycloak.nodeClients.size;
  const competed = await Promise.allSettled([admit(first.joinId), admit(first.joinId)]);
  assert.equal(competed.filter((entry) => entry.status === "fulfilled").length, 1);
  const refused = competed.find((entry) => entry.status === "rejected");
  assert.equal(refused?.status === "rejected" && refused.reason.code, "already_consumed");
  const joinedFirst = competed.find((entry) => entry.status === "fulfilled");
  assert.ok(joinedFirst?.status === "fulfilled");
  const joinedSecond = await admit(second.joinId);
  assert.notEqual(joinedFirst.value.nodeId, joinedSecond.nodeId);
  assert.equal(f.keycloak.nodeClients.size, nodesBefore + 2);
  await assert.rejects(admit(first.joinId), { code: "already_consumed" });
  assert.equal(f.keycloak.nodeClients.size, nodesBefore + 2);
  assert.equal(joinedSecond.personId, "alice");
  assert.equal(JSON.stringify(f.journal()).includes(joinedSecond.credential), false);
});

test("member links recheck current access and person at consume without freezing old group versions", async (t) => {
  const f = await member(t),
    link = linkFrom(await f.run(request));
  f.keycloak.interactiveSession("bob", "other-device", keycloakUrl, "bob-login", link.loginClientId);
  const nodes = f.keycloak.nodeClients.size;
  await assert.rejects(f.admin.admitEdgeJoin({ joinId: link.joinId, accessToken: "bob-login" }), {
    code: "human_confirmation_required",
  });
  f.keycloak.interactiveSession("alice", "existing-device", keycloakUrl, "alice-login", link.loginClientId);
  f.keycloak.revoke("alice", "repo-a", ["repository-read"]);
  await assert.rejects(f.admin.admitEdgeJoin({ joinId: link.joinId, accessToken: "alice-login" }), {
    code: "authorization_denied",
  });
  assert.equal(f.keycloak.nodeClients.size, nodes);
  f.keycloak.permit("alice", "repo-a", ["repository-read", "task-create"]);
  const result = await f.admin.admitEdgeJoin({ joinId: link.joinId, accessToken: "alice-login" });
  assert.equal(result.personId, "alice");
  assert.equal(f.keycloak.nodeClients.size, nodes + 1);
});

test("join status belongs to the authenticated person and exposes only join state and node id", async (t) => {
  const f = await member(t),
    link = linkFrom(await f.run(request));
  assert.deepEqual(await f.run({ operation: "edge-join-status", joinId: link.joinId }), {
    ok: true,
    joinId: link.joinId,
    state: "pending",
  });
  f.signIn("bob", ["access-management"]);
  await assert.rejects(f.run({ operation: "edge-join-status", joinId: link.joinId }), { code: "authorization_denied" });
});

test("a lost credential is replaced on the same node; concurrent recovery has one winner", async (t) => {
  const f = await member(t),
    link = linkFrom(await f.run(request));
  f.keycloak.interactiveSession("alice", "existing-device", keycloakUrl, "alice-login", link.loginClientId);
  const input = { joinId: link.joinId, accessToken: "alice-login" },
    lost = await f.admin.admitEdgeJoin(input),
    before = f.keycloak.nodeClients.size;
  f.keycloak.interactiveSession("bob", "other-device", keycloakUrl, "bob-login", link.loginClientId);
  await assert.rejects(f.admin.edgeJoinStatus({ joinId: link.joinId, accessToken: "bob-login" }), {
    code: "human_confirmation_required",
  });
  await assert.rejects(
    f.admin.admitEdgeJoin({ ...input, accessToken: "bob-login", recovery: { nodeId: lost.nodeId } }),
    { code: "human_confirmation_required" },
  );
  await assert.rejects(f.admin.admitEdgeJoin({ ...input, recovery: { nodeId: "another-node" } }), {
    code: "edge_join_invalid",
  });
  const recover = () => f.admin.admitEdgeJoin({ ...input, recovery: { nodeId: lost.nodeId } });
  const outcomes = await Promise.allSettled([recover(), recover()]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  const recovered = outcomes.find((entry) => entry.status === "fulfilled");
  assert.ok(recovered?.status === "fulfilled");
  assert.equal(recovered.value.nodeId, lost.nodeId);
  assert.notEqual(recovered.value.credential, lost.credential);
  assert.equal(await f.provider.authenticateNode(lost.nodeId, lost.credential), false);
  assert.equal(await f.provider.authenticateNode(lost.nodeId, recovered.value.credential), true);
  assert.equal(f.keycloak.nodeClients.size, before);
  assert.deepEqual(await f.run({ operation: "edge-join-status", joinId: link.joinId }), {
    ok: true,
    joinId: link.joinId,
    state: "consumed",
    nodeId: lost.nodeId,
  });
  assert.equal(JSON.stringify(f.journal()).includes(recovered.value.credential), false);
  const reuse = await f.admin.admitEdgeJoin({
    ...input,
    recovery: { nodeId: lost.nodeId, credential: recovered.value.credential },
  });
  assert.equal(reuse.credential, recovered.value.credential);
  const node = (await f.provider.readNode("center-token", lost.nodeId))!;
  await f.run({ operation: "device-pause", nodeId: lost.nodeId, expectedVersion: String(node.revision) });
  await assert.rejects(recover(), { code: "device_paused" });
  const paused = (await f.provider.readNode("center-token", lost.nodeId))!;
  await f.run({ operation: "device-resume", nodeId: lost.nodeId, expectedVersion: String(paused.revision) });
  const active = (await f.provider.readNode("center-token", lost.nodeId))!;
  await f.run({ operation: "device-remove", nodeId: lost.nodeId, expectedVersion: String(active.revision) });
  await assert.rejects(recover(), { code: "device_removed" });
  assert.equal(await f.provider.authenticateNode(lost.nodeId, recovered.value.credential), false);
  const nextLink = linkFrom(await f.run(request));
  const next = await f.admin.admitEdgeJoin({ joinId: nextLink.joinId, accessToken: input.accessToken });
  assert.notEqual(next.nodeId, lost.nodeId, "a removed device rejoins under a new identity");
});

test("a rejected credential replacement leaves the old credential and revision valid, and an explicit retry recovers", async (t) => {
  let rejectWrite = true,
    replacements = 0;
  const f = await member(t, {
    wrapFetch: (inner) => async (input, init) => {
      if (
        init?.method === "PUT" &&
        String(input).includes("/clients/") &&
        typeof init.body === "string" &&
        typeof JSON.parse(init.body).secret === "string"
      ) {
        replacements += 1;
        if (rejectWrite) return new Response(null, { status: 503 });
      }
      return inner(input, init);
    },
  });
  const link = linkFrom(await f.run(request));
  f.keycloak.interactiveSession("alice", "existing-device", keycloakUrl, "alice-login", link.loginClientId);
  const input = { joinId: link.joinId, accessToken: "alice-login" },
    lost = await f.admin.admitEdgeJoin(input);
  const original = await f.provider.readNode("center-token", lost.nodeId);
  const recover = () => f.admin.admitEdgeJoin({ ...input, recovery: { nodeId: lost.nodeId } });
  await assert.rejects(recover(), { code: "keycloak_admin_rejected" });
  assert.equal(replacements, 1, "no automatic retry of a credential mutation");
  assert.equal(await f.provider.authenticateNode(lost.nodeId, lost.credential), true);
  assert.deepEqual(await f.provider.readNode("center-token", lost.nodeId), original);
  rejectWrite = false;
  const recovered = await recover();
  assert.equal(replacements, 2);
  assert.equal(recovered.nodeId, lost.nodeId);
  assert.equal(await f.provider.authenticateNode(lost.nodeId, lost.credential), false);
  assert.equal(await f.provider.authenticateNode(lost.nodeId, recovered.credential), true);
});

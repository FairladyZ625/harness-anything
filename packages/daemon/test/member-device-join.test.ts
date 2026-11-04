// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { accessAdminFixture, edgeJoinCenter } from "./access-admin-service.fixture.ts";
import { keycloakUrl } from "./keycloak.fixtures.ts";
import type { EdgeJoinLink } from "../src/fleet/edge-join.ts";

const request = { operation: "edge-join-create", joinMode: "member-device", repoIds: ["repo-a"] } as const;
const linkFrom = (reply: Record<string, unknown>): EdgeJoinLink =>
  JSON.parse(Buffer.from(String(reply.link).slice("harness-edge://join/".length), "base64url").toString("utf8"));

async function member(t: Parameters<typeof accessAdminFixture>[0]) {
  const f = await edgeJoinCenter(t, await accessAdminFixture(t));
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

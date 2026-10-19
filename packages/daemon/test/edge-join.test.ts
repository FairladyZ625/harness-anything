// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseFleetFrame } from "../src/fleet/command-protocol.ts";
import { admitEdgeJoin } from "../src/fleet/edge-join-admission.ts";
import {
  createEdgeJoinStore,
  decodeEdgeJoinLink,
  EdgeJoinError,
  encodeEdgeJoinLink,
  type EdgeJoinRecord,
} from "../src/fleet/edge-join.ts";

const inviteInput = {
  centerOrigin: "https://center.example:8443",
  repoIds: ["repo-a", "repo-b"],
  personId: "person-a",
  permissionSnapshot: [{ groupId: "contributor", version: "effective-permission-digest" }],
  spkiSha256: "a".repeat(64),
  loginUrl: "https://login.example",
  loginRealm: "harness",
  loginClientId: "edge-client",
  createdBy: "admin-person",
  ttlMs: 72 * 60 * 60 * 1000,
} as const;

test("an invitation uses an HTTPS fragment and persists only a token digest", () => {
  const store = createEdgeJoinStore({
      now: () => "2026-10-16T00:00:00.000Z",
      randomToken: () => "opaque-token",
    }),
    created = store.create(inviteInput),
    url = new URL(encodeEdgeJoinLink(created.link));

  assert.equal(url.protocol, "https:");
  assert.equal(url.pathname, "/join");
  assert.equal(url.search, "");
  assert.equal(url.hash.includes("token=opaque-token"), true);
  assert.deepEqual(decodeEdgeJoinLink(url.toString()), created.link);
  assert.equal(created.record.repoIds.length, 2);
  assert.deepEqual(created.record.permissionSnapshot, inviteInput.permissionSnapshot);
  assert.deepEqual(store.list()[0]?.groupIds, ["contributor"]);
  assert.equal(Object.hasOwn(created.record, "token"), false);
  assert.equal(JSON.stringify(created.record).includes("opaque-token"), false);
  assert.equal(created.record.tokenDigest.length, 64);
  assert.equal(store.status(created.record.joinId).state, "pending");
  assert.throws(
    () => decodeEdgeJoinLink("harness-edge://join/eyJ2ZXJzaW9uIjoxfQ"),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
});

test("an invitation link rejects duplicate fields and embedded URL credentials", () => {
  const created = createEdgeJoinStore({ randomToken: () => "opaque-token" }).create(inviteInput),
    link = new URL(encodeEdgeJoinLink(created.link));
  assert.throws(
    () => decodeEdgeJoinLink(`${link.toString()}&join=other`),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );

  const centerCredentials = new URL(link.toString());
  centerCredentials.username = "operator";
  centerCredentials.password = "secret";
  assert.throws(
    () => decodeEdgeJoinLink(centerCredentials.toString()),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );

  const loginCredentials = new URL(link.toString()),
    params = new URLSearchParams(loginCredentials.hash.slice(1));
  params.set("login_url", "https://operator:secret@login.example");
  loginCredentials.hash = params.toString();
  assert.throws(
    () => decodeEdgeJoinLink(loginCredentials.toString()),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
});

test("revocation, expiration, and consumption are terminal invite states", () => {
  let current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" }),
    revoked = store.create(inviteInput),
    expiring = store.create({ ...inviteInput, ttlMs: 1 }),
    consumed = store.create(inviteInput);

  store.revoke(revoked.record.joinId, "admin-person");
  assert.equal(store.status(revoked.record.joinId).state, "revoked");
  assert.throws(
    () => store.assertConsumable(revoked.record.joinId, revoked.link.token!),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "join_revoked",
  );

  current = "2026-10-16T00:00:00.002Z";
  assert.equal(store.status(expiring.record.joinId).state, "expired");
  assert.throws(
    () => store.assertConsumable(expiring.record.joinId, expiring.link.token!),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "join_token_expired",
  );

  // Return to the fixed time for the non-expired record's successful single consumption.
  current = "2026-10-16T00:00:00.000Z";
  const settled = store.consume(consumed.record.joinId, consumed.link.token!, "node-one");
  assert.equal(settled.consumedAt, current);
  assert.equal(store.status(consumed.record.joinId).state, "consumed");
  assert.equal(store.status(consumed.record.joinId).nodeId, "node-one");
  assert.throws(
    () => store.assertConsumable(consumed.record.joinId, consumed.link.token!),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "already_consumed",
  );
});

test("restoring the writer journal preserves invite state without the plaintext token", () => {
  const current = "2026-10-16T00:00:00.000Z",
    journal: EdgeJoinRecord[] = [],
    first = createEdgeJoinStore({
      now: () => current,
      randomToken: () => "opaque-token",
      onChange: (record) => journal.push(record),
    }),
    created = first.create(inviteInput);

  assert.equal(JSON.stringify(journal).includes("opaque-token"), false);
  const restored = createEdgeJoinStore({ records: journal, now: () => current });
  assert.equal(restored.status(created.record.joinId).state, "pending");
  restored.consume(created.record.joinId, created.link.token!, "node-restored");
  assert.equal(restored.status(created.record.joinId).state, "consumed");
});

test("admission binds the invited person, validates the snapshot, and serializes competing nodes", async () => {
  const store = createEdgeJoinStore({ randomToken: () => "opaque-token" }),
    created = store.create(inviteInput);
  let serial = Promise.resolve(),
    registered = 0,
    validated = 0;
  const oidc = {
    bind: async (auth: { readonly humanClientId?: string }) => {
      assert.equal(auth.humanClientId, "edge-client");
      return { oidcPrincipal: { personId: "person-a" } };
    },
    serialize: <T>(operation: () => Promise<T>) => {
      const result = serial.then(operation);
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const admission = () =>
    admitEdgeJoin({
      joinId: created.record.joinId,
      inviteToken: created.link.token!,
      accessToken: "human-access-token",
      oidc: oidc as never,
      edgeJoins: store,
      validateSnapshot: async (record) => {
        validated += 1;
        assert.deepEqual(record.permissionSnapshot, inviteInput.permissionSnapshot);
      },
      registerNode: async (_record, nodeId) => {
        registered += 1;
        return `credential-${nodeId}`;
      },
    });

  const outcomes = await Promise.allSettled([admission(), admission()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(validated, 1);
  assert.equal(registered, 1);
  assert.equal(store.status(created.record.joinId).state, "consumed");

  const invalid = createEdgeJoinStore({ randomToken: () => "other-token" }).create(inviteInput),
    rejected = await admitEdgeJoin({
      joinId: invalid.record.joinId,
      inviteToken: invalid.link.token!,
      accessToken: "human-access-token",
      oidc: {
        ...oidc,
        bind: async () => ({ oidcPrincipal: { personId: "person-b" } }),
      } as never,
      edgeJoins: createEdgeJoinStore({ records: [invalid.record] }),
      validateSnapshot: async () => assert.fail("wrong person must fail before snapshot validation"),
      registerNode: async () => assert.fail("wrong person must not create a node"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
  assert.equal((rejected as { code?: string }).code, "person_mismatch");
});

test("the join result carries layouts for every invited repository", () => {
  const frame = parseFleetFrame(
    JSON.stringify({
      schema: "fleet.edge.join.result/v1",
      messageId: "join-one",
      inReplyTo: "join-request",
      joinId: "join-id",
      nodeId: "edge-a",
      personId: "person-a",
      credential: "protected-credential",
      repositories: [
        { repoId: "repo-a", harnessYaml: "schema: harness-anything/v1\n" },
        { repoId: "repo-b", harnessYaml: "schema: harness-anything/v1\n" },
      ],
    }),
  );
  assert.equal(frame.schema, "fleet.edge.join.result/v1");
  if (frame.schema === "fleet.edge.join.result/v1")
    assert.deepEqual(
      frame.repositories.map(({ repoId }) => repoId),
      ["repo-a", "repo-b"],
    );
});

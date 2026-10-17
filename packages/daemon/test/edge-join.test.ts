// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { admitEdgeJoin } from "../src/fleet/edge-join-admission.ts";
import {
  createEdgeJoinStore,
  decodeEdgeJoinLink,
  EdgeJoinError,
  encodeEdgeJoinLink,
  type EdgeJoinInviteRecord,
} from "../src/fleet/edge-join.ts";

test("edge join invitation is typed, pin checked, person bound, and single use", () => {
  const current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" });
  const link = store.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "sha256:pin",
    ttlMs: 60_000,
  });
  const encoded = encodeEdgeJoinLink(link);
  assert.deepEqual(decodeEdgeJoinLink(encoded), link);
  const oldLink = `harness-edge://join/${Buffer.from(JSON.stringify({ ...link, version: 1 })).toString("base64url")}`;
  assert.throws(() => decodeEdgeJoinLink(oldLink), { code: "invalid_link" });
  assert.equal(store.status(link.inviteId).status, "pending");
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:wrong" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "pin_mismatch",
  );
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-b", observedSpkiSha256: "sha256:pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "person_mismatch",
  );
  const consumed = store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:pin" });
  assert.equal(consumed.consumedAt, current);
  assert.equal(store.status(link.inviteId).status, "consumed");
  assert.throws(
    () => store.consume({ link: encoded, loginPersonId: "person-a", observedSpkiSha256: "sha256:pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "already_consumed",
  );
  assert.equal(
    store.consume({
      link: encoded,
      loginPersonId: "person-a",
      observedSpkiSha256: "sha256:pin",
      allowSamePersonRetry: true,
    }).consumedAt,
    current,
  );
  assert.throws(
    () =>
      store.consume({
        link: encoded,
        loginPersonId: "person-b",
        observedSpkiSha256: "sha256:pin",
        allowSamePersonRetry: true,
      }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "person_mismatch",
  );
});

test("edge join invitation expires before consumption", () => {
  let current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" });
  const link = store.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "pin",
    ttlMs: 1,
  });
  current = "2026-10-16T00:00:00.002Z";
  assert.equal(store.status(link.inviteId).status, "expired");
  assert.throws(
    () => store.consume({ link, loginPersonId: "person-a", observedSpkiSha256: "pin" }),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "expired",
  );
});

test("edge join state can be restored from the center writer journal", () => {
  const current = "2026-10-16T00:00:00.000Z";
  const journal: EdgeJoinInviteRecord[] = [];
  const first = createEdgeJoinStore({
    now: () => current,
    randomToken: () => "opaque-token",
    onChange: (record) => journal.push(record),
  });
  const link = first.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "pin",
    ttlMs: 60_000,
  });
  const restored = createEdgeJoinStore({ records: journal, now: () => current });
  assert.equal(restored.status(link.inviteId).status, "pending");
  restored.consume({ link, loginPersonId: "person-a", observedSpkiSha256: "pin" });
  assert.equal(restored.status(link.inviteId).status, "consumed");
});

test("pre-session admission binds the invite person and serializes same-person credential rotation", async () => {
  const current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" });
  const invite = store.create({
    centerUrl: "https://center.example",
    personId: "person-a",
    nodeId: "node-a",
    spkiSha256: "sha256:pin",
    loginUrl: "https://login.example",
    loginRealm: "harness",
    loginClientId: "edge-client",
    ttlMs: 60_000,
  });
  const serialized: Array<() => Promise<unknown>> = [];
  let credentialVersion = 0;
  const oidc = {
    bind: async (auth: { readonly humanClientId?: string }) => {
      assert.equal(auth.humanClientId, "edge-client");
      return { oidcPrincipal: { personId: "person-a" } };
    },
    serialize: <T>(operation: () => Promise<T>) => {
      serialized.push(operation);
      return operation();
    },
  };
  const registerNode = async () => `test-credential-${++credentialVersion}`;
  const first = await admitEdgeJoin({
    inviteToken: invite.token,
    nodeId: invite.nodeId,
    accessToken: "test-access-token",
    oidc: oidc as never,
    edgeJoins: store,
    registerNode,
  });
  const retry = await admitEdgeJoin({
    inviteToken: invite.token,
    nodeId: invite.nodeId,
    accessToken: "test-access-token",
    oidc: oidc as never,
    edgeJoins: store,
    registerNode,
  });
  assert.equal(first.credential.length > 0, true);
  assert.equal(retry.credential.length > 0, true);
  assert.notEqual(first.credential, retry.credential);
  assert.equal(credentialVersion, 2);
  assert.equal(serialized.length, 2);
  await assert.rejects(
    admitEdgeJoin({
      inviteToken: invite.token,
      nodeId: invite.nodeId,
      accessToken: "test-access-token",
      oidc: {
        ...oidc,
        bind: async () => ({ oidcPrincipal: { personId: "person-b" } }),
      } as never,
      edgeJoins: store,
      registerNode,
    }),
    { code: "person_mismatch" },
  );
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFleetFrame } from "../src/fleet/command-protocol.ts";
import { admitEdgeJoin } from "../src/fleet/edge-join-admission.ts";
import {
  createEdgeJoinStore,
  decodeEdgeJoinLink,
  EdgeJoinError,
  edgeJoinPlatforms,
  encodeEdgeJoinLink,
  isEdgeJoinPlatform,
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

test("an invitation uses a pasteable harness-edge string and persists only a token digest", () => {
  const store = createEdgeJoinStore({
      now: () => "2026-10-16T00:00:00.000Z",
      randomToken: () => "opaque-token",
    }),
    created = store.create(inviteInput),
    link = encodeEdgeJoinLink(created.link);

  assert.match(link, /^harness-edge:\/\/join\/[A-Za-z0-9_-]+$/u);
  assert.equal(typeof link, "string");
  assert.deepEqual(decodeEdgeJoinLink(link), created.link);
  assert.equal(created.link.version, 2);
  assert.equal(created.record.repoIds.length, 2);
  assert.deepEqual(created.record.permissionSnapshot, inviteInput.permissionSnapshot);
  assert.deepEqual(store.list()[0]?.groupIds, ["contributor"]);
  assert.equal(Object.hasOwn(created.record, "token"), false);
  assert.equal(JSON.stringify(created.record).includes("opaque-token"), false);
  assert.equal(created.record.tokenDigest.length, 64);
  assert.equal(store.status(created.record.joinId).state, "pending");
  assert.throws(
    () => decodeEdgeJoinLink("https://center.example:8443/join#v=1&join=join-id"),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
  assert.throws(
    () =>
      decodeEdgeJoinLink(
        `harness-edge://join/${Buffer.from(JSON.stringify({ ...created.link, version: 1 }), "utf8").toString("base64url")}`,
      ),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
    "old v1 links are rejected rather than silently upgraded",
  );
});

test("an invitation link rejects malformed fields and embedded URL credentials", () => {
  const created = createEdgeJoinStore({ randomToken: () => "opaque-token" }).create(inviteInput),
    makeLink = (changes: Record<string, unknown>) =>
      `harness-edge://join/${Buffer.from(JSON.stringify({ ...created.link, ...changes }), "utf8").toString("base64url")}`;
  assert.throws(
    () => decodeEdgeJoinLink(makeLink({ unsupported: true })),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );

  assert.throws(
    () => decodeEdgeJoinLink(makeLink({ centerOrigin: "https://operator:secret@center.example:8443" })),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );

  assert.throws(
    () => decodeEdgeJoinLink(makeLink({ loginUrl: "https://operator:secret@login.example" })),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
  assert.throws(
    () => decodeEdgeJoinLink(makeLink({ centerOrigin: "http://center.example:8443" })),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
  assert.throws(
    () => decodeEdgeJoinLink(makeLink({ loginCertificate: "not a PEM CA" })),
    (error: unknown) => error instanceof EdgeJoinError && error.code === "edge_join_invalid",
  );
});

test("an invitation rejects a valid listener leaf when it is not a CA root", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-link-leaf-")),
    keyFile = path.join(root, "leaf.key"),
    certificateFile = path.join(root, "leaf.pem");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
      "-subj",
      "/CN=login.example",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "subjectAltName=DNS:login.example",
    ],
    { stdio: "ignore" },
  );
  const created = createEdgeJoinStore().create(inviteInput),
    leafLink = {
      ...created.link,
      loginCertificate: readFileSync(certificateFile, "utf8"),
    };
  assert.throws(
    () =>
      decodeEdgeJoinLink(`harness-edge://join/${Buffer.from(JSON.stringify(leafLink), "utf8").toString("base64url")}`),
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
  const settled = store.consume(consumed.record.joinId, "node-one");
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
  restored.consume(created.record.joinId, "node-restored");
  assert.equal(restored.status(created.record.joinId).state, "consumed");
});

test("a win32 invitation is written, journaled, restored, and read back as win32", async () => {
  const current = "2026-10-21T00:00:00.000Z",
    journal: EdgeJoinRecord[] = [],
    first = createEdgeJoinStore({
      now: () => current,
      randomToken: () => "opaque-token",
      onChange: (record) => journal.push(record),
    }),
    created = first.create({ ...inviteInput, platform: "win32" });

  assert.equal(created.record.platform, "win32");
  assert.equal((journal[0] as { readonly platform?: string }).platform, "win32");
  const restored = createEdgeJoinStore({ records: journal, now: () => current });
  assert.equal(restored.get(created.record.joinId)?.platform, "win32", "the restored record keeps win32");
  // The edge registers the platform the record carried; admission projects this same field.
  await admitEdgeJoin({
    joinId: created.record.joinId,
    inviteToken: created.link.token!,
    accessToken: "human-access-token",
    oidc: {
      bind: async () => ({ oidcPrincipal: { personId: "person-a" } }),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    } as never,
    edgeJoins: restored,
    validateSnapshot: async () => {},
    registerNode: async (record) => {
      assert.equal(record.platform, "win32");
      return "credential";
    },
  });
  assert.equal(restored.status(created.record.joinId).state, "consumed");
});

test("the platform vocabulary is one definition shared by validation and record writes", () => {
  assert.deepEqual([...edgeJoinPlatforms], ["darwin", "linux", "win32"]);
  for (const platform of edgeJoinPlatforms) assert.equal(isEdgeJoinPlatform(platform), true, platform);
  for (const rejected of ["windows", "win64", "Darwin", ""])
    assert.equal(isEdgeJoinPlatform(rejected), false, rejected);
  // Negative control: the store refuses nothing it accepted, so a missing platform is simply absent.
  const store = createEdgeJoinStore();
  for (const platform of edgeJoinPlatforms)
    assert.equal(store.create({ ...inviteInput, platform }).record.platform, platform);
  assert.equal(Object.hasOwn(store.create(inviteInput).record, "platform"), false);
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

test("an invitation crossing its TTL during snapshot validation mints no node", async () => {
  let current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" }),
    created = store.create({ ...inviteInput, ttlMs: 60_000 }),
    oidc = {
      bind: async () => ({ oidcPrincipal: { personId: "person-a" } }),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    };
  let registered = 0;
  const rejected = await admitEdgeJoin({
    joinId: created.record.joinId,
    inviteToken: created.link.token!,
    accessToken: "human-access-token",
    oidc: oidc as never,
    edgeJoins: store,
    validateSnapshot: async () => {
      current = "2026-10-16T00:01:00.001Z";
    },
    registerNode: async () => {
      registered += 1;
      return "credential";
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal((rejected as { code?: string }).code, "join_token_expired");
  assert.equal(registered, 0, "an invitation expired before minting leaves no registered node");
  assert.equal(store.status(created.record.joinId).state, "expired");
});

test("an invitation that lapses while its node is minted still settles the admission", async () => {
  let current = "2026-10-16T00:00:00.000Z";
  const store = createEdgeJoinStore({ now: () => current, randomToken: () => "opaque-token" }),
    created = store.create({ ...inviteInput, ttlMs: 60_000 }),
    oidc = {
      bind: async () => ({ oidcPrincipal: { personId: "person-a" } }),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    };
  const admitted = await admitEdgeJoin({
    joinId: created.record.joinId,
    inviteToken: created.link.token!,
    accessToken: "human-access-token",
    oidc: oidc as never,
    edgeJoins: store,
    validateSnapshot: async () => {},
    registerNode: async (_record, nodeId) => {
      // The final check already passed inside the same critical section; minting may outlast the TTL.
      current = "2026-10-16T00:01:00.001Z";
      return `credential-${nodeId}`;
    },
  });
  assert.equal(admitted.credential.startsWith("credential-"), true);
  assert.equal(store.status(created.record.joinId).state, "consumed");
  assert.equal(store.status(created.record.joinId).nodeId, admitted.nodeId);
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

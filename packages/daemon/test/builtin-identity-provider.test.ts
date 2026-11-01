// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BuiltinIdentitySession,
  BuiltinIdentityManagement,
  userRootFromBuiltinUrl,
} from "@harness-anything/authorization-builtin";
import { OidcSessionService } from "@harness-anything/authorization-keycloak";
import {
  createAuthorizationProvider,
  createIdentityManagement,
  createIdentitySession,
} from "../src/authorization-provider.ts";
import { admitEdgeJoin } from "../src/fleet/edge-join-admission.ts";
import { createEdgeJoinStore } from "../src/fleet/edge-join.ts";

test("clean user roots select built-in identity without a managed runtime", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const management = createIdentityManagement(root);
  assert.ok(management instanceof BuiltinIdentityManagement);
  assert.deepEqual(await management.run({ operation: "bootstrap" }), {
    ok: true,
    command: "rbac-bootstrap",
    mode: "builtin",
    url: "builtin://local",
    downloaded: [],
  });
  assert.equal(JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8")).mode, "builtin");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "rbac", "builtin-state.json"), "utf8")).schema,
    "harness-builtin-identity/v1",
  );
  const session = createIdentitySession(root);
  assert.ok(session instanceof BuiltinIdentitySession);
  assert.deepEqual(await session.bootstrapStatus(), { ok: true, required: true });
  const first = {
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct horse",
    personId: "person-owner",
  };
  const outcomes = await Promise.allSettled([
    session.bootstrapAdmin(first),
    session.bootstrapAdmin({ ...first, personId: "person-second" }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter(
      (item) => item.status === "rejected" && (item.reason as { code?: string }).code === "bootstrap_admin_closed",
    ).length,
    1,
  );
  const browserLogin = await session.begin("http://127.0.0.1:43123/callback");
  await assert.rejects(session.complete("owner", String(browserLogin.state)), { code: "oidc_identity_rejected" });
  assert.equal((await session.complete("owner:correct horse", String(browserLogin.state))).authenticated, true);
  await session.logout();
  const login = await session.beginDevice();
  assert.deepEqual(await session.pollDevice(), { ok: true, pending: true, interval: 1 });
  await session.deviceApproval(String(login.userCode));
  assert.equal((await session.pollDevice()).authenticated, true);
  const bound = await session.bind({ transportKind: "unix-socket" });
  assert.equal(bound.oidcPrincipal?.personId, "person-owner");
  const center = await session.center();
  assert.equal(center.provider.policyRef, "builtin-policy@1");
  await center.provider.claimRepositoryOwner(center.accessToken, "repo-1", "person-owner");
  assert.equal(
    (
      await center.provider.authorize({
        userAccessToken: bound.oidcPrincipal!.accessToken,
        action: "repository-read",
        resource: { kind: "repository", repoId: "repo-1" },
      })
    ).outcome,
    "allowed",
  );
  assert.equal(
    (
      await center.provider.authorize({
        userAccessToken: bound.oidcPrincipal!.accessToken,
        action: "repository-write",
        resource: { kind: "repository", repoId: "repo-1" },
      })
    ).outcome,
    "denied",
  );
  await assert.rejects(
    center.provider.createNode(center.accessToken, { nodeId: "edge-a", personId: "person-owner" }, "node-secret"),
    { code: "identity_plugin_required" },
  );
});

test("external mode remains an explicit Keycloak plugin selection", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const management = createIdentityManagement(root);
  await management.run({ operation: "bootstrap" });
  await management.run({
    mode: "external",
    url: "https://identity.example.invalid",
    realm: "fleet",
    clientId: "harness-center",
  });
  const session = createIdentitySession(root);
  assert.ok(session instanceof OidcSessionService);
  assert.equal(
    createAuthorizationProvider({
      mode: "external",
      userRoot: root,
      url: "builtin://local",
      realm: "fleet",
      resourceServerClientId: "harness-center",
    }).authority,
    "keycloak",
  );
  const provider = createAuthorizationProvider({
    mode: "builtin",
    userRoot: root,
    url: "builtin://local",
    realm: "local",
    resourceServerClientId: "harness-center",
  });
  assert.equal(provider.authority, "builtin");
});

test("builtin authority URLs reject malformed or non-absolute roots", () => {
  assert.equal(userRootFromBuiltinUrl("builtin://local/not-base64!"), undefined);
  assert.equal(userRootFromBuiltinUrl("builtin://local/"), undefined);
  assert.equal(userRootFromBuiltinUrl("https://identity.example.invalid"), undefined);
});

test("builtin collaboration entry points require the Keycloak plugin", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-collaboration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const center = new BuiltinIdentitySession(root);
  await center.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct horse",
    personId: "person-owner",
  });
  assert.throws(() => center.requireCollaboration(), { code: "identity_plugin_required" });
  await assert.rejects(center.interactiveAuthority(), { code: "identity_plugin_required" });
  const store = createEdgeJoinStore({ randomToken: () => "builtin-edge-invite" }),
    created = store.create({
      centerOrigin: "https://center.example.invalid:7545",
      repoIds: ["repo-one"],
      personId: "person-owner",
      permissionSnapshot: [{ groupId: "admin", version: "v1" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "builtin://local",
      loginRealm: "local",
      loginClientId: "harness-center",
      createdBy: "person-owner",
      ttlMs: 60_000,
    });
  await assert.rejects(
    admitEdgeJoin({
      joinId: created.record.joinId,
      inviteToken: created.link.token!,
      oidc: center,
      edgeJoins: store,
      validateSnapshot: async () => undefined,
      registerNode: async (record) => {
        assert.equal(record.personId, "person-owner");
        return "node-credential";
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "identity_plugin_required");
      assert.match((error as Error).message, /Keycloak/);
      return true;
    },
  );
  assert.equal(store.status(created.record.joinId).state, "pending");
});

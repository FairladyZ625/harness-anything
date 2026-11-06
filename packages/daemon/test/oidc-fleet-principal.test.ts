// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyFleetHuman, verifyFleetReplica } from "@harness-anything/authorization-keycloak/oidc-fleet-principal";
import { createIdentitySession } from "../src/authorization-provider.ts";

const claims = {
  active: true,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iss: "https://center.test/realms/harness",
  azp: "harness-node-a",
  aud: ["harness-center"],
  sub: "user-a",
  harness_person_id: "person-a",
};
const user = { enabled: true, attributes: { harness_person_id: ["person-a"] } };
const verify = (updates: Record<string, unknown> = {}, userUpdates: Record<string, unknown> = {}, offline = false) =>
  verifyFleetHuman({
    auth: {
      transportKind: "fleet-tls",
      humanAccessToken: "request-token",
      nodePrincipal: { nodeId: "a", personId: "person-a" },
    },
    url: "http://127.0.0.1:1",
    issuerUrl: "https://center.test",
    realm: "harness",
    clientId: "harness-center",
    expectedAzps: [{ clientId: "harness-node-a" }],
    clientSecret: "center-secret",
    adminAccessToken: "admin-token",
    now: Date.now(),
    fetch: (async (input) => {
      if (offline) throw new TypeError("Keycloak unavailable");
      return Response.json(
        String(input).endsWith("/introspect") ? { ...claims, ...updates } : { ...user, ...userUpdates },
      );
    }) as typeof fetch,
  });

test("center online introspection binds the verified person signed in on this device", async () => {
  const bound = await verify();
  assert.equal(bound.oidcPrincipal?.personId, "person-a");
  assert.equal(bound.oidcPrincipal?.accessToken, "request-token");
  const changed = await verify({ harness_person_id: "person-b" }, { attributes: { harness_person_id: ["person-b"] } });
  assert.equal(changed.nodePrincipal?.personId, "person-a", "request identity does not transfer device ownership");
  assert.equal(changed.oidcPrincipal?.personId, "person-b");
  for (const updates of [
    { active: false },
    { exp: 1 },
    { iss: "https://elsewhere.test/realms/harness" },
    { aud: ["other-server"] },
    { azp: "harness-node-b" },
    { azp: "" },
    { azp: null },
    { harness_person_id: "person-b" },
  ])
    await assert.rejects(verify(updates), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, { serviceAccountClientId: "node-service" }), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, { enabled: false }), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, {}, true), /Keycloak unavailable/u);
});

function replicaVerifier(
  overrides: {
    readonly claims?: Record<string, unknown>;
    readonly user?: Record<string, unknown>;
    readonly node?: { readonly personId: string; readonly state: string; readonly revocation: string };
    readonly now?: number;
  } = {},
) {
  const now = overrides.now ?? Date.now();
  return verifyFleetReplica({
    auth: {
      transportKind: "fleet-tls",
      humanAccessToken: "replica-token",
      nodePrincipal: { nodeId: "a", personId: "person-a" },
    },
    url: "http://127.0.0.1:1",
    issuerUrl: "https://center.test",
    realm: "harness",
    clientId: "harness-center",
    clientSecret: "center-secret",
    adminAccessToken: "admin-token",
    now,
    readNode: async () => overrides.node ?? { personId: "person-a", state: "active", revocation: "complete" },
    fetch: (async (input) => {
      if (String(input).endsWith("/introspect"))
        return Response.json({
          active: true,
          exp: Math.floor(now / 1_000) + 300,
          iss: "https://center.test/realms/harness",
          azp: "harness-node-a",
          aud: ["harness-center"],
          sub: "service-account-a",
          ...overrides.claims,
        });
      if (String(input).includes("/clients?clientId="))
        return Response.json([
          {
            id: "client-a",
            clientId: "harness-node-a",
            enabled: true,
            serviceAccountsEnabled: true,
            fullScopeAllowed: false,
          },
        ]);
      return Response.json({
        id: "service-account-a",
        enabled: true,
        ...overrides.user,
      });
    }) as typeof fetch,
  });
}

test("a node service-account token establishes only its registered owner's replica identity", async () => {
  const now = Date.now(),
    result = await replicaVerifier({ now });
  assert.deepEqual(
    {
      nodeId: result.fleetReplicaPrincipal?.nodeId,
      personId: result.fleetReplicaPrincipal?.personId,
      expiresAtIsCurrent: (result.fleetReplicaPrincipal?.expiresAt ?? 0) > now,
    },
    { nodeId: "a", personId: "person-a", expiresAtIsCurrent: true },
  );
  assert.equal(result.oidcPrincipal, undefined, "machine authentication must not create a human session");

  for (const options of [
    { claims: { active: false } },
    { claims: { exp: Math.floor(now / 1_000) } },
    { claims: { iss: "https://elsewhere.test/realms/harness" } },
    { claims: { aud: ["other-server"] } },
    { claims: { azp: "harness-node-b" } },
    { user: { id: "another-service-account" } },
    { user: { enabled: false } },
    { node: { personId: "person-b", state: "active", revocation: "complete" } },
    { node: { personId: "person-a", state: "removed", revocation: "complete" } },
    { node: { personId: "person-a", state: "active", revocation: "pending" } },
  ])
    await assert.rejects(replicaVerifier({ ...options, now }), { code: "fleet_replica_credential_rejected" });

  const noSession = await verifyFleetReplica({
    auth: { transportKind: "fleet-tls", nodePrincipal: { nodeId: "a", personId: "person-a" } },
    url: "http://127.0.0.1:1",
    issuerUrl: "https://center.test",
    realm: "harness",
    clientId: "harness-center",
    clientSecret: "center-secret",
    adminAccessToken: "admin-token",
    now,
    readNode: async () => ({ personId: "person-a", state: "active", revocation: "complete" }),
    fetch: fetch,
  });
  assert.equal(noSession, null, "the replica verifier never creates a principal without a token");
});

test("the center's local session never supplies a missing edge human credential", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  writeFileSync(
    path.join(root, "rbac/oidc-session.json"),
    JSON.stringify({
      schema: "harness-oidc-session/v2",
      accessToken: "center-token",
      refreshToken: "center-refresh",
      subject: "center-admin",
      personId: "center-admin",
      expiresAt: Date.now() + 300_000,
      sessionExpiresAt: Date.now() + 600_000,
      roles: ["access-admin"],
    }),
  );
  const auth = { transportKind: "fleet-tls" as const, nodePrincipal: { nodeId: "a", personId: "person-a" } };
  await assert.rejects(createIdentitySession(root).bind(auth), { code: "authentication_required" });
});

// dec_F01770FD0DCF72683B7C4C7A47: a device client alone never supplies a user session.
test("Fleet binding requires a request user session even when center authority exists", async () => {
  const { binding } = await import("../src/daemon-host-binding.ts");
  let centerCalls = 0;
  const auth = {
    transportKind: "fleet-tls" as const,
    nodePrincipal: { nodeId: "a", personId: "person-a" },
    keycloakCenter: async () => {
      centerCalls += 1;
      throw new Error("center must not lend user authority");
    },
  };
  await assert.rejects(binding("/unused", auth), { code: "authentication_required" });
  assert.equal(centerCalls, 0);
  const verified = await verify();
  const bound = await binding("/unused", verified);
  assert.equal(bound.actor.principal.personId, "person-a");
  assert.deepEqual(bound.source, { kind: "node", nodeId: "a" });
  assert.equal(bound.keycloakAuthorization?.session?.accessToken, "request-token");
  assert.equal(bound.keycloakAuthorization?.center, undefined);
  const other = await binding("/unused", {
    ...verified,
    oidcPrincipal: { ...verified.oidcPrincipal!, personId: "person-b" },
  });
  assert.equal(other.actor.principal.personId, "person-b");
  assert.deepEqual(other.source, { kind: "node", nodeId: "a" });
});

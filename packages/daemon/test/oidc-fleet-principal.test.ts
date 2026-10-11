// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyFleetHuman } from "../src/oidc-fleet-principal.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";

const claims = {
  active: true,
  exp: 100,
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
    clientSecret: "center-secret",
    adminAccessToken: "admin-token",
    now: 10_000,
    fetch: (async (input) => {
      if (offline) throw new TypeError("Keycloak unavailable");
      return Response.json(
        String(input).endsWith("/introspect") ? { ...claims, ...updates } : { ...user, ...userUpdates },
      );
    }) as typeof fetch,
  });

test("center online introspection binds only the current owner's interactive node session", async () => {
  const bound = await verify();
  assert.equal(bound.oidcPrincipal?.personId, "person-a");
  assert.equal(bound.oidcPrincipal?.accessToken, "request-token");
  for (const updates of [
    { active: false },
    { exp: 1 },
    { iss: "https://elsewhere.test/realms/harness" },
    { aud: ["other-server"] },
    { azp: "harness-node-b" },
    { harness_person_id: "person-b" },
  ])
    await assert.rejects(verify(updates), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, { serviceAccountClientId: "node-service" }), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, { enabled: false }), { code: "human_confirmation_required" });
  await assert.rejects(verify({}, {}, true), /Keycloak unavailable/u);
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
  await assert.rejects(new OidcSessionService(root).bind(auth), { code: "authentication_required" });
});

// dec_F01770FD0DCF72683B7C4C7A47: a device client alone never supplies a user session.
test("Fleet binding requires the device owner's user session even when center authority exists", async () => {
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
  await assert.rejects(
    binding("/unused", {
      ...verified,
      oidcPrincipal: { ...verified.oidcPrincipal!, personId: "person-b" },
    }),
    { code: "human_confirmation_required" },
  );
});

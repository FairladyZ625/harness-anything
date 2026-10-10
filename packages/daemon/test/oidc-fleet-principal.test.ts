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
      nodePrincipal: { nodeId: "a", personId: "person-a", subject: "node-service" },
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

test("center online introspection binds the actual interactive person with current realm, audience, node and user checks", async () => {
  const bound = await verify();
  assert.equal(bound.oidcPrincipal?.personId, "person-a");
  assert.equal(bound.oidcPrincipal?.accessToken, "request-token");
  // dec_2665E58BA5AE42E37793193748/CH1: a different real login does not borrow owner authority.
  const other = await verify({ harness_person_id: "person-b" }, { attributes: { harness_person_id: ["person-b"] } });
  assert.equal(other.oidcPrincipal?.personId, "person-b");
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
  const auth = {
    transportKind: "fleet-tls" as const,
    nodePrincipal: { nodeId: "a", personId: "person-a", subject: "node-service" },
  };
  assert.deepEqual(await new OidcSessionService(root).bind(auth), auth);
});

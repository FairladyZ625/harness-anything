// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { managedRbacVersions } from "../src/managed-rbac-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";

test("the first-admin window closes and later listener changes require access-admin", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-auth-")),
    configFile = path.join(userRoot, "rbac", "config.json");
  let session: string | undefined;
  const members: string[] = [];
  let invalidMembership = false;
  const signedIn = (roles: readonly string[]): string =>
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "header.e30.signature",
        refreshToken: "refresh",
        subject: "keycloak-subject",
        personId: "person-zeyu",
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: Date.now() + 3_600_000,
        roles,
      }),
    oidc = new OidcSessionService(userRoot, {
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/token")) {
          if ((init?.body as URLSearchParams).get("grant_type") === "refresh_token")
            return Response.json({
              access_token: `header.${Buffer.from(JSON.stringify({ realm_access: { roles: ["access-admin"] } })).toString("base64url")}.signature`,
              refresh_token: "renewed",
              expires_in: 3600,
              refresh_expires_in: 3600,
            });
          return Response.json({ access_token: "center-token" });
        }
        if (url.endsWith("/roles/access-admin/users"))
          return Response.json(invalidMembership ? {} : members.map((id) => ({ id })));
        if (url.endsWith("/roles/access-admin")) return Response.json({ id: "access-admin", name: "access-admin" });
        if (url.endsWith("/users") && init?.method === "POST")
          return new Response(null, { status: 201, headers: { location: `${url}/owner` } });
        if (url.includes("/role-mappings/realm")) members.push("owner");
        if (url.includes("username=harness-bootstrap")) return Response.json([]);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      sessionStore: {
        read: () => session,
        write: (value) => void (session = value),
        delete: () => void (session = undefined),
        retireBootstrap: () => undefined,
      },
    });
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: "http://127.0.0.1:1",
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      postgresPort: 2,
      managementPort: 3,
      stopped: true,
    }),
  );
  writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "fixture-secret");
  const before = readFileSync(configFile, "utf8"),
    host = await openDaemonHost({ daemonId: "listener-authorization", userRoot, oidc }),
    change = {
      operation: "listener-set",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: 8443,
      certificateFile: "/nonexistent/center.crt",
      certificateKeyFile: "/nonexistent/center.key",
    } as const;
  try {
    const current = String((await host.manageRbac({ operation: "listener" }, auth)).version);
    // D1 reaches the original TLS validation while there is no administrator.
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.throws(() => host.manageRbac({ ...change, expectedVersion: current }, { transportKind: "fleet-tls" }), {
      code: "local_transport_required",
    });
    const administrator = {
      operation: "bootstrap-admin",
      username: "owner",
      email: "owner@example.invalid",
      displayName: "Owner",
      password: "private-test-password",
      personId: "person-owner",
    } as const;
    // Both operations are submitted before the first succeeds; the queued listener must observe its result.
    const results = await Promise.allSettled([
      host.manageRbac(administrator, auth),
      host.manageRbac(administrator, auth),
      host.manageRbac({ ...change, expectedVersion: current }, auth),
    ]);
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(JSON.stringify(results[0]).includes(administrator.password), false);
    assert.equal(results[1]!.status, "rejected");
    assert.equal((results[1] as PromiseRejectedResult).reason.code, "bootstrap_admin_closed");
    assert.equal(results[2]!.status, "rejected");
    assert.equal((results[2] as PromiseRejectedResult).reason.code, "authentication_required");
    assert.equal(members.length, 1);
    session = signedIn(["default-roles-harness"]);
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "authorization_denied",
    });
    // An access administrator's request is the one that reaches the listener: it is judged on its content.
    session = signedIn(["access-admin"]);
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal((await host.manageRbac({ ...change, expectedVersion: "stale" }, auth)).code, "version_conflict");
    session = JSON.stringify({ ...JSON.parse(signedIn(["access-admin"])), expiresAt: Date.now() - 1 });
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal(
      JSON.parse(session!).refreshToken,
      "renewed",
      "renewal inside the listener queue finishes without nesting the queue",
    );
    invalidMembership = true;
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "oidc_response_invalid",
    });
    await assert.rejects(host.manageRbac(administrator, auth), { code: "oidc_response_invalid" });
    assert.equal(readFileSync(configFile, "utf8"), before);
  } finally {
    await host.close();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

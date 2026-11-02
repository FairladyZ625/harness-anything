// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";

test("the first-admin window closes and later listener changes require fleet policy", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-auth-")),
    configFile = path.join(userRoot, "rbac", "config.json");
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
  let session: string | undefined;
  const keycloak = fakeKeycloak("http://127.0.0.1:1/realms/harness");
  let invalidMembership = false;
  const signedIn = (roles: readonly string[], personId = "person-owner"): string =>
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer: "http://127.0.0.1:1/realms/harness",
        accessToken: `token-${personId}`,
        refreshToken: `token-${personId}`,
        subject: personId,
        personId,
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: Date.now() + 3_600_000,
        roles,
      }),
    oidc = createIdentitySession(userRoot, {
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration"))
          return Response.json({ issuer: "http://127.0.0.1:1/realms/harness" });
        if (invalidMembership && new URL(url).pathname === "/admin/realms/harness/users") return Response.json({});
        return keycloak.fetch(input, init);
      }) as typeof fetch,
      sessionStore: () => ({
        read: () => session,
        write: (value) => void (session = value),
        delete: () => void (session = undefined),
        retireBootstrap: () => undefined,
      }),
    });
  writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "fixture-secret");
  const before = readFileSync(configFile, "utf8"),
    host = await openDaemonHost({ daemonId: "listener-authorization", userRoot, oidc }),
    change = {
      rootDir: userRoot,
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
    assert.equal((await oidc.bootstrapStatus()).required, false);
    assert.equal(keycloak.realmRoles.has("access-admin"), false);
    keycloak.interactiveSession("person-owner", "bootstrap-login", "http://127.0.0.1:1");
    keycloak.account("person-member");
    session = signedIn(["access-admin"], "person-member");
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "authorization_denied",
    });
    await assert.rejects(
      host.manageRbac(
        {
          rootDir: userRoot,
          mode: "external",
          url: "https://identity.example.test",
          realm: "fleet",
          clientId: "harness-center",
          clientSecret: "unused",
        },
        auth,
      ),
      {
        code: "authorization_denied",
      },
    );
    // An access administrator's request is the one that reaches the listener: it is judged on its content.
    session = signedIn([]);
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal((await host.manageRbac({ ...change, expectedVersion: "stale" }, auth)).code, "version_conflict");
    session = JSON.stringify({ ...JSON.parse(signedIn([])), expiresAt: Date.now() - 1 });
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal(
      JSON.parse(session!).refreshToken,
      "token-person-owner",
      "renewal inside the listener queue finishes without nesting the queue",
    );
    invalidMembership = true;
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      name: "TypeError",
    });
    await assert.rejects(host.manageRbac(administrator, auth), { name: "TypeError" });
    assert.equal(readFileSync(configFile, "utf8"), before);
  } finally {
    await host.close();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

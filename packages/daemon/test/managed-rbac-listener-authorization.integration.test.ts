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

test("only a signed-in access administrator changes the listener", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-auth-")),
    configFile = path.join(userRoot, "rbac", "config.json");
  let session: string | undefined;
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
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "authentication_required",
    });
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
    assert.equal(readFileSync(configFile, "utf8"), before);
  } finally {
    await host.close();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

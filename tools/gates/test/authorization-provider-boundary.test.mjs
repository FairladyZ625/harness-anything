// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { findExpiredWaivers, findProviderBoundaryViolations } from "../authorization-provider-boundary.mjs";

test("rejects newly added Keycloak symbols and realm contract fields in consumers", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `diff --git a/packages/application/src/auth.ts b/packages/application/src/auth.ts\n+++ b/packages/application/src/auth.ts\n+const provider = "keycloak";\n+readonly realm: string;`,
    ),
    [
      'packages/application/src/auth.ts: Keycloak-specific symbol, error, or REST path: const provider = "keycloak";',
      "packages/application/src/auth.ts: provider-specific realm field: readonly realm: string;",
    ],
  );
});

test("permits provider internals, test fixtures, and neutral authorization contracts", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/authorization-keycloak/src/provider.ts\n+const realm = "main";\n+++ b/packages/daemon/test/auth.test.ts\n+const provider = "keycloak";\n+++ b/packages/application/src/authorization.ts\n+export interface AuthorizationPort { authorize(action: string): Promise<boolean> }`,
    ),
    [],
  );
});

test("does not mistake removed lines for newly introduced coupling", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/daemon/src/auth.ts\n-const provider = "keycloak";\n+const provider: AuthorizationProvider = createProvider();`,
    ),
    [],
  );
});

test("expires legacy waiver entries on their declared date", () => {
  const waivers = {
    entries: [
      { scope: "packages/daemon/src/**", expiresOn: "2026-12-07", remediationTask: "task_273e5317cfe2d8740fadaee7e7" },
      { scope: "packages/gui/src/**", expiresOn: "2026-12-08", remediationTask: "task_273e5317cfe2d8740fadaee7e7" },
    ],
  };
  assert.deepEqual(findExpiredWaivers(waivers, "2026-12-07"), [
    "packages/daemon/src/**: waiver expired 2026-12-07 (task_273e5317cfe2d8740fadaee7e7)",
  ]);
});

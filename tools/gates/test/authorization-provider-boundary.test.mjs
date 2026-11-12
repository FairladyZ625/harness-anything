// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  findExpiredWaivers,
  findProviderBoundaryViolations,
  findStaleFingerprints,
  providerLineFingerprint,
} from "../authorization-provider-boundary.mjs";

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

test("rejects quoted object and JSON realm fields in consumers", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/application/src/auth.ts\n+const contract = { "realm": "local" };\n+const legacy = { 'realm': 'main' };`,
    ),
    [
      'packages/application/src/auth.ts: provider-specific realm field: const contract = { "realm": "local" };',
      "packages/application/src/auth.ts: provider-specific realm field: const legacy = { 'realm': 'main' };",
    ],
  );
});

test("rejects provider-specific role, client credentials, and admin REST paths", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/daemon/src/auth.ts\n+const realmRole = "operator";\n+const clientId = "console";\n+const clientSecret = secret;\n+fetch("/admin/serverinfo");`,
    ),
    [
      'packages/daemon/src/auth.ts: Keycloak-specific symbol, error, or REST path: const realmRole = "operator";',
      'packages/daemon/src/auth.ts: Keycloak-specific symbol, error, or REST path: const clientId = "console";',
      "packages/daemon/src/auth.ts: Keycloak-specific symbol, error, or REST path: const clientSecret = secret;",
      'packages/daemon/src/auth.ts: Keycloak-specific symbol, error, or REST path: fetch("/admin/serverinfo");',
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

test("registered ontology source references are data; implementation, labels and unregistered references remain forbidden", () => {
  const symbol = "packages/authorization-keycloak/src/provider.ts#Provider.validate",
    refs = new Set([symbol]);
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/kernel/src/domain/facets.json\n+"symbol": "${symbol}",\n+"${symbol}"`,
      [],
      refs,
    ),
    [],
  );
  for (const [file, line] of [
    ["facets.json", '"symbol": "packages/authorization-keycloak/src/other.ts#Other"'],
    ["facets.json", '"explain": "Keycloak-specific behavior"'],
    ["facets.json", '"realm": "main"'],
    ["runtime.ts", `export const symbol = "${symbol}";`],
    ["runtime.ts", 'import { Provider } from "@harness-anything/authorization-keycloak";'],
  ])
    assert.equal(
      findProviderBoundaryViolations(`+++ b/packages/kernel/src/domain/${file}\n+${line}`, [], refs).length,
      1,
      line,
    );
});

test("permits future Keycloak provider packages and neutral admin client names", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/authorization-keycloak-enterprise/src/provider.ts\n+const realm = "main";\n+++ b/packages/gui/src/renderer/connection-data.ts\n+} from "./connection-admin-client.ts";\n+const path = "/admin/settings";`,
    ),
    [],
  );
});

test("keeps builtin provider shapes inside the tracked remediation boundary", () => {
  assert.deepEqual(
    findProviderBoundaryViolations(
      `+++ b/packages/authorization-builtin/src/state.ts\n+readonly realm: "local";\n+clientId: "harness-center",\n+++ b/packages/authorization-keycloak-gui/src/ui-host.ts\n+export interface KeycloakUiHost { readonly realm: string }`,
    ),
    [
      'packages/authorization-builtin/src/state.ts: provider-specific realm field: readonly realm: "local";',
      'packages/authorization-builtin/src/state.ts: Keycloak-specific symbol, error, or REST path: clientId: "harness-center",',
    ],
  );
});

test("waives only exact registered legacy source lines, not new lines in the same package", () => {
  const legacy = 'const label = "Keycloak account";';
  const fingerprint = providerLineFingerprint("packages/gui/src/legacy.ts", legacy);
  assert.deepEqual(
    findProviderBoundaryViolations(`+++ b/packages/gui/src/legacy.ts\n+${legacy}\n+const realm = "new";`, [
      fingerprint,
    ]),
    ['packages/gui/src/legacy.ts: provider-specific realm field: const realm = "new";'],
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

test("rejects a line fingerprint whose waived source line no longer exists", () => {
  const line = 'export type IdentityProvider = "builtin" | "keycloak" | "unknown";';
  const file = "packages/authorization-gui/src/identity-presentation.ts";
  const live = providerLineFingerprint(file, line);
  const stale = providerLineFingerprint(file, "  // removed legacy line");
  assert.deepEqual(findStaleFingerprints([live], [{ file, text: `/** doc */\n  ${line}\n` }]), []);
  assert.deepEqual(findStaleFingerprints([live, stale], [{ file, text: `${line}\n` }]), [
    `tools/gate-allowlists/authorization-provider-boundary.json: line fingerprint ${stale} matches no current source line; delete it`,
  ]);
  // The same text in another file is a different line: the waiver belongs to its own path.
  assert.equal(findStaleFingerprints([live], [{ file: "packages/gui/src/x.ts", text: line }]).length, 1);
});

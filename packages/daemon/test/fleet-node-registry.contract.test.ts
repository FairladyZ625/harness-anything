// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { keycloakNodeRegistry, prepareFleetCenterAdmission } from "../src/fleet-center-admission.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl } from "./keycloak.fixtures.ts";

test("the node registry asks Keycloak who a node is and whether its credential is its own", async () => {
  const keycloak = fakeKeycloak(),
    credential = keycloak.node("edge-one", "operator-one"),
    registry = keycloakNodeRegistry(
      async () => ({ url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" }),
      keycloak.fetch,
    );
  assert.equal(await registry.authenticate("edge-one", credential), true);
  assert.equal(await registry.authenticate("edge-one", `${credential}-other`), false);
  assert.equal(await registry.authenticate("edge-unregistered", credential), false);
  assert.equal(await registry.nodeOwner("edge-one"), "operator-one");
  assert.equal(await registry.nodeOwner("edge-unregistered"), null);
  // Re-registration to another person is what the next frame reads; nothing is cached in between.
  keycloak.node("edge-one", "operator-two");
  assert.equal(await registry.nodeOwner("edge-one"), "operator-two");
  assert.equal(await registry.authenticate("edge-one", credential), true);
});

test("fleet center admission rejects unreadable TLS material before opening a listener", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-material-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    prepareFleetCenterAdmission({
      host: {} as Parameters<typeof prepareFleetCenterAdmission>[0]["host"],
      userRoot: root,
      nodes: { authenticate: () => false, nodeOwner: () => null },
      payload: {
        port: 0,
        keyPath: path.join(root, "missing.key"),
        certPath: path.join(root, "missing.crt"),
        repoId: "repo",
        quotaBytes: 1,
      },
    }),
    /Fleet TLS --key .* could not be read/,
  );
});

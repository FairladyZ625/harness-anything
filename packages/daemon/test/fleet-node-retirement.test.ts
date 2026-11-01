// harness-test-tier: contract
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { managedRbacReceiptJournal } from "../src/access-admin-state.ts";
import { fakeKeycloak, keycloakUserRoot, keycloakUrl, keycloakRealm } from "./keycloak.fixtures.ts";

function retirementFixture(t: TestContext, ownerExists = true) {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot();
  t.after(user.cleanup);
  if (ownerExists) keycloak.account("person-owner");
  const credential = keycloak.node("retired-test-node", "person-owner"),
    oidc = createIdentitySession(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch }),
    provider = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      keycloak.fetch,
    );
  return { admin, provider, credential, userRoot: user.root };
}

test("node-unregister without explicit confirmation previews without changing access or recording a write", async (t) => {
  const { admin, provider, credential, userRoot } = retirementFixture(t),
    before = await provider.readNode("center-token", "retired-test-node");
  assert.equal(await provider.authenticateNode("retired-test-node", credential), true);
  const result = await admin.run({ operation: "node-unregister", nodeId: "retired-test-node", expectedVersion: "1" });
  assert.equal(result.dryRun, true, JSON.stringify(result));
  assert.deepEqual(await provider.readNode("center-token", "retired-test-node"), before);
  assert.equal(await provider.authenticateNode("retired-test-node", credential), true);
  assert.deepEqual(managedRbacReceiptJournal(userRoot).read(), []);
});

test("confirmed retirement revokes a device even when its owner account no longer exists", async (t) => {
  const { admin, provider, credential } = retirementFixture(t, false),
    request = { operation: "node-unregister", nodeId: "retired-test-node", expectedVersion: "1", confirm: true };
  const result = await admin.run(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await provider.authenticateNode("retired-test-node", credential), false);
  const node = await provider.readNode("center-token", "retired-test-node");
  assert.equal(node?.state, "removed");
  assert.equal(node?.revocation, "complete");
});

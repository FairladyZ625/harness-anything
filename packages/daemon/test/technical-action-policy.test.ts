// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { actionDeclarations, deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { BuiltinPolicyAdapter } from "@harness-anything/authorization-builtin";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { readPolicyMetadata } from "../src/policy-metadata-read.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

const config = { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" };
const technicalScopes = ["cli-local-effects", "daemon-local-state", "package-assets-build", "preset-convert-local"];
assert.deepEqual(
  actionDeclarations
    .filter((row) => row.ontology?.technical)
    .map((row) => row.policyAction)
    .sort(),
  technicalScopes,
);
const business = {
  id: "custom-business",
  base: false,
  scopes: ["task-create", "repository-read", "daemon-start"],
  composites: [],
};

function builtin(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-technical-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new BuiltinPolicyAdapter({ userRoot: root });
  adapter.addUser({
    username: "owner",
    personId: "person-owner",
    displayName: "Owner",
    email: "owner@example.invalid",
    password: "fixture-password",
  });
  return { adapter, token: adapter.issueCenterToken() };
}

test("Keycloak scope and resource synchronization exclude technical actions and retain business and local-host scopes", async () => {
  const keycloak = fakeKeycloak(),
    adapter = new KeycloakPolicyAdapter(config, keycloak.fetch);
  keycloak.account("owner");
  await adapter.syncBasePolicy("fixture-admin");
  await adapter.claimRepositoryOwner("fixture-admin", "repo-owned", "owner");
  for (const scope of technicalScopes) {
    assert.equal(keycloak.scopes.has(scope), false, scope);
    assert.ok(
      [...keycloak.resources.values()].every((resource) => resource.scopes.every((row) => row.name !== scope)),
      scope,
    );
    assert.ok(
      [...keycloak.permissions.values()].every((permission) => !permission.scopes.includes(scope)),
      scope,
    );
  }
  for (const scope of business.scopes) {
    assert.equal(keycloak.scopes.has(scope), true, scope);
    assert.ok(
      [...keycloak.resources.values()].every((resource) => resource.scopes.some((row) => row.name === scope)),
      scope,
    );
  }
  assert.ok(keycloak.resources.size > 0);
});

test("Keycloak custom groups reject every technical scope while preserving ordinary host and repository scopes", () => {
  const adapter = new KeycloakPolicyAdapter(config, fakeKeycloak().fetch);
  adapter.validatePolicyGroups([business]);
  for (const scope of technicalScopes)
    assert.throws(
      () => adapter.validatePolicyGroups([{ ...business, scopes: [scope] }]),
      /Unknown Keycloak action scope/u,
    );
});

test("Keycloak technical scopes are unknown to both evaluation APIs and never reach the remote authority", async () => {
  const keycloak = fakeKeycloak(),
    requests: string[] = [];
  const adapter = new KeycloakPolicyAdapter(config, (url, init) => {
    requests.push(String(url));
    return keycloak.fetch(url, init);
  });
  for (const action of technicalScopes) {
    const resource = { kind: "fleet" as const };
    assert.equal(
      (await adapter.authorize({ userAccessToken: "fixture-user", action, resource })).reasonCode,
      "unknown_scope",
    );
    assert.equal(
      (await adapter.authorizePerson({ adminAccessToken: "fixture-admin", personId: "owner", action, resource }))
        .reasonCode,
      "unknown_scope",
    );
  }
  assert.deepEqual(requests, []);
});

test("built-in policy rejects technical custom groups and evaluation while retaining owner authority for business actions", async (t) => {
  const { adapter, token } = builtin(t);
  adapter.validatePolicyGroups([business]);
  for (const scope of technicalScopes)
    assert.throws(
      () => adapter.validatePolicyGroups([{ ...business, scopes: [scope] }]),
      /Unknown built-in action scope/u,
    );
  for (const action of [...technicalScopes, ...business.scopes]) {
    const decision = await adapter.authorizePerson({
      adminAccessToken: token,
      personId: "person-owner",
      action,
      resource: { kind: "fleet" },
    });
    assert.equal(decision.outcome, technicalScopes.includes(action) ? "denied" : "allowed", action);
    if (technicalScopes.includes(action)) assert.equal(decision.reasonCode, "unknown_scope", action);
  }
  const sync = await adapter.syncBasePolicy(token);
  assert.equal(sync.scopeCount, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin").length);
});

test("policy metadata from both production providers omits technical actions and retains all original policy declarations", async (t) => {
  const keycloak = new KeycloakPolicyAdapter(config, fakeKeycloak().fetch),
    local = builtin(t);
  for (const [provider, accessToken] of [
    [keycloak, "fixture-admin"],
    [local.adapter, local.token],
  ] as const) {
    const metadata = await readPolicyMetadata({ provider, accessToken });
    const actions = metadata.actions.map((row) => row.action);
    assert.equal(actions.length, 175);
    for (const scope of technicalScopes) assert.equal(actions.includes(scope), false, scope);
    for (const scope of business.scopes) assert.equal(actions.includes(scope), true, scope);
  }
});

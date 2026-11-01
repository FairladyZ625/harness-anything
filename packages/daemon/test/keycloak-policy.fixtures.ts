import { after } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import {
  compileVerticalContract,
  decodeVerticalDefinition,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  type ActorIdentity,
  type BasePolicyGroupId,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";

// Compile the bundled vertical so the runtime Artifact kind scopes are registered before the
// Base groups are derived; `ha migrate vertical-declaration` does the same in a real repo.
compileVerticalContract(
  decodeVerticalDefinition(JSON.parse(readFileSync(path.join(defaultAssets, "vertical.json"), "utf8"))),
);

// Business suites explicitly provision people and Base groups in this test-file realm. The
// production adapter still performs HTTP evaluation for each action/resource; no decision is
// injected into a binding. Authority-boundary suites use their own realm and exact grants.
const realm = await serveKeycloak(),
  provider = new KeycloakPolicyAdapter(
    { url: realm.url, realm: "harness", resourceServerClientId: "harness-center" },
    realm.fetch,
  ),
  groups = deriveBasePolicyGroups(),
  repositories = new Set<string>(),
  people = new Map<string, { token: string; groups: Set<BasePolicyGroupId> }>();
after(() => realm.close());

export function provisionPolicyTestRepository(repoId: string): void {
  if (repositories.has(repoId)) return;
  repositories.add(repoId);
  refreshPolicyTestRepository(repoId);
}

/** Re-expand a repository's grants after a runtime vertical kind registered new scopes. */
export function refreshPolicyTestRepository(repoId: string): void {
  const current = deriveBasePolicyGroups();
  for (const [personId, person] of people)
    for (const group of person.groups)
      realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(current, group));
}

/**
 * Grant the four CRUD scopes of one runtime-created Artifact kind. The writer process owns the
 * compiled registry, so a test process cannot read it; this fixture mirrors the grant expansion a
 * production syncBasePolicy performs after the kind is accepted.
 */
export function grantArtifactKindScopes(repoId: string, kind: string): void {
  const scopes = ["import", "update", "archive", "delete"].map((action) => `${kind}/${action}`);
  for (const [personId, person] of people)
    for (const group of person.groups) if (group !== "viewer") realm.keycloak.permit(personId, repoId, scopes);
}

export const policyTestCenter = async () => ({
  url: realm.url,
  realm: "harness",
  clientId: "harness-center",
  accessToken: "center-token",
  provider,
});

export function withPolicyGroup<T extends { readonly actor: ActorIdentity }>(binding: T, group: BasePolicyGroupId) {
  const personId = binding.actor.principal.personId;
  let person = people.get(personId);
  if (!person) {
    person = { token: realm.keycloak.account(personId), groups: new Set() };
    people.set(personId, person);
  }
  if (!person.groups.has(group)) {
    person.groups.add(group);
    for (const repoId of repositories)
      realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), group));
  }
  return {
    ...binding,
    keycloakAuthorization: {
      session: {
        provider,
        personId,
        accessToken: person.token,
        url: realm.url,
        realm: "harness",
        clientId: "harness-center",
      },
      center: policyTestCenter,
    },
  };
}

export function grantTestPolicyGroups(personIds: readonly string[], group: BasePolicyGroupId): void {
  for (const personId of personIds) withPolicyGroup({ actor: { principal: { personId }, executor: null } }, group);
}

export function policyTestDeviceToken(personId: string, nodeId: string): string {
  const token = `device-${nodeId}-${personId}`;
  realm.keycloak.interactiveSession(personId, nodeId, realm.url, token);
  return token;
}

/** Changes authority state, so all of a person's existing sessions observe the same revocation. */
export function revokeTestPolicyGroup(personId: string, group: BasePolicyGroupId): void {
  const person = people.get(personId);
  if (!person) throw new Error(`Unknown fixture person ${personId}`);
  person.groups.delete(group);
  for (const repoId of repositories) {
    realm.keycloak.revoke(personId, repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    for (const held of person.groups) realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(groups, held));
  }
}

export function signInPolicyTestUser(
  userRoot: string,
  personId: string,
  repoIds: readonly string[],
  group: BasePolicyGroupId,
): void {
  for (const repoId of repoIds) provisionPolicyTestRepository(repoId);
  withPolicyGroup({ actor: { principal: { personId }, executor: null } }, group);
  realm.bind(userRoot);
  signInAt(userRoot, personId);
}

export function revokeTestPolicyActions(personId: string, repoId: string, actions: readonly string[]): void {
  realm.keycloak.revoke(personId, repoId, actions);
}

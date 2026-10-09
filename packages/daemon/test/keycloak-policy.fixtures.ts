import { after } from "node:test";
import {
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  type ActorIdentity,
  type BasePolicyGroupId,
} from "@harness-anything/kernel";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";

// Business suites explicitly provision people and Base groups in this test-file realm. The
// production adapter still performs HTTP evaluation for each action/resource; no decision is
// injected into a binding. Authority-boundary suites use their own realm and exact grants.
const realm = await serveKeycloak(),
  groups = deriveBasePolicyGroups(),
  repositories = new Set<string>(),
  people = new Map<string, { token: string; groups: Set<BasePolicyGroupId> }>();
after(() => realm.close());

export function provisionPolicyTestRepository(repoId: string): void {
  if (repositories.has(repoId)) return;
  repositories.add(repoId);
  for (const [personId, person] of people)
    for (const group of person.groups)
      realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(groups, group));
}

export const policyTestCenter = async () => ({
  url: realm.url,
  realm: "harness",
  clientId: "harness-center",
  accessToken: "center-token",
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
      realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(groups, group));
  }
  return {
    ...binding,
    keycloakAuthorization: {
      session: {
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

/** Changes authority state, so all of a person's existing sessions observe the same revocation. */
export function revokeTestPolicyGroup(personId: string, group: BasePolicyGroupId): void {
  const person = people.get(personId);
  if (!person) throw new Error(`Unknown fixture person ${personId}`);
  person.groups.delete(group);
  for (const repoId of repositories) {
    realm.keycloak.revoke(personId, repoId, effectivePolicyGroupScopes(groups, "admin"));
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

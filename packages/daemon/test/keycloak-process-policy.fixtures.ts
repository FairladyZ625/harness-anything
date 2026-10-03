import { after } from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes, type BasePolicyGroupId } from "@harness-anything/kernel";
import { spawnKeycloak, signInAt } from "./keycloak.fixtures.ts";

// A separate HTTP process keeps authorization responsive while a CLI fixture uses spawnSync.
const realm = await spawnKeycloak(),
  people = new Set<string>();
after(() => realm.close());

export async function signInProcessPolicyTestUser(
  userRoot: string,
  personId: string,
  repoIds: readonly string[],
  group: BasePolicyGroupId,
): Promise<void> {
  if (!people.has(personId)) {
    await realm.control({ op: "account", personId });
    people.add(personId);
  }
  for (const resource of repoIds)
    await realm.control({
      op: "permit",
      personId,
      resource,
      actions: effectivePolicyGroupScopes(deriveBasePolicyGroups(), group),
    });
  realm.bind(userRoot);
  signInAt(userRoot, personId);
}

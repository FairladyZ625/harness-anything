import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { canonicalResourceAncestors, evaluateKeycloakPerson } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { TaskV2 } from "@harness-anything/kernel";
import type { TaskAssignmentDirectory } from "./protocol/daemon-protocol-gui-types.ts";

/** Directory selection is shared by every assignment Action; the task GUI still consumes the legacy DTO shape. */
export async function readEntityAssignmentDirectory(
  repoId: string,
  entityRef: string,
  binding: RepoCellBinding,
  readEntity?: (taskId: string) => Promise<TaskV2 | null>,
): Promise<TaskAssignmentDirectory> {
  const credential = binding.keycloakAuthorization;
  if (!credential?.center) throw cellCodedError("authentication_required", "Assignment requires Keycloak.");
  const decision = await evaluateKeycloakPerson({
    credential: { session: credential.session },
    personId: binding.actor.principal.personId,
    action: `${entityRef.split("/", 1)[0]}-assign`,
    resource: { kind: "entity", repoId, entityRef },
    resourceAncestors: await canonicalResourceAncestors(readEntity, {
      kind: "entity",
      repoId,
      entityRef,
    }),
  });
  if (decision.outcome !== "allowed")
    throw cellCodedError("authorization_denied", `Assignment directory denied: ${decision.reasonCode}.`);
  const center = await credential.center(),
    adapter = new KeycloakPolicyAdapter({
      url: center.url,
      realm: center.realm,
      resourceServerClientId: center.clientId,
    }),
    [people, nodes, teams] = await Promise.all([
      adapter.readPeople(center.accessToken),
      adapter.readNodes(center.accessToken),
      adapter.readTeams(center.accessToken),
    ]);
  return {
    schema: "task-assignment-directory/v1",
    people: people.map(({ personId, username }) => ({ personId, username })),
    nodes: nodes.filter((node) => node.state === "active").map(({ nodeId, personId }) => ({ nodeId, personId })),
    teams: teams.map(({ id, name }) => ({ id, name })),
  };
}

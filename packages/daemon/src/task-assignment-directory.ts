import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { evaluateKeycloakPerson } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { TaskAssignmentDirectory } from "./protocol/daemon-protocol-gui-types.ts";

/** Selection data for one task; no grants, team membership, credentials or repository contents. */
export async function readTaskAssignmentDirectory(
  repoId: string,
  taskId: string,
  binding: RepoCellBinding,
): Promise<TaskAssignmentDirectory> {
  const credential = binding.keycloakAuthorization;
  if (!credential?.center) throw cellCodedError("authentication_required", "Task assignment requires Keycloak.");
  const decision = await evaluateKeycloakPerson({
    credential,
    personId: binding.actor.principal.personId,
    action: "task-assign",
    resource: { kind: "entity", repoId, entityRef: `task/${taskId}` },
  });
  if (decision.outcome !== "allowed")
    throw cellCodedError("authorization_denied", `Task assignment directory denied: ${decision.reasonCode}.`);
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
    nodes: nodes.map(({ nodeId, personId }) => ({ nodeId, personId })),
    teams: teams.map(({ id, name }) => ({ id, name })),
  };
}

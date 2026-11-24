import type { AssignmentRelationLike, SettingsV1, TaskProjection, TaskV2 } from "@harness-anything/kernel";
import { readClaimableTasks as readApplicationClaimableTasks } from "@harness-anything/application/internal/queries/task-claimable-read.ts";
import { canonicalResourceAncestors, evaluateKeycloakPerson } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

/** A fresh eligibility hint. Starting still re-evaluates permission, assignment and the canonical lease. */
export async function readClaimableTasks(input: {
  readonly repoId: string;
  readonly binding: RepoCellBinding;
  readonly settings: SettingsV1;
  readonly now: string;
  /** A bounded task page. Repository callers route this through guiTasks, which selects
   * scalar index ids before hydrating the requested point set. */
  readonly page: (query: {
    readonly activePackagesOnly: true;
    /** Claimability uses lifecycle status; skip presentation subtree derivation. */
    readonly statusSource: "raw";
    readonly limit: 500;
    readonly cursor?: string;
  }) => Promise<ReturnType<TaskProjection["list"]>>;
  readonly readTask?: (taskId: string) => Promise<TaskV2 | null>;
  readonly readAssignments?: () => Promise<readonly AssignmentRelationLike[]>;
}) {
  const { binding, repoId } = input,
    source = binding.source,
    centerAuthority = binding.keycloakAuthorization?.center;
  if (typeof source !== "object" || source.kind !== "node" || !centerAuthority)
    throw cellCodedError("authentication_required", "Claimable tasks require an authenticated execution node.");
  const center = await centerAuthority(),
    personId = binding.actor.principal.personId,
    permission = await evaluateKeycloakPerson({
      credential: { session: binding.keycloakAuthorization!.session },
      personId,
      action: "task-start",
      resource: { kind: "repository", repoId },
    });
  if (permission.reasonCode === "keycloak_unavailable")
    throw cellCodedError("keycloak_unavailable", "Cannot refresh task claim permissions.");
  const teamIds = await center.provider.readPersonTeams(center.accessToken, personId);
  return readApplicationClaimableTasks({
    settings: input.settings,
    now: input.now,
    page: input.page,
    ...(input.readAssignments ? { readAssignments: input.readAssignments } : {}),
    claimant: { personId, nodeId: source.nodeId, teamIds },
    authorizeRepository: async () => permission,
    authorizeTask: async (taskId) =>
      evaluateKeycloakPerson({
        credential: { session: binding.keycloakAuthorization!.session },
        personId,
        action: "task-start",
        resource: { kind: "entity", repoId, entityRef: `task/${taskId}` },
        resourceAncestors: await canonicalResourceAncestors(input.readTask, {
          kind: "entity",
          repoId,
          entityRef: `task/${taskId}`,
        }),
      }),
    codedError: cellCodedError,
  });
}

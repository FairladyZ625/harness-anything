import {
  explainAuthenticationRequired,
  readTaskActionExplanation as readApplicationTaskActionExplanation,
  type TaskActionExplanationReadDependencies as ApplicationTaskActionExplanationReadDependencies,
} from "@harness-anything/application/internal/queries/task-action-explanation-read.ts";
import {
  getEntityKindContract,
  parseEntityRef,
  type AuthorizationDecision,
  type EntityActionExplainRequestV1,
  type EntityRef,
} from "@harness-anything/kernel";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { isKeycloakTransportFailure, keycloakUnavailableFailure } from "./keycloak-transport-failure.ts";
import { taskActionCommandUsage } from "./protocol/daemon-protocol-commands.ts";
import { compiledArtifactKinds } from "./artifact-entity-action.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { daemonTaskCoreQueryPorts } from "./task-core-query-ports.ts";

export { explainAuthenticationRequired };
export type TaskActionExplanationReadDependencies = Omit<
  ApplicationTaskActionExplanationReadDependencies,
  "host" | "ports"
>;

function daemonAuthorizationUnavailableReasonCodes(): readonly string[] {
  const decision = {
    reasonCodes: ["keycloak_evaluation_missing"],
  };
  return decision.reasonCodes;
}

function requireTaskActionExplanationBinding(binding: RepoCellBinding | undefined): RepoCellBinding {
  return binding ?? explainAuthenticationRequired();
}

export function readTaskActionExplanation(
  dependencies: TaskActionExplanationReadDependencies,
  payload: Readonly<Record<string, unknown>>,
) {
  return readApplicationTaskActionExplanation(
    {
      ...dependencies,
      host: {
        commandUsage: taskActionCommandUsage,
        artifactKinds: compiledArtifactKinds,
        authorizationUnavailableReasonCodes: daemonAuthorizationUnavailableReasonCodes(),
      },
      ports: daemonTaskCoreQueryPorts,
    },
    payload,
  );
}

/** Resolve Person identity and action decisions online before entering the synchronous read cut.
 * Transport failures already surface as `keycloak_unavailable` from the authorization port; every
 * other error keeps its own code so a malformed authority response is not mistaken for an outage. */
export async function preparePersonActionExplanationBinding(
  input: {
    readonly revision: number;
    readonly repoId: string;
    readonly now: () => string;
    readonly binding?: RepoCellBinding;
  },
  payload: Readonly<Record<string, unknown>>,
): Promise<RepoCellBinding> {
  const binding = requireTaskActionExplanationBinding(input.binding),
    request = payload as unknown as EntityActionExplainRequestV1;
  if (request.mode !== "object") return binding;
  // Deduplicate the wire identity before parsing: distinct objects in a Set do not
  // coalesce repeated refs. Decisions are request-local; the next read reauthorizes.
  const refs = [...new Set(request.refs)].flatMap((ref) => {
    const entity = parseEntityRef(ref);
    return entity && !entity.externalHarness && ["person", "task", "squad"].includes(entity.kind)
      ? [{ kind: entity.kind, id: entity.id, ref: entity.raw as EntityRef }]
      : [];
  });
  if (refs.length === 0) return binding;
  const credential = binding.keycloakAuthorization;
  if (!credential)
    return {
      ...binding,
      personExplanation: { existsIds: new Set(), decisions: new Map() },
      explanationDecisions: new Map(),
    };
  const decisions = new Map<string, AuthorizationDecision>(),
    personExistsIds = new Set<string>(),
    revision = input.revision;
  for (const entity of refs) {
    const contract = getEntityKindContract(entity.kind);
    if (!contract?.actionCatalog) throw new Error(`The ${entity.kind} Entity Action catalog is unavailable.`);
    if (entity.kind === "person") {
      let exists: boolean;
      try {
        const center = credential.center ? await credential.center() : undefined;
        exists =
          credential.session?.personId === entity.id ||
          (center !== undefined && (await center.provider.findUserId(center.accessToken, entity.id)) !== undefined);
      } catch (cause) {
        // This is a read-only authority call before the action loop. A transport or 5xx answer
        // means the identity authority is unavailable; malformed responses and other defects
        // keep their own error instead of being relabeled as an outage.
        if (!isKeycloakTransportFailure(cause)) throw cause;
        throw keycloakUnavailableFailure(cause, "resolving the Person identity");
      }
      if (exists) personExistsIds.add(entity.id);
      if (!exists) continue;
    }
    await Promise.all(
      contract.actionCatalog.actions.map(async (action) => {
        const ingress = action.execution?.ingress;
        if (!ingress) return;
        const repoAction = {
            kind: ingress,
            ...(entity.kind === "task"
              ? { taskId: entity.id }
              : entity.kind === "squad"
                ? { squadId: entity.id }
                : { entityRef: entity.ref }),
          } as RepoTaskAction,
          decision = await evaluateRepoCellAction({
            action: repoAction,
            binding,
            actionId: `explain:${revision}:${entity.ref}:${action.id}`,
            repoId: input.repoId,
            revision,
            now: input.now(),
            targetOverride: entity.ref,
          });
        decisions.set(`${entity.ref}:${action.id}`, decision);
      }),
    );
  }
  return {
    ...binding,
    personExplanation: { existsIds: personExistsIds, decisions },
    explanationDecisions: decisions,
  };
}

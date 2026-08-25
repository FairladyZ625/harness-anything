import { getEntityKindContract, TASK_LIFECYCLE_TRANSITIONS, type EntityRef } from "../../kernel/src/index.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

function resolveTransition(transitionId: string, dryRun: boolean) {
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((candidate) => candidate.id === transitionId),
    separator = transitionId.indexOf("_");
  if (!transition || separator < 1) return null;
  const actionId = transitionId.slice(0, separator),
    targetKind = transitionId.slice(separator + 1),
    targetContract = getEntityKindContract(targetKind),
    semanticAction = targetContract?.actionCatalog?.actions.find(
      (candidate) => candidate.id === actionId && candidate.target.kind === targetKind,
    );
  if (!semanticAction || !targetContract) return null;
  const reserves = transition.proof.includes("reservation");
  return {
    transitionId,
    commandType: transition.commandType,
    actionKind: `${semanticAction.target.kind}.${semanticAction.id}`,
    targetIdField: targetContract.id.field,
    targetRef: (id: string) => semanticAction.target.refTemplate.replace("{id}", id) as EntityRef,
    coordination: reserves ? (dryRun ? "preview" : "reserve") : "execute",
  } as const;
}

export function resolveLifecycleAction(action: Pick<RepoTaskAction, "kind"> & { readonly dryRun?: unknown }) {
  const separator = action.kind.indexOf("-");
  if (separator < 1) return null;
  const ingressKind = action.kind.slice(0, separator),
    ingressAction = action.kind.slice(separator + 1).replaceAll("-", "_"),
    ingressCatalog = getEntityKindContract(ingressKind)?.actionCatalog,
    matches = (ingressCatalog?.actions ?? [])
      .filter((candidate) => candidate.id.startsWith(`${ingressAction}_`))
      .map((candidate) => resolveTransition(candidate.id, action.dryRun === true))
      .filter((candidate) => candidate !== null);
  return matches.length === 1 ? matches[0]! : null;
}

export const resolveLifecycleTransition = (transitionId: string) => resolveTransition(transitionId, false);

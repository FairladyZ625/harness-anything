import {
  isIndependentFrom,
  isSamePerson,
  type ActorIdentity,
  type DecisionDocumentState,
  type ReviewIndependence,
} from "@harness-anything/kernel";
import { reject } from "./entity-action-relation.ts";

export function reviewActorsIndependent(
  author: ActorIdentity,
  reviewer: ActorIdentity,
  independence: ReviewIndependence,
): boolean {
  return independence === "execution" ? isIndependentFrom(author, reviewer) : !isSamePerson(author, reviewer);
}

export function assertDecisionReviewerIndependent(
  decision: DecisionDocumentState | null,
  reviewer: ActorIdentity,
  independence: ReviewIndependence,
): void {
  const proposalActor = decision?.proposer;
  if (
    proposalActor === undefined ||
    !reviewActorsIndependent(proposalActor, reviewer, independence) ||
    decision?.amendments?.some((amendment) => !reviewActorsIndependent(amendment.actor, reviewer, independence))
  )
    reject(
      "actor_unauthorized",
      "A Decision review must be independent from the proposal and current content authors.",
    );
}

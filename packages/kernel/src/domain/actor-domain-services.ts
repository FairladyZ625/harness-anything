import type { ReviewIndependence } from "./settings-field-declarations.ts";
import type { ActorIdentity } from "./write-chain.contract.ts";

export function isSamePerson(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.principal.personId === right.principal.personId;
}

export function isSameExecution(left: ActorIdentity, right: ActorIdentity): boolean {
  return (
    isSamePerson(left, right) &&
    left.executor?.kind === right.executor?.kind &&
    left.executor?.id === right.executor?.id
  );
}

export function isIndependentFrom(
  author: ActorIdentity,
  reviewer: ActorIdentity,
  independence: ReviewIndependence = "execution",
): boolean {
  if (independence !== "execution") return !isSamePerson(author, reviewer);
  if (author.executor === null || reviewer.executor === null) {
    return author.executor === null && reviewer.executor === null ? !isSamePerson(author, reviewer) : true;
  }
  return author.executor.id !== reviewer.executor.id;
}

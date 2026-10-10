import { samePrincipal } from "./actor-identity.ts";
import type { ActorIdentity } from "./write-chain.contract.ts";

export function isSameExecution(left: ActorIdentity, right: ActorIdentity): boolean {
  return (
    samePrincipal(left.principal, right.principal) &&
    left.executor?.kind === right.executor?.kind &&
    left.executor?.id === right.executor?.id
  );
}

export function isIndependentFrom(author: ActorIdentity, reviewer: ActorIdentity): boolean {
  if (author.executor === null || reviewer.executor === null) {
    return author.executor === null && reviewer.executor === null
      ? !samePrincipal(author.principal, reviewer.principal)
      : true;
  }
  return author.executor.id !== reviewer.executor.id;
}

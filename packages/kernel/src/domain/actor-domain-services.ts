import type { ActorIdentity } from "./write-chain.contract.ts";
import type { LeaseV1 } from "./execution.ts";

export function isSamePerson(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.principal.personId === right.principal.personId;
}

export function isSameExecution(left: ActorIdentity, right: ActorIdentity): boolean {
  return isSamePerson(left, right)
    && left.executor?.kind === right.executor?.kind
    && left.executor?.id === right.executor?.id;
}

export function isIndependentFrom(author: ActorIdentity, reviewer: ActorIdentity): boolean {
  if (author.executor === null || reviewer.executor === null) {
    return author.executor === null && reviewer.executor === null
      ? !isSamePerson(author, reviewer)
      : true;
  }
  return author.executor.id !== reviewer.executor.id;
}

/** dec_399F48E3547D831F1199F51E84 CH4: only the holder principal may reclaim; phase owns the lapsed judgment. */
export function canReclaim(lease: LeaseV1, caller: ActorIdentity, _now: string): boolean {
  return lease.phase === "orphaned" && isSamePerson(lease.actor, caller);
}

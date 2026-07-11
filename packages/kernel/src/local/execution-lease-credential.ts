import { createHash } from "node:crypto";
import type { TaskHolderPrincipal } from "./task-holder-state.ts";

export function sameTaskHolderPrincipal(left: TaskHolderPrincipal, right: TaskHolderPrincipal): boolean {
  return left.principal.personId === right.principal.personId;
}

export function sameExecutionLeaseActor(left: TaskHolderPrincipal, right: TaskHolderPrincipal): boolean {
  return sameTaskHolderPrincipal(left, right) &&
    left.executor?.kind === right.executor?.kind &&
    left.executor?.id === right.executor?.id;
}

export function hashExecutionLeaseToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

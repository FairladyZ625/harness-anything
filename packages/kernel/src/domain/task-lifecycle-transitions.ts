import type { Transition } from "./task-lifecycle-contract-internal-types.ts";
import { block, cancel, create, reinstate, start, submit, unblock } from "./task-lifecycle-command-transitions.ts";
import { complete, consent, reconcile, review } from "./task-lifecycle-review-transitions.ts";

// Ordered lifecycle transition registry.
export const TASK_LIFECYCLE_TRANSITIONS: readonly Transition[] = Object.freeze([
  create,
  start,
  block,
  reinstate,
  unblock,
  cancel,
  submit,
  review,
  consent,
  reconcile,
  complete,
]);

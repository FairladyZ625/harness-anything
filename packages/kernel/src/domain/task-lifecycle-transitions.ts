import { retireCompletionGeneration } from "./task-completion-generation-retirement.ts";
import type { Transition } from "./task-lifecycle-contract-internal-types.ts";
import {
  block,
  cancel,
  create,
  reinstate,
  returnToPlanned,
  rework,
  start,
  submit,
  unblock,
} from "./task-lifecycle-command-transitions.ts";
import { complete, consent, respondReview, review } from "./task-lifecycle-review-transitions.ts";

// Ordered lifecycle transition registry.
export const TASK_LIFECYCLE_TRANSITIONS: readonly Transition[] = Object.freeze([
  create,
  retireCompletionGeneration,
  start,
  block,
  reinstate,
  returnToPlanned,
  unblock,
  cancel,
  submit,
  rework,
  review,
  respondReview,
  consent,
  complete,
]);

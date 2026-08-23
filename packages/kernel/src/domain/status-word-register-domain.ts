import type { StatusWordRegistration } from "./status-vocabulary-types.ts";

export const domainStatusWords: readonly StatusWordRegistration[] = [
  // ---- Slice-3 domain judgments (registered here when the two slices met on main) ----
  {
    word: "blocked",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf verdict: an active depends-on edge with a non-done target blocks this task.",
    divergence: "divergent",
    resolution:
      "Shares the word with task.status blocked (a lifecycle state); same task can be status=active yet blocking " +
      "state=blocked. Registered as distinct meanings; renaming either is stored-data/API surface — CH2 proposal only.",
  },
  {
    word: "clear",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf verdict: no active blocker.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf could not answer: degraded projection or malformed edge.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection is loaded; blockingOf verdicts are meaningful.",
    divergence: "entity-scoped",
  },
  {
    word: "loading",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection still loading; every blocking verdict is unknown.",
    divergence: "entity-scoped",
  },
  {
    word: "error",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection failed; every blocking verdict is unknown.",
    divergence: "entity-scoped",
  },
  {
    word: "covered",
    entity: "Decision",
    field: "claim coverage status",
    meaning: "coverageOf verdict: the claim's declared fulfillment mode is satisfied by live evidence.",
    divergence: "entity-scoped",
  },
  {
    word: "uncovered",
    entity: "Decision",
    field: "claim coverage status",
    meaning: "coverageOf verdict: no satisfying evidence, or fulfillment undeclared (null).",
    divergence: "entity-scoped",
  },
  {
    word: "standing",
    entity: "FactRecord",
    field: "liveness",
    meaning: "factLiveness verdict: no active supersedes-fact edge targets this fact.",
    divergence: "entity-scoped",
  },
  {
    word: "superseded_fact",
    entity: "FactRecord",
    field: "liveness",
    meaning: "factLiveness verdict: an active supersedes-fact edge targets this fact.",
    divergence: "entity-scoped",
  },
  {
    word: "passed",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "The matching completion-gate witness on the current cut has result pass.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "A matching witness exists on the current cut but its result is not pass.",
    divergence: "entity-scoped",
  },
  {
    word: "missing",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "No witness matches the current execution cut.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "Witness availability could not be read.",
    divergence: "entity-scoped",
  },
  // ---- Task.status (execution coordination; the WIP machine) ----
  {
    word: "planned",
    entity: "Task",
    field: "status",
    meaning: "Task is committed but no execution has opened it yet.",
    divergence: "entity-scoped",
  },
  {
    word: "active",
    entity: "Task",
    field: "status",
    meaning: "Task is in an open executing state and occupies a WIP slot.",
    divergence: "divergent",
    resolution:
      "One of four unrelated `active` concepts (Task/Execution/RelationEdge/Package); rename is stored data " +
      "(task snapshots and events), so this slice registers the meaning instead — CH2 proposal only.",
  },
  {
    word: "blocked",
    entity: "Task",
    field: "status",
    meaning: "Task is held by an external condition; still open, still occupies WIP.",
    divergence: "entity-scoped",
  },
  {
    word: "in_review",
    entity: "Task",
    field: "status",
    meaning: "Task is in the review node; review artifacts are required.",
    divergence: "entity-scoped",
  },
  {
    word: "done",
    entity: "Task",
    field: "status",
    meaning: "Task reached its delivery terminal state.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "Task",
    field: "status",
    meaning:
      "Task was abandoned; terminal except the compensating reinstate rollback to the recorded pre-cancel status.",
    divergence: "entity-scoped",
  },
  {
    word: "open",
    entity: "Task",
    field: "coarse class",
    meaning: "Coarse class of every non-terminal task status.",
    divergence: "entity-scoped",
  },
  {
    word: "terminal",
    entity: "Task",
    field: "coarse class",
    meaning:
      "Coarse class of done/cancelled; no forward transitions (cancelled keeps only the compensating reinstate exit).",
    divergence: "entity-scoped",
  },

  // ---- Decision.state (adjudication outcomes; persisted policy) ----
  {
    word: "proposed",
    entity: "Decision",
    field: "state",
    meaning: "Decision awaits judgment.",
    divergence: "entity-scoped",
  },
  {
    word: "in_effect",
    entity: "Decision",
    field: "state",
    meaning:
      "Decision was accepted and its policy is in effect (accept writes in_effect; there is no separate " +
      "accepted state).",
    divergence: "entity-scoped",
  },
  {
    word: "rejected",
    entity: "Decision",
    field: "state",
    meaning: "Judgment refused the decision; a persistent policy state that feeds later adjudication.",
    divergence: "divergent",
    resolution:
      "The one-shot operation results are now op_rejected (WriteReceipt/PresetRun); the decision word is stored " +
      "policy and keeps rejected.",
  },
  {
    word: "deferred",
    entity: "Decision",
    field: "state",
    meaning: "Judgment postponed; a persistent policy state.",
    divergence: "entity-scoped",
  },
  {
    word: "superseded",
    entity: "Decision",
    field: "state",
    meaning:
      "A later decision replaced this one (ADR-0020 D1: consumers must preserve this state, never fold it " +
      "back into proposed).",
    divergence: "entity-scoped",
  },
  {
    word: "outcome_retired",
    entity: "Decision",
    field: "state",
    meaning: "A human ended the decision's standing deliberately.",
    divergence: "entity-scoped",
  },
  {
    word: "in_effect",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is accept.",
    divergence: "entity-scoped",
  },
  {
    word: "rejected",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is reject.",
    divergence: "entity-scoped",
  },
  {
    word: "deferred",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is defer.",
    divergence: "entity-scoped",
  },
];

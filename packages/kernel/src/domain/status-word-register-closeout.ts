import type { StatusWordRegistration } from "./status-vocabulary.ts";

/**
 * `waived`: a recorded automated fail covered by a human override — satisfied, never reported as passed.
 * `signoff_missing`: the automated witness passed but the gate's mandatory human signoff is absent.
 */
export const closeoutGateStatuses = [
  "passed",
  "waived",
  "failed",
  "missing",
  "signoff_missing",
  "unknown",
  "not_applicable",
] as const;
export type CloseoutGateStatus = (typeof closeoutGateStatuses)[number];
/** TaskCloseout registrations: the per-gate witness verdict and the readiness label that aggregates it. */
export const closeoutStatusWordRegister: readonly StatusWordRegistration[] = [
  // ---- TaskCloseout.gate status (per-gate witness judgment) ----
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
  {
    word: "waived",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "A recorded automated fail on the current cut is covered by a human override that names it.",
    divergence: "entity-scoped",
  },
  {
    word: "signoff_missing",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "The automated witness passed, but the gate's mandatory human signoff is absent on the current cut.",
    divergence: "entity-scoped",
  },
  {
    word: "not_applicable",
    entity: "TaskCloseout",
    field: "gate status",
    meaning: "A frozen gate requirement whose declared scope this cut does not deliver; neither a pass nor missing.",
    divergence: "entity-scoped",
  },
  // ---- TaskCloseout.readiness (closeout judgment result) ----
  {
    word: "not_required",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout gate does not apply to this task.",
    divergence: "entity-scoped",
  },
  {
    word: "missing",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Required closeout material is absent.",
    divergence: "entity-scoped",
  },
  {
    word: "incomplete",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout material exists but is not complete.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout material is ready for the gate.",
    divergence: "entity-scoped",
  },
  {
    word: "passed",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Completion gate witness passed.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Completion gate witness failed.",
    divergence: "entity-scoped",
  },
];

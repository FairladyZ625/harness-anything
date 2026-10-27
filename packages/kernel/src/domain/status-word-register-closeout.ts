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
  // ---- ReviewFinding.disposition (dec_6A77D43B8523823ABA1F5E4D3C CH2/CH3) ----
  // The five dispositions the `review-finding-triage` Decision point may select. Each word is a
  // judgment about one finding, not about the review that raised it.
  {
    word: "blocker",
    entity: "Review",
    field: "finding disposition",
    meaning: "The finding names work this cut must fix before it can settle.",
    divergence: "entity-scoped",
  },
  {
    word: "non_blocking",
    entity: "Review",
    field: "finding disposition",
    meaning: "The finding is real and worth fixing, but it does not hold this cut.",
    divergence: "entity-scoped",
  },
  {
    word: "nit",
    entity: "Review",
    field: "finding disposition",
    meaning: "A preference with no correctness consequence; recorded so it is not re-raised.",
    divergence: "entity-scoped",
  },
  {
    word: "pre_existing",
    entity: "Review",
    field: "finding disposition",
    meaning: "The finding holds on the base, not this cut; it belongs to the work that introduced it.",
    divergence: "entity-scoped",
  },
  {
    word: "false_positive",
    entity: "Review",
    field: "finding disposition",
    meaning: "The finding does not describe the delivered code and is withdrawn.",
    divergence: "entity-scoped",
  },
  // ---- ReviewCut.settlement outcome ----
  {
    word: "passed",
    entity: "Review",
    field: "settlement outcome",
    meaning: "Every finding on the cut is disposed without a blocker, so the cut may settle.",
    divergence: "entity-scoped",
  },
  {
    word: "changes_requested",
    entity: "Review",
    field: "settlement outcome",
    meaning: "Settlement found a blocking finding on this cut, which must be fixed before it settles.",
    divergence: "entity-scoped",
  },
  {
    word: "escalated",
    entity: "Review",
    field: "settlement outcome",
    meaning: "A finding could not be classified safely inside the thresholds, so a person decides the cut.",
    divergence: "entity-scoped",
  },
];

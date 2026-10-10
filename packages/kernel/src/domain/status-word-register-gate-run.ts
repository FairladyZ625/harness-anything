import type { StatusWordRegistration } from "./status-vocabulary.ts";

/** Gate execution lifecycle, measured result, and availability have separate meanings. */
export const gateRunStatusWordRegister: readonly StatusWordRegistration[] = [
  {
    word: "running",
    entity: "GateRun",
    field: "state",
    meaning: "The current gate run holds its claim and has no terminal observation.",
    divergence: "entity-scoped",
  },
  {
    word: "completed",
    entity: "GateRun",
    field: "state",
    meaning: "The gate run has one terminal result or an unavailable observation.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "GateRun",
    field: "state",
    meaning: "An authorized revocation ended the gate run without a usable verdict.",
    divergence: "entity-scoped",
  },
  {
    word: "pass",
    entity: "GateRun",
    field: "result",
    meaning: "The run observed that the frozen gate requirement is satisfied.",
    divergence: "entity-scoped",
  },
  {
    word: "fail",
    entity: "GateRun",
    field: "result",
    meaning: "The run observed that the frozen gate requirement is unsatisfied.",
    divergence: "entity-scoped",
  },
  {
    word: "available",
    entity: "GateRun",
    field: "availability",
    meaning: "The run produced an admitted measured verdict.",
    divergence: "entity-scoped",
  },
  {
    word: "unavailable",
    entity: "GateRun",
    field: "availability",
    meaning: "Execution or its inputs were unavailable, so no verdict exists.",
    divergence: "entity-scoped",
  },
];

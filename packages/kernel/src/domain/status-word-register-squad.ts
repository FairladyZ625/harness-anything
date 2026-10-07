import type { StatusWordRegistration } from "./status-vocabulary.ts";

/** The six Squad run phases; the canonical Squad run contract owns their single definition. */
export const squadRunStatusWordRegister: readonly StatusWordRegistration[] = [
  {
    word: "planning",
    entity: "SquadRun",
    field: "phase",
    meaning: "The Squad run is preparing its next leader turn.",
    divergence: "entity-scoped",
  },
  {
    word: "leader_running",
    entity: "SquadRun",
    field: "phase",
    meaning: "The Squad leader turn has been dispatched and has not settled.",
    divergence: "entity-scoped",
  },
  {
    word: "workers_running",
    entity: "SquadRun",
    field: "phase",
    meaning: "The Squad run is awaiting its dispatched worker attempts.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "SquadRun",
    field: "phase",
    meaning: "The owner reported the Squad run cancelled; this does not assert every process was killed.",
    divergence: "entity-scoped",
  },
  {
    word: "converged",
    entity: "SquadRun",
    field: "phase",
    meaning: "The owner reported the Squad run converged.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "SquadRun",
    field: "phase",
    meaning: "The owner reported that the Squad run failed.",
    divergence: "entity-scoped",
  },
];

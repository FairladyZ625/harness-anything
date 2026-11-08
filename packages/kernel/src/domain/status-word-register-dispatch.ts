import type { StatusWordRegistration } from "./status-vocabulary.ts";
import {
  dispatchAttemptPhases,
  dispatchCapacityDispositions,
  dispatchGroupPhases,
  dispatchReservationStates,
  dispatchStopProofs,
} from "./dispatch-lifecycle.ts";

/** Dispatch lifecycle vocabulary (dec_AEB05951C69E47FCE53E53C341 CH1); one meaning per field. */
export const dispatchStatusWordRegister: readonly StatusWordRegistration[] = [
  ...dispatchGroupPhases.map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "group phase",
    meaning: `Dispatch attempt group is in the ${word} lifecycle phase.`,
    divergence: "entity-scoped" as const,
  })),
  ...dispatchAttemptPhases.map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "attempt phase",
    meaning: `Dispatch attempt is in the ${word} lifecycle phase.`,
    divergence: "entity-scoped" as const,
  })),
  ...dispatchCapacityDispositions.map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "capacity disposition",
    meaning: `The dispatch attempt's provider slot is ${word} to admission.`,
    divergence: "entity-scoped" as const,
  })),
  ...dispatchReservationStates.map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "capacity reservation",
    meaning: `The dispatch attempt's provider slot reservation is ${word}.`,
    divergence: "entity-scoped" as const,
  })),
  ...dispatchStopProofs.map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "stop proof",
    meaning: `The dispatch attempt's provider process stop is ${word.replace("_", " ")}.`,
    divergence: "entity-scoped" as const,
  })),
];

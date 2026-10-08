// Historical fixture construction uses the read-only decoder, never current admission.
export { decodeCiObservation, legacyCiDetail } from "../../src/domain/ci-run-observation-v4.ts";
export type { CiRunObservationEventV2, CiRunObservationEventV3 } from "../../src/domain/ci-run-observation-event.ts";

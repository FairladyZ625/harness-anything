import {
  CI_RUN_OBSERVATION_SCHEMA,
  CiRunObservationContractError,
  serializeCiRunObservationEvent,
  validateCiRunObservationEvent,
} from "./ci-run-observation-event.ts";

const ciRunObservationContract = Object.freeze({
  id: "ci-run-observation",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze([]),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([
    Object.freeze({
      id: CI_RUN_OBSERVATION_SCHEMA.id,
      schema: "packages/kernel/src/domain/ci-run-observation-event.ts#CI_RUN_OBSERVATION_SCHEMA",
      parser: "packages/kernel/src/domain/ci-run-observation-event.ts#validateCiRunObservationEvent",
      writer: "packages/kernel/src/domain/ci-run-observation-event.ts#serializeCiRunObservationEvent",
      error: "packages/kernel/src/domain/ci-run-observation-event.ts#CiRunObservationContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/ci-run-observation-invalid.json"]),
    }),
  ]),
});

void serializeCiRunObservationEvent;
void validateCiRunObservationEvent;
void CiRunObservationContractError;

export default ciRunObservationContract;

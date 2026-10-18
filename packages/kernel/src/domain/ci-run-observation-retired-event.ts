import {
  validateCiRunObservationEvent,
  validateCiRunObservationEventV2,
  validateCiRunObservationEventV1,
  type CiRunObservationEventV1,
  type CiRunObservationEventV2,
  type CiRunObservationEventV3,
} from "./ci-run-observation-event.ts";
import { validateCiRunObservationEventV4, type CiRunObservationEventV4 } from "./ci-run-observation-v4.ts";
import { isRecord } from "./write-chain.contract.ts";

export type RetiredCiRunObservationEventV1 =
  | CiRunObservationEventV1
  | CiRunObservationEventV2
  | CiRunObservationEventV3
  | CiRunObservationEventV4;

/** Historical observation envelopes remain parseable, but have no current write schema. */
export function validateRetiredCiRunObservationEvent(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["retired CI observation envelope is invalid"];
  switch (value.schema) {
    case "ci-run-observation/v1":
      return validateCiRunObservationEventV1(value);
    case "ci-run-observation/v2":
      return validateCiRunObservationEventV2(value);
    case "ci-run-observation/v3":
      return validateCiRunObservationEvent(value);
    case "ci-run-observation/v4":
      return validateCiRunObservationEventV4(value);
    default:
      return ["retired CI observation schema is unknown"];
  }
}

export function isRetiredCiRunObservationEvent(event: {
  readonly schema: string;
}): event is RetiredCiRunObservationEventV1 {
  return /^ci-run-observation\/v[1234]$/u.test(event.schema);
}

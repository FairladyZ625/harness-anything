import * as Schema from "effect/Schema";
import { validateDecisionEvent, type DecisionEventV1 } from "../domain/decision-event.ts";

export const DecisionEventSchema = Schema.declare(
  (value): value is DecisionEventV1 => validateDecisionEvent(value).length === 0,
  {
    identifier: "DecisionEventV1",
    description: "Canonical closed Decision event validated by the zero-dependency wire validator.",
  },
);

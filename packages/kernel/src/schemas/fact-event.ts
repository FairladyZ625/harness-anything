import { Schema } from "effect";
import { validateDecisionEvent, validateFactEvent, type DecisionEventV1, type FactEventV1 } from "../domain/fact-event.ts";

export const FactEventSchema = Schema.declare((value): value is FactEventV1 => validateFactEvent(value).length === 0,
  { identifier: "FactEventV1", description: "Canonical closed Fact event validated by the zero-dependency wire validator." });
export const DecisionEventSchema = Schema.declare((value): value is DecisionEventV1 => validateDecisionEvent(value).length === 0,
  { identifier: "DecisionEventV1", description: "Canonical closed Decision event validated by the zero-dependency wire validator." });

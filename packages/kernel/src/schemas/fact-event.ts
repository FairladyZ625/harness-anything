import { Schema } from "effect";
import { validateFactEvent, type FactEventV1 } from "../domain/fact-event.ts";

export const FactEventSchema = Schema.declare((value): value is FactEventV1 => validateFactEvent(value).length === 0,
  { identifier: "FactEventV1", description: "Canonical closed Fact event validated by the zero-dependency wire validator." });

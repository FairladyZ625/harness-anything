import { Schema } from "effect";
import {
  PresetCapabilityProductionSchema,
  PresetCapabilityRequirementSchema
} from "./preset-manifest-v3.ts";

export function isPresetCapabilityRequestShape(
  direction: "requires" | "produces",
  input: unknown
): boolean {
  try {
    if (direction === "requires") {
      Schema.decodeUnknownSync(PresetCapabilityRequirementSchema)(input);
    } else {
      Schema.decodeUnknownSync(PresetCapabilityProductionSchema)(input);
    }
    return true;
  } catch {
    return false;
  }
}

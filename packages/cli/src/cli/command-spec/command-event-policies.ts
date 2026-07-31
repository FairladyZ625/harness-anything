import type { CommandEventPolicySpec } from "./types.ts";

export const writeCommandEventPolicy = {
  conflictMarkerPreflight: true,
  runtimeEvent: "auto"
} as const satisfies CommandEventPolicySpec;

export const readCommandEventPolicy = {
  conflictMarkerPreflight: false,
  runtimeEvent: "none"
} as const satisfies CommandEventPolicySpec;

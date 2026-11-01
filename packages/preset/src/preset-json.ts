import { presetFailure } from "./preset-resolver-common.ts";

/** Parses a preset JSON document, mapping syntax errors onto the caller's failure code. */
export function parsePresetJson(body: string, code: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw presetFailure(code, "JSON input is invalid.");
  }
}

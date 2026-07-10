import type { CommandParseResult } from "./command-spec/types.ts";

export function parseDoctorArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): CommandParseResult | null {
  if (args[0] !== "doctor") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: { kind: "doctor" }
    }
  };
}

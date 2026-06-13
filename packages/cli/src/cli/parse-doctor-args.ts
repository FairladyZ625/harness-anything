import type { ParsedCommand } from "./types.ts";

export function parseDoctorArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): ParsedCommand | undefined {
  if (args[0] !== "doctor") return undefined;
  return {
    rootDir,
    json,
    action: { kind: "doctor" }
  };
}

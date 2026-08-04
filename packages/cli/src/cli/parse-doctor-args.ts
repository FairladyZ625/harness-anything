import type { CommandParseResult } from "./command-spec/types.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";

export function parseDoctorArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): CommandParseResult | null {
  if (args[0] !== "doctor") return null;
  const unknown = args.slice(1).filter((arg) => arg !== "--repair" && arg !== "--json");
  if (unknown.length > 0) {
    return {
      ok: false,
      error: cliError(CliErrorCode.UnknownCommand, `Unknown doctor option: ${unknown[0]}. Use ha doctor [--repair] --json.`)
    };
  }
  const repair = args.includes("--repair");
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: { kind: "doctor", ...(repair ? { repair: true } : {}) }
    }
  };
}

import { CliErrorCode, withCliErrorCode } from "../../cli/error-codes.ts";
import { readOption } from "../../cli/parse-options.ts";

export function requiredDaemonOption(args: ReadonlyArray<string>, name: string): string {
  const value = readOption(args, name);
  if (!value || value.startsWith("--")) throw withCliErrorCode(new Error(`Use ${name} <value>.`), CliErrorCode.MissingRequiredOption);
  return value;
}

export function daemonSafeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "user";
}

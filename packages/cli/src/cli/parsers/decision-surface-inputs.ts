import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult } from "../types.ts";

type SurfaceParseResult =
  | { readonly ok: true; readonly value?: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: CliResult["error"] };

export function parseDecisionSurfaceInputs(
  args: ReadonlyArray<string>,
  input: ReadonlyArray<string> = []
): SurfaceParseResult {
  const values = [...input];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--surface=")) {
      values.push(arg.slice("--surface=".length));
      continue;
    }
    if (arg !== "--surface") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return {
        ok: false,
        error: cliError(
          CliErrorCode.InvalidJsonInput,
          "Use --surface <token>. For flag-shaped surfaces use the equals form, for example --surface=--body."
        )
      };
    }
    values.push(value);
  }

  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    return {
      ok: false,
      error: cliError(CliErrorCode.InvalidJsonInput, "Decision surface anchors must be non-empty.")
    };
  }
  return {
    ok: true,
    ...(normalized.length > 0
      ? { value: [...new Map(normalized.map((value) => [value.toLocaleLowerCase(), value])).values()] }
      : {})
  };
}

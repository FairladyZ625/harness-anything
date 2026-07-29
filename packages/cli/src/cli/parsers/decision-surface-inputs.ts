import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult } from "../types.ts";
import { normalizeDecisionSurfaceValues } from "../decision-surface-values.ts";

type SurfaceParseResult =
  | { readonly ok: true; readonly value?: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: CliResult["error"] };

export function parseDecisionSurfaceInputs(
  args: ReadonlyArray<string>,
  input: unknown = []
): SurfaceParseResult {
  const initial = normalizeDecisionSurfaceValues(input);
  if (!initial.ok) return invalidSurfaceResult(initial.reason);
  const values = [...initial.value];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--surface=")) {
      values.push(arg.slice("--surface=".length));
      continue;
    }
    if (arg !== "--surface") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
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

  const normalized = normalizeDecisionSurfaceValues(values);
  if (!normalized.ok) return invalidSurfaceResult(normalized.reason);
  return {
    ok: true,
    ...(normalized.value.length > 0
      ? { value: normalized.value }
      : {})
  };
}

function invalidSurfaceResult(reason: string): SurfaceParseResult {
  return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, reason) };
}

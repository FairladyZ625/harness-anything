import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult } from "../types.ts";

const actorKinds = new Set(["agent", "human", "system"]);

export function isDecisionActorRef(value: string): boolean {
  const separator = value.indexOf(":");
  return separator > 0 && separator < value.length - 1 && actorKinds.has(value.slice(0, separator));
}

export function invalidDecisionActor(): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidDecisionActor, "Use actor refs as agent:<id>, human:<id>, or system:<id>.") };
}

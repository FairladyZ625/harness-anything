import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { capabilityEntityKinds } from "../capability-entity-kinds.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const knownEntityKinds = new Set(capabilityEntityKinds);

export function parseCapabilitiesArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "entity" && args[1] === "list") return { ok: true, value: { rootDir, json, action: { kind: "entity-list" } } };
  if (args[0] === "capabilities") {
    const entityKind = readOption(args, "--kind") ?? (args[1] && knownEntityKinds.has(args[1]) ? args[1] : undefined);
    return { ok: true, value: { rootDir, json, action: { kind: "capabilities", entityKind } } };
  }
  if (args[1] === "capabilities" && args[0] && knownEntityKinds.has(args[0])) {
    return { ok: true, value: { rootDir, json, action: { kind: "capabilities", entityKind: args[0] } } };
  }
  return null;
}

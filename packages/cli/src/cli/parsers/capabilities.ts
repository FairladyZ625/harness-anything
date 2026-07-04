import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const knownEntityKinds = new Set(["task", "decision", "fact", "event", "doc", "template", "preset", "script", "module", "legacy", "migrate", "governance", "status", "git", "doctor", "graph", "vertical", "gui"]);

export function parseCapabilitiesArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "entity" && args[1] === "list") return { ok: true, value: { rootDir, json, action: { kind: "entity-list" } } };
  if (args[0] === "capabilities") {
    return { ok: true, value: { rootDir, json, action: { kind: "capabilities", entityKind: readOption(args, "--kind") } } };
  }
  if (args[1] === "capabilities" && args[0] && knownEntityKinds.has(args[0])) {
    return { ok: true, value: { rootDir, json, action: { kind: "capabilities", entityKind: args[0] } } };
  }
  return null;
}

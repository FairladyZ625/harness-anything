import { readRepeatedOption } from "../parse-options.ts";
import type { ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand };

export function parseDocArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "doc") return null;
  const subcommand = args[1];
  if (subcommand === "status") {
    return { ok: true, value: { rootDir, json, action: { kind: "doc-status" } } };
  }
  if (subcommand === "sync" && args.includes("--dry-run")) {
    return { ok: true, value: { rootDir, json, action: { kind: "doc-sync-dry-run" } } };
  }
  if (subcommand === "sync" && args.includes("--submit")) {
    return { ok: true, value: { rootDir, json, action: { kind: "doc-sync-submit", paths: readRepeatedOption(args, "--path") } } };
  }
  return null;
}

import { readOption } from "../parse-options.ts";
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
  if (subcommand !== "list" && subcommand !== "map" && subcommand !== "generate") return null;
  const filters = {
    moduleKey: readOption(args, "--module"),
    productLine: readOption(args, "--product-line")
  };
  if (subcommand === "generate") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "doc-generate",
          filters,
          write: args.includes("--write")
        }
      }
    };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: subcommand === "list" ? "doc-list" : "doc-map",
        filters
      }
    }
  };
}

import { readOption } from "../parse-options.ts";
import type { ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand };

export function parseDocArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "doc") return null;
  const subcommand = args[1];
  if (subcommand !== "list" && subcommand !== "map") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: subcommand === "list" ? "doc-list" : "doc-map",
        filters: {
          moduleKey: readOption(args, "--module"),
          productLine: readOption(args, "--product-line")
        }
      }
    }
  };
}

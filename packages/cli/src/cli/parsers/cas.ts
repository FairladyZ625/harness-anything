import type { ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand };

export function parseCasArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "cas" || args[1] !== "gc") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: { kind: "cas-gc", mode: args.includes("--apply") ? "apply" : "dry-run" }
    }
  };
}

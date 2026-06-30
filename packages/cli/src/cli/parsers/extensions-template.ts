import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTemplateArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "template" && args[1] === "list") {
    const catalogPath = readOption(args, "--catalog");
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "template-list",
          catalogPath
        }
      }
    };
  }

  if (args[0] === "template" && args[1] === "render" && args[2]) {
    const catalogPath = readOption(args, "--catalog");
    const locale = readOption(args, "--locale") ?? "zh-CN";
    if (locale !== "zh-CN" && locale !== "en-US") {
      return { ok: false, error: cliError(CliErrorCode.InvalidLocale, `Unknown locale: ${locale}`) };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "template-render",
          templateRef: args[2],
          catalogPath,
          locale
        }
      }
    };
  }

  return null;
}

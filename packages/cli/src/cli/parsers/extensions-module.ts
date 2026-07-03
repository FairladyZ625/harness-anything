import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseModuleArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "module" && args[1] === "list") {
    return { ok: true, value: { rootDir, json, action: { kind: "module-list" } } };
  }

  if (args[0] === "module" && args[1] === "inspect" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-inspect", moduleKey: args[2] } } };
  }

  if (args[0] === "module" && args[1] === "register" && args[2]) {
    const title = readOption(args, "--title");
    const scope = readOption(args, "--scope");
    if (!title || !scope) return { ok: false, error: cliError(CliErrorCode.MissingModuleFields, "module register requires --title and --scope.") };
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "module-register",
          moduleKey: args[2],
          title,
          scope,
          prefix: readOption(args, "--prefix"),
          status: readOption(args, "--status"),
          branch: readOption(args, "--branch"),
          owner: readOption(args, "--owner"),
          currentStep: readOption(args, "--current-step"),
          shared: readRepeatedOption(args, "--shared"),
          dependsOn: readRepeatedOption(args, "--depends-on")
        }
      }
    };
  }

  if (args[0] === "module" && args[1] === "scaffold" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-scaffold", moduleKey: args[2] } } };
  }

  if (args[0] === "module" && args[1] === "unregister" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-unregister", moduleKey: args[2] } } };
  }

  if (args[0] === "module-step" && args[1] && args[2]) {
    const state = readOption(args, "--state") ?? "in-progress";
    if (state !== "planned" && state !== "in-progress" && state !== "blocked" && state !== "done") {
      return { ok: false, error: cliError(CliErrorCode.InvalidModuleStepState, `Unknown module step state: ${state}`) };
    }
    return { ok: true, value: { rootDir, json, action: { kind: "module-step", moduleKey: args[1], stepId: args[2], state } } };
  }

  return null;
}

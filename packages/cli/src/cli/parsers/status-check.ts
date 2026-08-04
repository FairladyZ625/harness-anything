import { normalizeRelativeDocumentPath } from "@harness-anything/kernel";
import { isCheckProfile } from "../../commands/check-profile-types.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseStatusCheckArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "status") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "status"
        }
      }
    };
  }

  if (args[0] === "check") {
    const profile = readOption(args, "--profile") ?? "source-package";
    if (!isCheckProfile(profile)) {
      return { ok: false, error: cliError(CliErrorCode.InvalidCheckProfile, `Unknown check profile: ${profile}`) };
    }
    const taskOption = readRequiredValueOption(args, "--task");
    const pathOption = readRequiredValueOption(args, "--path");
    if (!taskOption.ok || !pathOption.ok) {
      return { ok: false, error: cliError(CliErrorCode.InvalidCheckScope) };
    }
    if (taskOption.value && pathOption.value) {
      return { ok: false, error: cliError(CliErrorCode.InvalidCheckScope, "Check accepts only one scope. Keep `--task <task-id>` or `--path <task-package-path>`, then retry.") };
    }
    let scope: Extract<ParsedCommand["action"], { readonly kind: "check" }>["scope"];
    if (taskOption.value) scope = { kind: "task-tree", taskId: taskOption.value };
    if (pathOption.value) {
      try {
        scope = { kind: "path", path: normalizeRelativeDocumentPath(pathOption.value) };
      } catch {
        return { ok: false, error: cliError(CliErrorCode.InvalidCheckScope) };
      }
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "check",
          profile,
          strict: args.includes("--strict"),
          postMerge: args.includes("--post-merge"),
          ...(scope ? { scope } : {})
        }
      }
    };
  }

  if (args[0] === "governance" && args[1] === "rebuild") {
    const mode = args.includes("--dry-run") ? "dry-run" : args.includes("--archive") ? "archive" : "apply";
    const selectedModes = [args.includes("--dry-run"), args.includes("--archive"), args.includes("--apply")].filter(Boolean).length;
    if (selectedModes > 1) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingGovernanceMode, "Use only one of --dry-run, --archive, or --apply.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "governance-rebuild",
          mode
        }
      }
    };
  }

  return null;
}

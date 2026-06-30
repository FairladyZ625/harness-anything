import { isCheckProfile } from "../../commands/check.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
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
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "check",
          profile,
          strict: args.includes("--strict"),
          postMerge: args.includes("--post-merge")
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

  if (args[0] === "lesson-promote" && args[1] && args[2]) {
    const mode = args.includes("--apply") ? "apply" : "dry-run";
    if (args.includes("--apply") && args.includes("--dry-run")) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingLessonMode, "Use either --dry-run or --apply.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "lesson-promote",
          taskId: args[1],
          candidateId: args[2],
          mode
        }
      }
    };
  }

  if (args[0] === "lesson-sediment" && args[1] && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "lesson-sediment",
          taskId: args[1],
          candidateId: args[2],
          mode: "dry-run",
          title: readOption(args, "--title") ?? args[2]
        }
      }
    };
  }

  return null;
}

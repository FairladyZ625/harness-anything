import { cliError, CliErrorCode } from "./error-codes.ts";
import { readOption, readRequiredValueOption } from "./parse-options.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseMigrationArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "adopt" && args[1] === "multica" && args[2]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTask, "adopt multica requires --task <task-id>.") };
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "adopt-multica",
          taskId,
          ref: args[2],
          title: readOption(args, "--title") ?? `Multica ${args[2]}`,
          status: readOption(args, "--status") ?? "Todo",
          url: readOption(args, "--url") ?? ""
        }
      }
    };
  }

  if (args[0] === "snapshot" && args[1] === "multica" && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "snapshot-multica",
          ref: args[2],
          title: readOption(args, "--title") ?? `Multica ${args[2]}`,
          status: readOption(args, "--status") ?? "Todo",
          url: readOption(args, "--url") ?? ""
        }
      }
    };
  }

  const migrateArgs = args[0] === "migrate" && args[1] ? [`migrate-${args[1]}`, ...args.slice(2)] : args;

  if (migrateArgs[0] === "migrate-plan") {
    const limit = Number(readOption(migrateArgs, "--limit") ?? Number.POSITIVE_INFINITY);
    return { ok: true, value: { rootDir, json, action: { kind: "migrate-plan", limit } } };
  }

  if (migrateArgs[0] === "migrate-structure") {
    if (migrateArgs.includes("--plan") && migrateArgs.includes("--apply")) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingMigrationMode, "Use only one of --plan or --apply.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-structure",
          mode: migrateArgs.includes("--apply") ? "apply" : "plan",
          confirmPlan: migrateArgs.includes("--confirm-plan")
        }
      }
    };
  }

  if (migrateArgs[0] === "migrate-anchors") {
    if (migrateArgs.includes("--dry-run") && migrateArgs.includes("--apply")) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingMigrationMode, "Use only one of --dry-run or --apply.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-anchors",
          mode: migrateArgs.includes("--apply") ? "apply" : "dry-run"
        }
      }
    };
  }

  if (migrateArgs[0] === "migrate-fact-execution") {
    if (migrateArgs.includes("--dry-run") && migrateArgs.includes("--apply")) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingMigrationMode, "Use only one of --dry-run or --apply.") };
    }
    const batchSize = Number(readOption(migrateArgs, "--batch-size") ?? 50);
    const batch = Number(readOption(migrateArgs, "--batch") ?? 1);
    const sampleSize = Number(readOption(migrateArgs, "--sample-size") ?? 5);
    const manualList = readRequiredValueOption(migrateArgs, "--apply-manual");
    if (!manualList.ok) return manualList;
    if (![batchSize, batch, sampleSize].every((value) => Number.isSafeInteger(value) && value > 0) || batchSize > 200) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingMigrationMode, "Use positive integer batch/sample sizes; --batch-size is capped at 200.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-fact-execution",
          mode: migrateArgs.includes("--apply") ? "apply" : "dry-run",
          batchSize,
          batch,
          sampleSize,
          confirmPlan: readOption(migrateArgs, "--confirm-plan"),
          manualListFile: manualList.value
        }
      }
    };
  }

  if (migrateArgs[0] === "migrate-provenance") {
    if (migrateArgs.includes("--dry-run") && migrateArgs.includes("--apply")) {
      return { ok: false, error: cliError(CliErrorCode.ConflictingMigrationMode, "Use only one of --dry-run or --apply.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-provenance",
          mode: migrateArgs.includes("--apply") ? "apply" : "dry-run"
        }
      }
    };
  }

  if (migrateArgs[0] === "migrate-run") {
    const locale = readOption(migrateArgs, "--locale");
    const assumeLocale = readOption(migrateArgs, "--assume-locale");
    if (locale && locale !== "zh-CN" && locale !== "en-US") return { ok: false, error: cliError(CliErrorCode.InvalidLocale, "Use --locale zh-CN or --locale en-US.") };
    if (assumeLocale && assumeLocale !== "zh-CN" && assumeLocale !== "en-US") return { ok: false, error: cliError(CliErrorCode.InvalidLocale, "Use --assume-locale zh-CN or en-US.") };
    const sessionDir = readOption(migrateArgs, "--session-dir");
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-run",
          planOnly: migrateArgs.includes("--plan-only"),
          outDir: sessionDir ?? readOption(migrateArgs, "--out-dir") ?? ".harness/generated/migration-sessions/latest",
          locale: locale as "zh-CN" | "en-US" | undefined,
          assumeLocale: assumeLocale as "zh-CN" | "en-US" | undefined,
          allowDirty: migrateArgs.includes("--allow-dirty"),
          sessionDir
        }
      }
    };
  }

  if (migrateArgs[0] === "migrate-verify" && migrateArgs[1]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-verify",
          sessionPath: migrateArgs[1],
          fullCutover: migrateArgs.includes("--full-cutover")
        }
      }
    };
  }

  if (args[0] === "legacy" && args[1] === "scan" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-scan", sourcePath: args[2] } } };
  }

  if (args[0] === "legacy" && (args[1] === "plan" || args[1] === "intake-plan") && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-intake-plan", sourcePath: args[2], outPath: readOption(args, "--out") } } };
  }

  if (args[0] === "legacy" && (args[1] === "copy-docs" || args[1] === "copy-safe-docs") && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-copy-safe-docs", sourcePath: args[2], apply: args.includes("--apply") } } };
  }

  if (args[0] === "legacy" && args[1] === "index" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-index", sourcePath: args[2], apply: args.includes("--apply") } } };
  }

  if (args[0] === "legacy" && args[1] === "verify") {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-verify" } } };
  }

  return null;
}

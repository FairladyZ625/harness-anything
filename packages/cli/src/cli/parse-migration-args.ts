import type { CliResult, ParsedCommand } from "./types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseMigrationArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "adopt" && args[1] === "multica" && args[2]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: { code: "missing_task", hint: "adopt multica requires --task <task-id>." } };
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

  if (args[0] === "migrate-plan") {
    const limit = Number(readOption(args, "--limit") ?? Number.POSITIVE_INFINITY);
    return { ok: true, value: { rootDir, json, action: { kind: "migrate-plan", limit } } };
  }

  if (args[0] === "migrate-structure") {
    if (args.includes("--plan") && args.includes("--apply")) {
      return { ok: false, error: { code: "conflicting_migration_mode", hint: "Use only one of --plan or --apply." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-structure",
          mode: args.includes("--apply") ? "apply" : "plan",
          confirmPlan: args.includes("--confirm-plan")
        }
      }
    };
  }

  if (args[0] === "migrate-run") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-run",
          planOnly: args.includes("--plan-only"),
          outDir: readOption(args, "--out-dir") ?? ".harness/generated/migration-sessions/latest"
        }
      }
    };
  }

  if (args[0] === "migrate-verify" && args[1]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "migrate-verify",
          sessionPath: args[1],
          fullCutover: args.includes("--full-cutover")
        }
      }
    };
  }

  if (args[0] === "legacy" && args[1] === "scan" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-scan", sourcePath: args[2] } } };
  }

  if (args[0] === "legacy" && args[1] === "intake-plan" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "legacy-intake-plan", sourcePath: args[2], outPath: readOption(args, "--out") } } };
  }

  if (args[0] === "legacy" && args[1] === "copy-safe-docs" && args[2]) {
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

function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

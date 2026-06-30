import { slugifyTaskTitle } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseNewTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "new-task") return null;

  const migrationMode = args.includes("--migration") || args.includes("--import") || args.includes("--admin");
  const fromLegacyId = readOption(args, "--from-legacy");
  if (args.includes("--from-legacy") && (!fromLegacyId || fromLegacyId.startsWith("--"))) {
    return {
      ok: false,
      error: cliError(CliErrorCode.MissingLegacyId, "Use new-task --from-legacy <legacy-id> with an id from harness/legacy/index.json.")
    };
  }
  const manualId = readOption(args, "--id") ?? (args[1]?.startsWith("--") ? undefined : args[1]);
  if (fromLegacyId && manualId) {
    return {
      ok: false,
      error: cliError(CliErrorCode.LegacyRebuildManualIdForbidden, "new-task --from-legacy creates a fresh generated task id and cannot also use a manual id.")
    };
  }
  if (manualId && !migrationMode) {
    return {
      ok: false,
      error: cliError(CliErrorCode.ManualTaskIdForbidden, "Task IDs are generated as random task_<ULID> values. Use --migration, --import, or --admin only for controlled backfills.")
    };
  }
  const explicitTitle = readOption(args, "--title");
  if (!explicitTitle && !fromLegacyId) {
    return {
      ok: false,
      error: cliError(CliErrorCode.MissingTitle, "Use new-task --title <title>. Legacy rebuilds may use --from-legacy <legacy-id> without --title.")
    };
  }
  const title = explicitTitle ?? "Untitled task";
  const explicitSlug = readOption(args, "--slug");
  const vertical = readRequiredValueOption(args, "--vertical");
  if (!vertical.ok) return { ok: false, error: vertical.error };
  const preset = readRequiredValueOption(args, "--preset");
  if (!preset.ok) return { ok: false, error: preset.error };
  const profile = readRequiredValueOption(args, "--profile");
  if (!profile.ok) return { ok: false, error: profile.error };
  const moduleKey = readRequiredValueOption(args, "--module");
  if (!moduleKey.ok) return { ok: false, error: moduleKey.error };
  const locale = readOption(args, "--locale");
  if (locale && locale !== "zh-CN" && locale !== "en-US") {
    return { ok: false, error: cliError(CliErrorCode.InvalidLocale, "Use --locale zh-CN or --locale en-US.") };
  }
  const registerModuleKey = readOption(args, "--register-module");
  const moduleTitle = readOption(args, "--module-title");
  const moduleScope = readOption(args, "--module-scope");
  const modulePrefix = readOption(args, "--module-prefix");
  if (registerModuleKey && (!moduleTitle || !moduleScope)) {
    return { ok: false, error: cliError(CliErrorCode.MissingModuleFields, "new-task --register-module requires --module-title and --module-scope.") };
  }
  if (fromLegacyId && (vertical.value || preset.value || profile.value || moduleKey.value || registerModuleKey)) {
    return {
      ok: false,
      error: cliError(CliErrorCode.LegacyRebuildPresetForbidden, "new-task --from-legacy creates a fresh rebuild task from the legacy index; create a normal preset task separately.")
    };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "new-task",
        taskId: manualId,
        title,
        slug: explicitSlug ?? slugifyTaskTitle(title),
        allowManualId: migrationMode,
        fromLegacyId,
        titleProvided: Boolean(explicitTitle),
        slugProvided: Boolean(explicitSlug),
        vertical: vertical.value,
        preset: preset.value,
        profile: profile.value,
        moduleKey: moduleKey.value ?? registerModuleKey,
        registerModule: registerModuleKey && moduleTitle && moduleScope
          ? { key: registerModuleKey, title: moduleTitle, prefix: modulePrefix, scope: moduleScope }
          : undefined,
        longRunning: args.includes("--long-running"),
        dryRun: args.includes("--dry-run"),
        locale: locale as "zh-CN" | "en-US" | undefined
      }
    }
  };
}

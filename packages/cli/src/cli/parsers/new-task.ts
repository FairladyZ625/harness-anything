import { slugifyTaskTitle } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseNewTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  const normalizedArgs = args[0] === "task" && args[1] === "create" ? ["new-task", ...args.slice(2)] : args;
  if (normalizedArgs[0] !== "new-task") return null;

  const migrationMode = normalizedArgs.includes("--migration") || normalizedArgs.includes("--import") || normalizedArgs.includes("--admin");
  const fromLegacyId = readOption(normalizedArgs, "--from-legacy");
  if (normalizedArgs.includes("--from-legacy") && (!fromLegacyId || fromLegacyId.startsWith("--"))) {
    return {
      ok: false,
      error: cliError(CliErrorCode.MissingLegacyId, "Use task create --from-legacy <legacy-id> with an id from harness/legacy/index.json.")
    };
  }
  const manualId = readOption(normalizedArgs, "--id") ?? (normalizedArgs[1]?.startsWith("--") ? undefined : normalizedArgs[1]);
  if (fromLegacyId && manualId) {
    return {
      ok: false,
      error: cliError(CliErrorCode.LegacyRebuildManualIdForbidden, "task create --from-legacy creates a fresh generated task id and cannot also use a manual id.")
    };
  }
  if (manualId && !migrationMode) {
    return {
      ok: false,
      error: cliError(CliErrorCode.ManualTaskIdForbidden, "Task IDs are generated as random task_<ULID> values. Use --migration, --import, or --admin only for controlled backfills.")
    };
  }
  const explicitTitle = readOption(normalizedArgs, "--title");
  if (!explicitTitle && !fromLegacyId) {
    return {
      ok: false,
      error: cliError(CliErrorCode.MissingTitle, "Use task create --title <title>. Legacy rebuilds may use --from-legacy <legacy-id> without --title.")
    };
  }
  const title = explicitTitle ?? "Untitled task";
  const explicitSlug = readOption(normalizedArgs, "--slug");
  const parent = readOption(normalizedArgs, "--parent");
  const vertical = readRequiredValueOption(normalizedArgs, "--vertical");
  if (!vertical.ok) return { ok: false, error: vertical.error };
  const preset = readRequiredValueOption(normalizedArgs, "--preset");
  if (!preset.ok) return { ok: false, error: preset.error };
  const profile = readRequiredValueOption(normalizedArgs, "--profile");
  if (!profile.ok) return { ok: false, error: profile.error };
  const moduleKey = readRequiredValueOption(normalizedArgs, "--module");
  if (!moduleKey.ok) return { ok: false, error: moduleKey.error };
  const locale = readOption(normalizedArgs, "--locale");
  if (locale && locale !== "zh-CN" && locale !== "en-US") {
    return { ok: false, error: cliError(CliErrorCode.InvalidLocale, "Use --locale zh-CN or --locale en-US.") };
  }
  const registerModuleKey = readOption(normalizedArgs, "--register-module");
  const moduleTitle = readOption(normalizedArgs, "--module-title");
  const moduleScope = readOption(normalizedArgs, "--module-scope");
  const modulePrefix = readOption(normalizedArgs, "--module-prefix");
  if (registerModuleKey && (!moduleTitle || !moduleScope)) {
    return { ok: false, error: cliError(CliErrorCode.MissingModuleFields, "task create --register-module requires --module-title and --module-scope.") };
  }
  if (fromLegacyId && (vertical.value || preset.value || profile.value || moduleKey.value || registerModuleKey)) {
    return {
      ok: false,
      error: cliError(CliErrorCode.LegacyRebuildPresetForbidden, "task create --from-legacy creates a fresh rebuild task from the legacy index; create a normal preset task separately.")
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
        parent,
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
        longRunning: normalizedArgs.includes("--long-running"),
        dryRun: normalizedArgs.includes("--dry-run"),
        locale: locale as "zh-CN" | "en-US" | undefined
      }
    }
  };
}

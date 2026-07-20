import { generateTaskId, slugifyTaskTitle } from "@harness-anything/kernel";
import type { CommandDescriptorIdentity } from "../command-spec/types.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { readPriorityTier, readTaskWorkKind } from "./task-metadata-options.ts";
import { booleanPayloadFallback, jsonPayloadFor, payloadFallback } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseNewTaskArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  _commandSpecs?: ReadonlyArray<CommandDescriptorIdentity>,
  input?: CommandJsonInput
): ParseResult | null {
  const normalizedArgs = args[0] === "task" && args[1] === "create" ? ["new-task", ...args.slice(2)] : args;
  if (normalizedArgs[0] !== "new-task") return null;
  const payload = jsonPayloadFor(input, "new-task");

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
  const explicitTitle = payloadFallback(readOption(normalizedArgs, "--title"), payload, "title");
  if (!explicitTitle && !fromLegacyId) {
    return {
      ok: false,
      error: cliError(CliErrorCode.MissingTitle, "Use task create --title <title>. Legacy rebuilds may use --from-legacy <legacy-id> without --title.")
    };
  }
  const title = explicitTitle ?? "Untitled task";
  const explicitSlug = payloadFallback(readOption(normalizedArgs, "--slug"), payload, "slug");
  const parent = readOption(normalizedArgs, "--parent");
  const workKind = readTaskWorkKind(payloadFallback(readOption(normalizedArgs, "--kind"), payload, "workKind"));
  if (!workKind.ok) return { ok: false, error: workKind.error };
  const riskTier = readPriorityTier(payloadFallback(readOption(normalizedArgs, "--risk-tier"), payload, "riskTier"));
  if (!riskTier.ok) return { ok: false, error: riskTier.error };
  const urgency = readPriorityTier(payloadFallback(readOption(normalizedArgs, "--urgency"), payload, "urgency"));
  if (!urgency.ok) return { ok: false, error: urgency.error };
  const vertical = readRequiredValueOption(normalizedArgs, "--vertical");
  if (!vertical.ok) return { ok: false, error: vertical.error };
  const preset = readRequiredValueOption(normalizedArgs, "--preset");
  if (!preset.ok) return { ok: false, error: preset.error };
  const profile = readRequiredValueOption(normalizedArgs, "--profile");
  if (!profile.ok) return { ok: false, error: profile.error };
  const moduleKey = readRequiredValueOption(normalizedArgs, "--module");
  if (!moduleKey.ok) return { ok: false, error: moduleKey.error };
  const verticalValue = payloadFallback(vertical.value, payload, "vertical");
  const presetValue = payloadFallback(preset.value, payload, "preset");
  const moduleKeyValue = payloadFallback(moduleKey.value, payload, "moduleKey");
  const locale = payloadFallback(readOption(normalizedArgs, "--locale"), payload, "locale");
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
  if (fromLegacyId && (verticalValue || presetValue || profile.value || moduleKeyValue || registerModuleKey)) {
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
        taskId: manualId ?? generateTaskId(),
        title,
        parent,
        slug: explicitSlug ?? slugifyTaskTitle(title),
        allowManualId: migrationMode,
        fromLegacyId,
        titleProvided: Boolean(explicitTitle),
        slugProvided: Boolean(explicitSlug),
        workKind: workKind.value,
        riskTier: riskTier.value,
        urgency: urgency.value,
        vertical: verticalValue,
        preset: presetValue,
        profile: profile.value,
        moduleKey: moduleKeyValue ?? registerModuleKey,
        registerModule: registerModuleKey && moduleTitle && moduleScope
          ? { key: registerModuleKey, title: moduleTitle, prefix: modulePrefix, scope: moduleScope }
          : undefined,
        longRunning: booleanPayloadFallback(normalizedArgs.includes("--long-running"), payload, "longRunning"),
        dryRun: booleanPayloadFallback(normalizedArgs.includes("--dry-run"), payload, "dryRun"),
        locale: locale as "zh-CN" | "en-US" | undefined
      }
    }
  };
}

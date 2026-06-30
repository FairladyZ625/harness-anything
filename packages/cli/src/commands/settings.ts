import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult } from "../cli/types.ts";

export type HarnessLocale = "zh-CN" | "en-US";

export interface ProjectHarnessSettings {
  readonly present: boolean;
  readonly locale?: HarnessLocale;
  readonly defaultVertical?: string;
  readonly defaultPreset?: string;
  readonly defaultProfile?: string;
  readonly customVerticalsEnabled: boolean;
}

export interface UserHarnessSettings {
  readonly present: boolean;
  readonly customVerticalsDevMode: boolean;
}

type SettingsResult =
  | { readonly ok: true; readonly settings: ProjectHarnessSettings }
  | { readonly ok: false; readonly result: CliResult };

type UserSettingsResult =
  | { readonly ok: true; readonly settings: UserHarnessSettings }
  | { readonly ok: false; readonly result: CliResult };

type RawSettings = Record<string, unknown>;

const EMPTY_SETTINGS: ProjectHarnessSettings = {
  present: false,
  customVerticalsEnabled: false
};

const EMPTY_USER_SETTINGS: UserHarnessSettings = {
  present: false,
  customVerticalsDevMode: false
};

const SETTINGS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const SETTINGS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u;

export function readProjectHarnessSettings(rootDir: string, command = "settings"): SettingsResult {
  const configPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml");
  if (!existsSync(configPath)) return { ok: true, settings: EMPTY_SETTINGS };

  try {
    const body = readFileSync(configPath, "utf8");
    const parsed = parseSettingsDocument(body);
    if (!parsed.present) return { ok: true, settings: EMPTY_SETTINGS };
    return validateSettings(command, parsed.settings);
  } catch (error) {
    return {
      ok: false,
      result: settingsError(command, error instanceof Error ? error.message : "Unable to read harness.yaml settings.")
    };
  }
}

export function readUserHarnessSettings(rootDir: string, command = "settings"): UserSettingsResult {
  const configPath = path.join(resolveHarnessLayout(rootDir).localRoot, "user-settings.json");
  if (!existsSync(configPath)) return { ok: true, settings: EMPTY_USER_SETTINGS };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["devMode", "schema"]) ||
      raw.schema !== "user-settings/v1" ||
      !isRecord(raw.devMode) ||
      !hasExactKeys(raw.devMode, ["customVerticals"]) ||
      typeof raw.devMode.customVerticals !== "boolean"
    ) {
      return {
        ok: false,
        result: userSettingsError(command, ".harness/user-settings.json must match user-settings/v1 with devMode.customVerticals boolean.")
      };
    }
    return {
      ok: true,
      settings: {
        present: true,
        customVerticalsDevMode: raw.devMode.customVerticals
      }
    };
  } catch (error) {
    return {
      ok: false,
      result: userSettingsError(command, error instanceof Error ? error.message : "Unable to read .harness/user-settings.json.")
    };
  }
}

export function customVerticalGateResult(
  rootDir: string,
  command: string,
  projectSettings: ProjectHarnessSettings | undefined
): CliResult {
  const userSettings = readUserHarnessSettings(rootDir, command);
  if (!userSettings.ok) return userSettings.result;

  const userGate = userSettings.settings.customVerticalsDevMode;
  const projectGate = projectSettings?.customVerticalsEnabled === true;
  if (!userGate) {
    return {
      ok: false,
      command,
      error: cliError(CliErrorCode.CustomVerticalUserDevModeRequired, "Custom verticals require local user dev mode in .harness/user-settings.json and project settings.customVerticals.enabled.")
    };
  }
  if (!projectGate) {
    return {
      ok: false,
      command,
      error: cliError(CliErrorCode.CustomVerticalProjectGateRequired, "Custom verticals require project settings.customVerticals.enabled: true in harness/harness.yaml.")
    };
  }
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.CustomVerticalContractMissing, "Custom vertical gates are enabled, but P11 does not implement custom vertical materialization or authoring.")
  };
}

export function shouldUseSettingsPresetAwareNewTask(settings: ProjectHarnessSettings): boolean {
  if (!settings.present) return false;
  if (settings.defaultVertical && settings.defaultVertical !== "default") return true;
  if (settings.defaultPreset && settings.defaultPreset !== "default") return true;
  return false;
}

export function settingsIssue(result: Extract<SettingsResult, { readonly ok: false }>): {
  readonly code: string;
  readonly source: string;
  readonly severity: "hard-fail";
  readonly message: string;
  readonly repairHint: string;
} {
  return {
    source: "harness-settings",
    code: result.result.error?.code ?? "harness_settings_invalid",
    severity: "hard-fail",
    message: result.result.error?.hint ?? "harness/harness.yaml settings are invalid.",
    repairHint: "Fix harness/harness.yaml settings before running metadata-driven CLI commands."
  };
}

function parseSettingsDocument(body: string): { readonly present: boolean; readonly settings: RawSettings } {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    const decoded = JSON.parse(body) as { readonly settings?: RawSettings; readonly project?: { readonly locale?: unknown }; readonly vertical?: { readonly default?: unknown }; readonly presets?: { readonly default?: unknown } };
    const fromSettings = decoded.settings ?? {};
    const merged = {
      locale: fromSettings.locale ?? decoded.project?.locale,
      defaultVertical: fromSettings.defaultVertical ?? decoded.vertical?.default,
      defaultPreset: fromSettings.defaultPreset ?? decoded.presets?.default,
      defaultProfile: fromSettings.defaultProfile,
      customVerticals: fromSettings.customVerticals
    };
    return {
      present: Boolean(decoded.settings || decoded.project?.locale || decoded.vertical?.default || decoded.presets?.default),
      settings: merged
    };
  }

  return parseYamlSettings(body);
}

function parseYamlSettings(body: string): { readonly present: boolean; readonly settings: RawSettings } {
  const lines = body.split(/\r?\n/u);
  const settings: Record<string, unknown> = {};
  let inSettings = false;
  let inCustomVerticals = false;
  let foundSettings = false;

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) continue;

    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (topLevel) {
      inSettings = topLevel[1] === "settings";
      inCustomVerticals = false;
      foundSettings ||= inSettings;
      if (inSettings && topLevel[2]?.trim()) {
        throw new Error("settings must be a mapping.");
      }
      continue;
    }

    if (!inSettings) continue;

    const nested = /^  ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (nested) {
      const [, key, rawValue = ""] = nested;
      if (!SETTINGS_KEY_PATTERN.test(key)) throw new Error(`Invalid settings key: ${key}`);
      const value = rawValue.trim();
      inCustomVerticals = key === "customVerticals";
      if (inCustomVerticals) {
        if (value) throw new Error("settings.customVerticals must be a mapping.");
        settings.customVerticals = {};
        continue;
      }
      if (!isKnownSettingsScalar(key)) throw new Error(`Unknown settings key: ${key}`);
      if (!value) throw new Error(`settings.${key} must be a scalar value.`);
      settings[key] = unquoteScalar(value);
      continue;
    }

    const customNested = /^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (inCustomVerticals && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "enabled") throw new Error(`Unknown settings.customVerticals key: ${key}`);
      const value = rawValue.trim();
      if (value !== "true" && value !== "false") throw new Error("settings.customVerticals.enabled must be true or false.");
      settings.customVerticals = { enabled: value === "true" };
      continue;
    }

    throw new Error(`Unsupported settings YAML line: ${withoutComment.trim()}`);
  }

  return { present: foundSettings, settings };
}

function validateSettings(command: string, raw: RawSettings): SettingsResult {
  const locale = raw.locale;
  if (locale !== undefined && locale !== "zh-CN" && locale !== "en-US") {
    return invalid(command, "settings.locale must be zh-CN or en-US.");
  }
  const defaultVertical = validateOptionalId("settings.defaultVertical", raw.defaultVertical);
  if (!defaultVertical.ok) return invalid(command, defaultVertical.message);
  const defaultPreset = validateOptionalId("settings.defaultPreset", raw.defaultPreset);
  if (!defaultPreset.ok) return invalid(command, defaultPreset.message);
  const defaultProfile = validateOptionalId("settings.defaultProfile", raw.defaultProfile);
  if (!defaultProfile.ok) return invalid(command, defaultProfile.message);
  const customVerticals = raw.customVerticals;
  if (customVerticals !== undefined) {
    if (!isRecord(customVerticals)) {
      return invalid(command, "settings.customVerticals must be a mapping.");
    }
    const keys = Object.keys(customVerticals);
    if (keys.length !== 1 || keys[0] !== "enabled" || typeof customVerticals.enabled !== "boolean") {
      return invalid(command, "settings.customVerticals.enabled must be a boolean.");
    }
  }

  return {
    ok: true,
    settings: {
      present: true,
      locale,
      defaultVertical: normalizeDefaultSentinel(defaultVertical.value),
      defaultPreset: normalizeDefaultSentinel(defaultPreset.value),
      defaultProfile: normalizeDefaultSentinel(defaultProfile.value),
      customVerticalsEnabled: isRecord(customVerticals) ? customVerticals.enabled === true : false
    }
  };
}

function validateOptionalId(name: string, value: unknown): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !SETTINGS_ID_PATTERN.test(value)) {
    return { ok: false, message: `${name} must be a non-empty identifier.` };
  }
  return { ok: true, value };
}

function invalid(command: string, message: string): SettingsResult {
  return { ok: false, result: settingsError(command, message) };
}

function settingsError(command: string, hint: string): CliResult {
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.HarnessSettingsInvalid, hint)
  };
}

function userSettingsError(command: string, hint: string): CliResult {
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.UserSettingsInvalid, hint)
  };
}

function isKnownSettingsScalar(key: string): boolean {
  return key === "locale" || key === "defaultVertical" || key === "defaultPreset" || key === "defaultProfile";
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeDefaultSentinel(value: string | undefined): string | undefined {
  return value === "default" ? undefined : value;
}

function unquoteScalar(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

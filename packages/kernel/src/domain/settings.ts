import { setting, settingBlockValue } from "../layout/harness-settings.ts";
import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { validateEntityJsonSchema } from "./entity-json-schema.ts";

export const SETTINGS_ID = "repository";
export const settingsLocales = ["en-US", "zh-CN"] as const;
export type SettingsLocale = (typeof settingsLocales)[number];

export interface SettingsV1 {
  readonly schema: "settings/v1";
  readonly settingsId: typeof SETTINGS_ID;
  readonly defaultVertical: string;
  readonly defaultPreset: string;
  readonly defaultProfile: string;
  readonly locale: SettingsLocale;
  readonly scaffolds: {
    readonly task: string;
    readonly repository: string;
  };
}

export const INITIAL_SETTINGS_V1: SettingsV1 = Object.freeze({
  schema: "settings/v1",
  settingsId: SETTINGS_ID,
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  locale: "en-US",
  scaffolds: Object.freeze({
    task: "governance/task-scaffold.json",
    repository: "governance/repository-scaffold.json",
  }),
});

const settingValuePattern = "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$";

export const SETTINGS_V1_SCHEMA: EntityDocumentJsonSchema<SettingsV1> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Settings/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "settings/v1" },
    settingsId: { type: "string", const: SETTINGS_ID },
    defaultVertical: { type: "string", pattern: settingValuePattern, minLength: 1 },
    defaultPreset: { type: "string", pattern: settingValuePattern, minLength: 1 },
    defaultProfile: { type: "string", pattern: settingValuePattern, minLength: 1 },
    locale: { type: "string", enum: settingsLocales },
    scaffolds: {
      type: "object",
      properties: {
        task: { type: "string", pattern: settingValuePattern, minLength: 1 },
        repository: { type: "string", pattern: settingValuePattern, minLength: 1 },
      },
      required: ["task", "repository"],
      additionalProperties: false,
    },
  },
  required: ["schema", "settingsId", "defaultVertical", "defaultPreset", "defaultProfile", "locale", "scaffolds"],
  additionalProperties: false,
};

export function validateSettingsV1(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SETTINGS_V1_SCHEMA, value, "settings");
}

export function readSettingsFacet(body: string): SettingsV1 {
  const settings: SettingsV1 = {
    schema: "settings/v1",
    settingsId: SETTINGS_ID,
    defaultVertical: setting(body, "defaultVertical") ?? INITIAL_SETTINGS_V1.defaultVertical,
    defaultPreset: setting(body, "defaultPreset") ?? INITIAL_SETTINGS_V1.defaultPreset,
    defaultProfile: setting(body, "defaultProfile") ?? INITIAL_SETTINGS_V1.defaultProfile,
    locale: (setting(body, "locale") ?? INITIAL_SETTINGS_V1.locale) as SettingsLocale,
    scaffolds: {
      task: settingBlockValue(body, "scaffolds", "task") ?? INITIAL_SETTINGS_V1.scaffolds.task,
      repository: settingBlockValue(body, "scaffolds", "repository") ?? INITIAL_SETTINGS_V1.scaffolds.repository,
    },
  };
  const errors = validateSettingsV1(settings);
  if (errors.length) throw new Error(errors.join("; "));
  return settings;
}

export function writeSettingsFacet(body: string, settings: SettingsV1): string {
  const errors = validateSettingsV1(settings);
  if (errors.length) throw new Error(errors.join("; "));
  let next = body;
  next = replaceDefaultedScalar(
    next,
    "  ",
    "defaultVertical",
    settings.defaultVertical,
    INITIAL_SETTINGS_V1.defaultVertical,
  );
  next = replaceDefaultedScalar(next, "  ", "defaultPreset", settings.defaultPreset, INITIAL_SETTINGS_V1.defaultPreset);
  next = replaceDefaultedScalar(
    next,
    "  ",
    "defaultProfile",
    settings.defaultProfile,
    INITIAL_SETTINGS_V1.defaultProfile,
  );
  next = replaceDefaultedScalar(next, "  ", "locale", settings.locale, INITIAL_SETTINGS_V1.locale);
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "task",
    settings.scaffolds.task,
    INITIAL_SETTINGS_V1.scaffolds.task,
  );
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "repository",
    settings.scaffolds.repository,
    INITIAL_SETTINGS_V1.scaffolds.repository,
  );
  if (JSON.stringify(readSettingsFacet(next)) !== JSON.stringify(settings))
    throw new Error("settings facet replacement did not round-trip exactly");
  return next;
}

function replaceScalar(body: string, indent: string, key: string, value: string): string {
  const line = new RegExp(`^(${indent}${key}:[^\\S\\r\\n]*)[^#\\r\\n]*?([^\\S\\r\\n]*(?:#[^\\r\\n]*)?)$`, "mu");
  if (!line.test(body)) throw new Error(`Missing ${key} in harness.yaml settings facet.`);
  return body.replace(line, `$1${value}$2`);
}

function replaceDefaultedScalar(body: string, indent: string, key: string, value: string, fallback: string): string {
  if (setting(body, key) === undefined && value === fallback) return body;
  return replaceScalar(body, indent, key, value);
}

function replaceBlockScalar(body: string, block: string, key: string, value: string): string {
  const section = new RegExp(`(^  ${block}:[^\\S\\r\\n]*(?:\\r?\\n))((?:    [^\\r\\n]*(?:\\r?\\n|$))*)`, "mu");
  const match = section.exec(body);
  if (!match) throw new Error(`Missing ${block} block in harness.yaml settings facet.`);
  const replaced = replaceScalar(match[2]!, "    ", key, value);
  return `${body.slice(0, match.index)}${match[1]}${replaced}${body.slice(match.index + match[0].length)}`;
}

function replaceDefaultedBlockScalar(
  body: string,
  block: string,
  key: string,
  value: string,
  fallback: string,
): string {
  if (settingBlockValue(body, block, key) === undefined && value === fallback) return body;
  return replaceBlockScalar(body, block, key, value);
}

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
    defaultVertical: required(setting(body, "defaultVertical"), "settings.defaultVertical"),
    defaultPreset: required(setting(body, "defaultPreset"), "settings.defaultPreset"),
    defaultProfile: required(setting(body, "defaultProfile"), "settings.defaultProfile"),
    locale: required(setting(body, "locale"), "settings.locale") as SettingsLocale,
    scaffolds: {
      task: required(settingBlockValue(body, "scaffolds", "task"), "settings.scaffolds.task"),
      repository: required(settingBlockValue(body, "scaffolds", "repository"), "settings.scaffolds.repository"),
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
  next = replaceScalar(next, "  ", "defaultVertical", settings.defaultVertical);
  next = replaceScalar(next, "  ", "defaultPreset", settings.defaultPreset);
  next = replaceScalar(next, "  ", "defaultProfile", settings.defaultProfile);
  next = replaceScalar(next, "  ", "locale", settings.locale);
  next = replaceBlockScalar(next, "scaffolds", "task", settings.scaffolds.task);
  next = replaceBlockScalar(next, "scaffolds", "repository", settings.scaffolds.repository);
  if (JSON.stringify(readSettingsFacet(next)) !== JSON.stringify(settings))
    throw new Error("settings facet replacement did not round-trip exactly");
  return next;
}

function replaceScalar(body: string, indent: string, key: string, value: string): string {
  const line = new RegExp(`^(${indent}${key}:[^\\S\\r\\n]*)[^#\\r\\n]*?([^\\S\\r\\n]*(?:#[^\\r\\n]*)?)$`, "mu");
  if (!line.test(body)) throw new Error(`Missing ${key} in harness.yaml settings facet.`);
  return body.replace(line, `$1${value}$2`);
}

function replaceBlockScalar(body: string, block: string, key: string, value: string): string {
  const section = new RegExp(`(^  ${block}:[^\\S\\r\\n]*(?:\\r?\\n))((?:    [^\\r\\n]*(?:\\r?\\n|$))*)`, "mu");
  const match = section.exec(body);
  if (!match) throw new Error(`Missing ${block} block in harness.yaml settings facet.`);
  const replaced = replaceScalar(match[2]!, "    ", key, value);
  return `${body.slice(0, match.index)}${match[1]}${replaced}${body.slice(match.index + match[0].length)}`;
}

function required(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`Missing ${field} in harness.yaml.`);
  return value;
}

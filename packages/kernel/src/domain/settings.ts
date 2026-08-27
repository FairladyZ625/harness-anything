import { setting, settingBlockValue } from "../layout/harness-settings.ts";
import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { validateEntityJsonSchema } from "./entity-json-schema.ts";

export const SETTINGS_ID = "repository";
export const SETTINGS_LOCAL_PATH = ".harness/settings.local.json";
export const settingsLocales = ["en-US", "zh-CN"] as const;
export type SettingsLocale = (typeof settingsLocales)[number];

export const SETTINGS_FIELD_OWNERSHIP = Object.freeze({
  defaultVertical: "repository",
  defaultPreset: "repository",
  defaultProfile: "repository",
  locale: "local",
  scaffolds: "repository",
} as const);

export interface RepositorySettingsV1 {
  readonly schema: "settings/v1";
  readonly settingsId: typeof SETTINGS_ID;
  readonly defaultVertical: string;
  readonly defaultPreset: string;
  readonly defaultProfile: string;
  readonly scaffolds: {
    readonly task: string;
    readonly repository: string;
  };
}

export interface LocalSettingsV1 {
  readonly schema: "settings-local/v1";
  readonly locale: SettingsLocale;
}

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

export const SETTINGS_LOCAL_V1_SCHEMA: EntityDocumentJsonSchema<LocalSettingsV1> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "SettingsLocal/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "settings-local/v1" },
    locale: { type: "string", enum: settingsLocales, "x-settings-ownership": "local" },
  },
  required: ["schema", "locale"],
  additionalProperties: false,
};

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
    defaultVertical: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      "x-settings-ownership": "repository",
    },
    defaultPreset: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      "x-settings-ownership": "repository",
    },
    defaultProfile: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      "x-settings-ownership": "repository",
    },
    locale: { type: "string", enum: settingsLocales, "x-settings-ownership": "local" },
    scaffolds: {
      "x-settings-ownership": "repository",
      type: "object",
      properties: {
        task: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          "x-settings-ownership": "repository",
        },
        repository: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          "x-settings-ownership": "repository",
        },
      },
      required: ["task", "repository"],
      additionalProperties: false,
    },
  },
  required: ["schema", "settingsId", "defaultVertical", "defaultPreset", "defaultProfile", "locale", "scaffolds"],
  additionalProperties: false,
};

/** Event/projection shape. The legacy optional locale is accepted only for replay compatibility. */
export const SETTINGS_REPOSITORY_V1_SCHEMA: EntityDocumentJsonSchema<RepositorySettingsV1> = {
  $id: "SettingsRepository/v1",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    schema: { type: "string", const: "settings/v1" },
    settingsId: { type: "string", const: SETTINGS_ID },
    defaultVertical: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      "x-settings-ownership": "repository",
    },
    defaultPreset: { type: "string", pattern: settingValuePattern, minLength: 1, "x-settings-ownership": "repository" },
    defaultProfile: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      "x-settings-ownership": "repository",
    },
    scaffolds: {
      "x-settings-ownership": "repository",
      type: "object",
      properties: {
        task: { type: "string", pattern: settingValuePattern, minLength: 1, "x-settings-ownership": "repository" },
        repository: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          "x-settings-ownership": "repository",
        },
      },
      required: ["task", "repository"],
      additionalProperties: false,
    },
  },
  required: ["schema", "settingsId", "defaultVertical", "defaultPreset", "defaultProfile", "scaffolds"],
  additionalProperties: false,
};

export function validateSettingsV1(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SETTINGS_V1_SCHEMA, value, "settings");
}

export function repositorySettings(settings: SettingsV1 | RepositorySettingsV1): RepositorySettingsV1 {
  return {
    schema: "settings/v1",
    settingsId: SETTINGS_ID,
    defaultVertical: settings.defaultVertical,
    defaultPreset: settings.defaultPreset,
    defaultProfile: settings.defaultProfile,
    scaffolds: { task: settings.scaffolds.task, repository: settings.scaffolds.repository },
  };
}

export function validateLocalSettingsV1(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SETTINGS_LOCAL_V1_SCHEMA, value, "local settings");
}

export function serializeLocalSettings(locale: SettingsLocale): string {
  const value: LocalSettingsV1 = { schema: "settings-local/v1", locale },
    errors = validateLocalSettingsV1(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseLocalSettings(value: unknown): LocalSettingsV1 | null {
  return validateLocalSettingsV1(value).length ? null : (value as LocalSettingsV1);
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

/** Replace repository-owned YAML fields and remove the legacy authored locale line. */
export function writeRepositorySettingsFacet(body: string, settings: RepositorySettingsV1 | SettingsV1): string {
  const repository = repositorySettings(settings),
    errors = validateRepositorySettings(repository);
  if (errors.length) throw new Error(errors.join("; "));
  let next = body;
  next = replaceDefaultedScalar(
    next,
    "  ",
    "defaultVertical",
    repository.defaultVertical,
    INITIAL_SETTINGS_V1.defaultVertical,
  );
  next = replaceDefaultedScalar(
    next,
    "  ",
    "defaultPreset",
    repository.defaultPreset,
    INITIAL_SETTINGS_V1.defaultPreset,
  );
  next = replaceDefaultedScalar(
    next,
    "  ",
    "defaultProfile",
    repository.defaultProfile,
    INITIAL_SETTINGS_V1.defaultProfile,
  );
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "task",
    repository.scaffolds.task,
    INITIAL_SETTINGS_V1.scaffolds.task,
  );
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "repository",
    repository.scaffolds.repository,
    INITIAL_SETTINGS_V1.scaffolds.repository,
  );
  next = removeLegacyLocale(next);
  if (JSON.stringify(repositorySettings(readSettingsFacet(next))) !== JSON.stringify(repository))
    throw new Error("repository settings facet replacement did not round-trip exactly");
  return next;
}

function removeLegacyLocale(body: string): string {
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu,
    match = header.exec(body);
  if (!match || match.index === undefined) return body;
  const contentStart = match.index + match[0].length,
    remainder = body.slice(contentStart),
    nextTopLevel = remainder.search(/^[^\s][^\r\n]*(?:\r?\n|$)/mu),
    end = nextTopLevel < 0 ? body.length : contentStart + nextTopLevel,
    cleaned = body.slice(match.index, end).replace(/^  locale:[^\r\n]*(?:\r?\n|$)/mu, "");
  return `${body.slice(0, match.index)}${cleaned}${body.slice(end)}`;
}

export function validateRepositorySettings(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SETTINGS_REPOSITORY_V1_SCHEMA, value, "repository settings");
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

import { setting, settingBlockValue } from "../layout/harness-settings.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import {
  replaceDefaultedBlockScalar,
  replaceDefaultedScalar,
  replaceOptionalDefaultedScalar,
} from "./settings-closeout.ts";
import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import {
  gateAppliesTo,
  gateGovernanceFields,
  gateWitnessMappingIssues,
  mappedWitnessAdapterIds,
  type GateWitnessMappingV1,
} from "./completion-contract.ts";
import { validateEntityJsonSchema } from "./entity-json-schema.ts";
import {
  DEFAULT_CLOSEOUT_SETTINGS,
  closeoutProfiles,
  readCloseoutSettings,
  settingsCloseoutOverrideKeys,
  writeCloseoutFacet,
  type CloseoutSettingsV1,
} from "./settings-closeout.ts";

export const SETTINGS_ID = "repository";
export const SETTINGS_LOCAL_PATH = ".harness/settings.local.json";
export const settingsLocales = ["en-US", "zh-CN"] as const;
export type SettingsLocale = (typeof settingsLocales)[number];
export const reviewIndependenceLevels = ["execution", "principal"] as const;
export type ReviewIndependence = (typeof reviewIndependenceLevels)[number];
export const DEFAULT_RESTORE_DRILL_RETENTION = 3;
export const DEFAULT_CI_WORKFLOWS = Object.freeze([] as const);

export interface WalFlushSettingsV1 {
  readonly adaptive: boolean;
  readonly events: number;
  readonly bytes: number;
  readonly milliseconds: number;
}

// Owner ruling (Zeyu, 2026-08-31): the idle timer is a floor, not the flush
// driver — 256 events / 8 MiB remain the load-bounded triggers, and one commit
// per hour of idle activity replaces the ~2s cadence that produced 100+
// ledger commits per day.
export const DEFAULT_WAL_FLUSH_SETTINGS: WalFlushSettingsV1 = Object.freeze({
  adaptive: true,
  events: 256,
  bytes: 8 * 1024 * 1024,
  milliseconds: 3_600_000,
});

export const SETTINGS_FIELD_OWNERSHIP = Object.freeze({
  defaultVertical: "repository",
  defaultPreset: "repository",
  defaultProfile: "repository",
  defaultReviewer: "repository",
  reviewIndependence: "repository",
  reviewReturnBudget: "repository",
  locale: "local",
  scaffolds: "repository",
  walFlush: "repository",
  ci: "repository",
  gates: "repository",
  closeout: "repository",
  agenda: "repository",
  restoreDrillRetention: "repository",
} as const);

type SettingsOwnedField = keyof typeof SETTINGS_FIELD_OWNERSHIP;

function ownedSchema<T extends object>(
  field: SettingsOwnedField,
  schema: T,
): T & { readonly "x-settings-ownership": (typeof SETTINGS_FIELD_OWNERSHIP)[SettingsOwnedField] } {
  return { ...schema, "x-settings-ownership": SETTINGS_FIELD_OWNERSHIP[field] };
}

export interface RepositorySettingsV1 {
  readonly schema: "settings/v1";
  readonly settingsId: typeof SETTINGS_ID;
  readonly defaultVertical: string;
  readonly defaultPreset: string;
  readonly defaultProfile: string;
  readonly defaultReviewer?: string;
  readonly reviewIndependence: ReviewIndependence;
  readonly reviewReturnBudget: number;
  readonly scaffolds: {
    readonly task: string;
    readonly repository: string;
  };
  readonly walFlush: WalFlushSettingsV1;
  readonly ci: { readonly workflows: readonly string[] };
  readonly gates: readonly GateWitnessMappingV1[];
  readonly closeout: CloseoutSettingsV1;
  readonly agenda: { readonly pinLimit: number };
  readonly restoreDrillRetention: number;
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
  readonly defaultReviewer?: string;
  readonly reviewIndependence: ReviewIndependence;
  readonly reviewReturnBudget: number;
  readonly locale: SettingsLocale;
  readonly scaffolds: {
    readonly task: string;
    readonly repository: string;
  };
  readonly walFlush: WalFlushSettingsV1;
  readonly ci: { readonly workflows: readonly string[] };
  readonly gates: readonly GateWitnessMappingV1[];
  readonly closeout: CloseoutSettingsV1;
  readonly agenda: { readonly pinLimit: number };
  readonly restoreDrillRetention: number;
}

export const SETTINGS_LOCAL_V1_SCHEMA: EntityDocumentJsonSchema<LocalSettingsV1> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "SettingsLocal/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "settings-local/v1" },
    locale: ownedSchema("locale", { type: "string", enum: settingsLocales }),
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
  reviewIndependence: "execution",
  reviewReturnBudget: 3,
  locale: "en-US",
  scaffolds: Object.freeze({
    task: "governance/task-scaffold.json",
    repository: "governance/repository-scaffold.json",
  }),
  walFlush: DEFAULT_WAL_FLUSH_SETTINGS,
  ci: Object.freeze({ workflows: DEFAULT_CI_WORKFLOWS }),
  gates: Object.freeze([]),
  closeout: DEFAULT_CLOSEOUT_SETTINGS,
  agenda: Object.freeze({ pinLimit: 30 }),
  restoreDrillRetention: DEFAULT_RESTORE_DRILL_RETENTION,
});

export const settingValuePattern = "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$";

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
      ...ownedSchema("defaultVertical", {}),
    },
    defaultPreset: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      ...ownedSchema("defaultPreset", {}),
    },
    defaultProfile: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      ...ownedSchema("defaultProfile", {}),
    },
    defaultReviewer: ownedSchema("defaultReviewer", { type: "string", pattern: settingValuePattern, minLength: 1 }),
    reviewIndependence: ownedSchema("reviewIndependence", {
      type: "string",
      enum: reviewIndependenceLevels,
    }),
    reviewReturnBudget: ownedSchema("reviewReturnBudget", { type: "integer", minimum: 1 }),
    locale: ownedSchema("locale", { type: "string", enum: settingsLocales }),
    scaffolds: {
      ...ownedSchema("scaffolds", {}),
      type: "object",
      properties: {
        task: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          ...ownedSchema("scaffolds", {}),
        },
        repository: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          ...ownedSchema("scaffolds", {}),
        },
      },
      required: ["task", "repository"],
      additionalProperties: false,
    },
    walFlush: walFlushSchema(),
    ci: ciSettingsSchema(),
    gates: gateSettingsSchema(),
    closeout: closeoutSettingsSchema(),
    agenda: ownedSchema("agenda", {
      type: "object",
      properties: { pinLimit: { type: "integer", minimum: 1 } },
      required: ["pinLimit"],
      additionalProperties: false,
    }),
    restoreDrillRetention: ownedSchema("restoreDrillRetention", { type: "integer", minimum: 1 }),
  },
  required: [
    "schema",
    "settingsId",
    "defaultVertical",
    "defaultPreset",
    "defaultProfile",
    "locale",
    "scaffolds",
    "walFlush",
  ],
  additionalProperties: false,
};

/** Event/projection shape containing repository-owned settings only. */
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
      ...ownedSchema("defaultVertical", {}),
    },
    defaultPreset: ownedSchema("defaultPreset", { type: "string", pattern: settingValuePattern, minLength: 1 }),
    defaultProfile: {
      type: "string",
      pattern: settingValuePattern,
      minLength: 1,
      ...ownedSchema("defaultProfile", {}),
    },
    defaultReviewer: ownedSchema("defaultReviewer", { type: "string", pattern: settingValuePattern, minLength: 1 }),
    reviewIndependence: ownedSchema("reviewIndependence", {
      type: "string",
      enum: reviewIndependenceLevels,
    }),
    reviewReturnBudget: ownedSchema("reviewReturnBudget", { type: "integer", minimum: 1 }),
    scaffolds: {
      ...ownedSchema("scaffolds", {}),
      type: "object",
      properties: {
        task: ownedSchema("scaffolds", { type: "string", pattern: settingValuePattern, minLength: 1 }),
        repository: {
          type: "string",
          pattern: settingValuePattern,
          minLength: 1,
          ...ownedSchema("scaffolds", {}),
        },
      },
      required: ["task", "repository"],
      additionalProperties: false,
    },
    walFlush: walFlushSchema(),
    ci: ciSettingsSchema(),
    gates: gateSettingsSchema(),
    closeout: closeoutSettingsSchema(),
    agenda: ownedSchema("agenda", {
      type: "object",
      properties: { pinLimit: { type: "integer", minimum: 1 } },
      required: ["pinLimit"],
      additionalProperties: false,
    }),
    restoreDrillRetention: ownedSchema("restoreDrillRetention", { type: "integer", minimum: 1 }),
  },
  required: ["schema", "settingsId", "defaultVertical", "defaultPreset", "defaultProfile", "scaffolds", "walFlush"],
  additionalProperties: false,
};

export function validateSettingsV1(value: unknown): readonly string[] {
  return withGateMappingIssues(validateEntityJsonSchema(SETTINGS_V1_SCHEMA, value, "settings"), value);
}

export function repositorySettings(settings: SettingsV1 | RepositorySettingsV1): RepositorySettingsV1 {
  return {
    schema: "settings/v1",
    settingsId: SETTINGS_ID,
    defaultVertical: settings.defaultVertical,
    defaultPreset: settings.defaultPreset,
    defaultProfile: settings.defaultProfile,
    ...(settings.defaultReviewer ? { defaultReviewer: settings.defaultReviewer } : {}),
    reviewIndependence: settings.reviewIndependence ?? INITIAL_SETTINGS_V1.reviewIndependence,
    reviewReturnBudget: settings.reviewReturnBudget ?? INITIAL_SETTINGS_V1.reviewReturnBudget,
    scaffolds: { task: settings.scaffolds.task, repository: settings.scaffolds.repository },
    walFlush: settings.walFlush ?? DEFAULT_WAL_FLUSH_SETTINGS,
    ci: settings.ci ?? INITIAL_SETTINGS_V1.ci,
    gates: canonicalGateMappings(settings.gates ?? INITIAL_SETTINGS_V1.gates),
    closeout: settings.closeout ?? INITIAL_SETTINGS_V1.closeout,
    agenda: settings.agenda ?? INITIAL_SETTINGS_V1.agenda,
    restoreDrillRetention: settings.restoreDrillRetention ?? DEFAULT_RESTORE_DRILL_RETENTION,
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
    ...(setting(body, "defaultReviewer") ? { defaultReviewer: setting(body, "defaultReviewer")! } : {}),
    reviewIndependence: (setting(body, "reviewIndependence") ??
      INITIAL_SETTINGS_V1.reviewIndependence) as ReviewIndependence,
    reviewReturnBudget: Number(setting(body, "reviewReturnBudget") ?? INITIAL_SETTINGS_V1.reviewReturnBudget),
    locale: (setting(body, "locale") ?? INITIAL_SETTINGS_V1.locale) as SettingsLocale,
    scaffolds: {
      task: settingBlockValue(body, "scaffolds", "task") ?? INITIAL_SETTINGS_V1.scaffolds.task,
      repository: settingBlockValue(body, "scaffolds", "repository") ?? INITIAL_SETTINGS_V1.scaffolds.repository,
    },
    walFlush: readWalFlushSettings(body),
    ci: readCiSettings(body),
    gates: readGateSettings(body),
    closeout: readCloseoutSettings(body),
    agenda: {
      pinLimit: Number(settingBlockValue(body, "agenda", "pinLimit") ?? INITIAL_SETTINGS_V1.agenda.pinLimit),
    },
    restoreDrillRetention: readRestoreDrillRetention(body),
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
  next = replaceOptionalDefaultedScalar(next, "  ", "defaultReviewer", repository.defaultReviewer ?? "", "");
  next = replaceOptionalDefaultedScalar(
    next,
    "  ",
    "reviewIndependence",
    repository.reviewIndependence,
    INITIAL_SETTINGS_V1.reviewIndependence,
  );
  next = replaceOptionalDefaultedScalar(
    next,
    "  ",
    "reviewReturnBudget",
    String(repository.reviewReturnBudget),
    String(INITIAL_SETTINGS_V1.reviewReturnBudget),
  );
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "task",
    repository.scaffolds.task,
    INITIAL_SETTINGS_V1.scaffolds.task,
  );
  next = writeWalFlushFacet(next, repository.walFlush);
  next = writeCiFacet(next, repository.ci);
  next = writeGatesFacet(next, repository.gates);
  next = writeCloseoutFacet(next, repository.closeout);
  next = replaceDefaultedBlockScalar(
    next,
    "agenda",
    "pinLimit",
    String(repository.agenda.pinLimit),
    String(INITIAL_SETTINGS_V1.agenda.pinLimit),
  );
  next = replaceOptionalDefaultedScalar(
    next,
    "  ",
    "restoreDrillRetention",
    String(repository.restoreDrillRetention),
    String(DEFAULT_RESTORE_DRILL_RETENTION),
  );
  next = replaceDefaultedBlockScalar(
    next,
    "scaffolds",
    "repository",
    repository.scaffolds.repository,
    INITIAL_SETTINGS_V1.scaffolds.repository,
  );
  next = removeLegacyLocale(next);
  if (stableStringify(repositorySettings(readSettingsFacet(next))) !== stableStringify(repository))
    throw new Error("repository settings facet replacement did not round-trip exactly");
  return next;
}

function walFlushSchema() {
  return {
    ...ownedSchema("walFlush", {}),
    type: "object" as const,
    properties: {
      adaptive: ownedSchema("walFlush", { type: "boolean" as const }),
      events: ownedSchema("walFlush", { type: "integer" as const, minimum: 1, maximum: 1_000_000 }),
      bytes: ownedSchema("walFlush", { type: "integer" as const, minimum: 1, maximum: 1_073_741_824 }),
      milliseconds: ownedSchema("walFlush", { type: "integer" as const, minimum: 1, maximum: 3_600_000 }),
    },
    required: ["adaptive", "events", "bytes", "milliseconds"],
    additionalProperties: false,
  };
}

function ciSettingsSchema() {
  return {
    ...ownedSchema("ci", {}),
    type: "object" as const,
    properties: {
      workflows: ownedSchema("ci", {
        type: "array" as const,
        items: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        uniqueItems: true,
      }),
    },
    required: ["workflows"],
    additionalProperties: false,
  };
}

function gateSettingsSchema() {
  return {
    ...ownedSchema("gates", {}),
    type: "array" as const,
    "x-unique-by": "gateId",
    items: {
      type: "object" as const,
      properties: {
        gateId: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        adapter: { type: "string" as const, enum: ["none", ...mappedWitnessAdapterIds] },
        appliesTo: { type: "string" as const, enum: gateAppliesTo },
        branch: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        event: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        command: { type: "string" as const, minLength: 1 },
        coverage: { type: "string" as const, enum: ["exact", "descendant"] },
        selection: { type: "string" as const, enum: ["newest"] },
        mandatorySignoff: { type: "boolean" as const },
        allowOverride: { type: "boolean" as const },
      },
      required: ["gateId", "adapter"],
      additionalProperties: false,
    },
  };
}

function withGateMappingIssues(errors: readonly string[], value: unknown): readonly string[] {
  const gates = (value as { readonly gates?: readonly GateWitnessMappingV1[] } | null)?.gates;
  return errors.length || gates === undefined ? errors : gateWitnessMappingIssues(gates);
}

function closeoutSettingsSchema() {
  return {
    ...ownedSchema("closeout", {}),
    type: "object" as const,
    properties: {
      profile: ownedSchema("closeout", { type: "string" as const, enum: closeoutProfiles }),
      overrides: {
        ...ownedSchema("closeout", {}),
        type: "object" as const,
        properties: Object.fromEntries(
          settingsCloseoutOverrideKeys.map((key) => [key, ownedSchema("closeout", { type: "boolean" as const })]),
        ),
        required: [],
        additionalProperties: false,
      },
    },
    required: ["profile"],
    additionalProperties: false,
  };
}

function readCiSettings(body: string): SettingsV1["ci"] {
  const section = /^  ci:[^\S\r\n]*(?:\r?\n)((?:    [^\r\n]*(?:\r?\n|$))*)/mu.exec(body)?.[1];
  if (section === undefined) return INITIAL_SETTINGS_V1.ci;
  const raw = settingBlockValue(body, "ci", "workflows");
  if (raw === undefined) throw new Error("settings.ci.workflows must be an inline array of workflow names");
  if (!raw.startsWith("[") || !raw.endsWith("]"))
    throw new Error("settings.ci.workflows must be an inline array of workflow names");
  // An empty list opts the repository out of CI witnessing; the section must still be explicit.
  if (raw.slice(1, -1).trim() === "") return { workflows: [] };
  const workflows = raw
    .slice(1, -1)
    .split(",")
    .map((workflow) => workflow.trim());
  if (
    workflows.some((workflow) => !new RegExp(settingValuePattern, "u").test(workflow) || /\.ya?ml$/u.test(workflow)) ||
    new Set(workflows).size !== workflows.length
  )
    throw new Error("settings.ci.workflows must contain unique workflow names without .yml");
  return { workflows };
}

/**
 * `settings.gates` maps each gate id either inline to `none` or to a block naming its witness adapter:
 * `    ci:` followed by six-space `appliesTo:`/`adapter:`/adapter option lines.
 */
export function readGateSettings(body: string): readonly GateWitnessMappingV1[] {
  if (!/^  gates:/mu.test(body)) return INITIAL_SETTINGS_V1.gates;
  const section = /^  gates:[^\S\r\n]*(?:#[^\r\n]*)?\r?\n((?:    [^\r\n]*(?:\r?\n|$))*)/mu.exec(body)?.[1];
  if (section === undefined) throw new Error("settings.gates must be a block of gate witness mappings");
  const gates: Record<string, string | boolean>[] = [];
  for (const line of section.split(/\r?\n/u)) {
    const content = line.replace(/[^\S\r\n]*#.*$/u, "");
    if (!content.trim()) continue;
    const gate = /^    ([^\s:]+):[^\S\r\n]*(\S*)$/u.exec(content),
      field = /^      ([A-Za-z]+):[^\S\r\n]*(\S.*?)[^\S\r\n]*$/u.exec(content),
      current = gates.at(-1);
    if (gate && (gate[2] === "" || gate[2] === "none"))
      gates.push({ gateId: gate[1]!, ...(gate[2] === "none" ? { adapter: "none" } : {}) });
    else if (field && current && current.adapter !== "none" && !Object.hasOwn(current, field[1]!))
      current[field[1]!] = governanceFlag(field[1]!, field[2]!);
    else throw new Error(`settings.gates cannot read line: ${content.trim()}`);
  }
  return gates as unknown as readonly GateWitnessMappingV1[];
}

/** Governance modifiers are YAML booleans; any other spelling stays a string for the schema to reject. */
function governanceFlag(field: string, raw: string): string | boolean {
  return (gateGovernanceFields as readonly string[]).includes(field) && (raw === "true" || raw === "false")
    ? raw === "true"
    : raw;
}

/** One key order for every mapping, so snapshots from YAML, events, and projections compare byte-equal. */
function canonicalGateMappings(gates: readonly GateWitnessMappingV1[]): readonly GateWitnessMappingV1[] {
  return gates.map(({ gateId, adapter, ...options }) => ({
    gateId,
    adapter,
    ...Object.fromEntries(Object.entries(options).sort(([left], [right]) => left.localeCompare(right))),
  }));
}

function readWalFlushSettings(body: string): WalFlushSettingsV1 {
  const readPositive = (key: keyof Omit<WalFlushSettingsV1, "adaptive">): number => {
      const raw = settingBlockValue(body, "walFlush", key);
      if (raw === undefined) return DEFAULT_WAL_FLUSH_SETTINGS[key];
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`settings.walFlush.${key} must be positive`);
      return value;
    },
    adaptiveRaw = settingBlockValue(body, "walFlush", "adaptive");
  if (adaptiveRaw !== undefined && adaptiveRaw !== "true" && adaptiveRaw !== "false")
    throw new Error("settings.walFlush.adaptive must be true or false");
  return {
    adaptive: adaptiveRaw === undefined ? DEFAULT_WAL_FLUSH_SETTINGS.adaptive : adaptiveRaw === "true",
    events: readPositive("events"),
    bytes: readPositive("bytes"),
    milliseconds: readPositive("milliseconds"),
  };
}

function readRestoreDrillRetention(body: string): number {
  const raw = setting(body, "restoreDrillRetention");
  if (raw === undefined) return DEFAULT_RESTORE_DRILL_RETENTION;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("settings.restoreDrillRetention must be a positive integer");
  return value;
}

function writeWalFlushFacet(body: string, settings: WalFlushSettingsV1): string {
  const section = /^  walFlush:[^\S\r\n]*(?:\r?\n)(?:    [^\r\n]*(?:\r?\n|$))*/mu,
    isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_WAL_FLUSH_SETTINGS);
  if (!section.test(body) && isDefault) return body;
  const rendered = [
    "  walFlush:",
    `    adaptive: ${settings.adaptive}`,
    `    events: ${settings.events}`,
    `    bytes: ${settings.bytes}`,
    `    milliseconds: ${settings.milliseconds}`,
    "",
  ].join("\n");
  if (section.test(body)) return body.replace(section, rendered);
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${rendered}`);
}

function writeCiFacet(body: string, ci: RepositorySettingsV1["ci"]): string {
  const section = /^  ci:[^\S\r\n]*(?:\r?\n)(?:    [^\r\n]*(?:\r?\n|$))*/mu,
    isDefault = JSON.stringify(ci) === JSON.stringify(INITIAL_SETTINGS_V1.ci);
  if (!section.test(body) && isDefault) return body;
  const rendered = `  ci:\n    workflows: [${ci.workflows.join(", ")}]\n`;
  if (section.test(body)) return body.replace(section, rendered);
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${rendered}`);
}

/**
 * Serialize `settings.gates` back into the authored facet: an empty mapping list removes the
 * section outright (a bare `gates:` line has no block and `readGateSettings` rejects it), a
 * non-empty list renders `    <id>: none` inline or a `    <id>:` block with six-space fields in
 * canonical key order so the read-back is byte-equal to the entity value.
 */
export function writeGatesFacet(body: string, gates: readonly GateWitnessMappingV1[]): string {
  const section = /^  gates:[^\r\n]*(?:\r?\n)(?:    [^\r\n]*(?:\r?\n|$))*/mu;
  if (gates.length === 0) return section.test(body) ? body.replace(section, "") : body;
  const rendered =
    "  gates:\n" +
    gates
      .map((gate) =>
        gate.adapter === "none"
          ? `    ${gate.gateId}: none`
          : [
              `    ${gate.gateId}:`,
              `      adapter: ${gate.adapter}`,
              ...Object.entries(gate)
                .filter(([key]) => key !== "gateId" && key !== "adapter")
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => `      ${key}: ${String(value)}`),
            ].join("\n"),
      )
      .join("\n") +
    "\n";
  if (section.test(body)) return body.replace(section, rendered);
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${rendered}`);
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
  return withGateMappingIssues(
    validateEntityJsonSchema(SETTINGS_REPOSITORY_V1_SCHEMA, value, "repository settings"),
    value,
  );
}

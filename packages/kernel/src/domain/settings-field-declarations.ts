import type { EntityActionInputField } from "./entity-kind-registry.ts";
import type { GateWitnessMappingV1 } from "./completion-contract.ts";
import { closeoutProfiles, DEFAULT_CLOSEOUT_SETTINGS } from "./settings-closeout.ts";
import { DEFAULT_TASK_ROOT_THRESHOLD, DEFAULT_TASK_WIP_LIMIT } from "./task-wip-policy.ts";

export type SettingsFieldOwnership = "repository" | "local";
export type SettingsFieldValueKind = "string" | "enum" | "integer" | "boolean" | "string-array" | "gate-mappings";

export interface SettingsFieldActionDeclaration {
  readonly field: string;
  readonly type: NonNullable<EntityActionInputField["type"]>;
  readonly key?: string;
  readonly internal?: boolean;
  readonly project?: "stored" | "effective-closeout-gate";
}

export interface SettingsFieldCliDeclaration {
  readonly name: string;
  readonly kind: "single" | "repeated" | "boolean";
  readonly regex?: string;
  readonly enum?: readonly string[];
  readonly format?: string;
  readonly projection?: "number" | "boolean" | "json-object";
}

export interface SettingsFieldDeclaration<Value = unknown> {
  readonly path: readonly [string, ...string[]];
  readonly ownership: SettingsFieldOwnership;
  readonly valueKind: SettingsFieldValueKind;
  readonly defaultValue: Value;
  readonly optional?: boolean;
  readonly snapshotRequired?: boolean;
  readonly eventDefaultWhenMissing?: boolean;
  readonly description: string;
  readonly pattern?: string;
  readonly forbiddenPattern?: string;
  readonly allowedValues?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly uniqueItems?: boolean;
  readonly action?: SettingsFieldActionDeclaration;
  readonly cli?: SettingsFieldCliDeclaration;
  readonly legacyPath?: readonly [string, ...string[]];
  readonly noneMeansEmpty?: boolean;
  readonly yamlStyle?: "inline" | "block-list";
}

export interface SettingsCliInputField extends SettingsFieldCliDeclaration {
  readonly field: string;
  readonly description: string;
}

export const settingValuePattern = "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$";
export const settingsLocales = ["en-US", "zh-CN"] as const;
export type SettingsLocale = (typeof settingsLocales)[number];
export const reviewIndependenceLevels = ["execution", "principal"] as const;
export type ReviewIndependence = (typeof reviewIndependenceLevels)[number];
export const rolePreferenceFields = ["defaultWorker", "defaultCommander", "defaultReviewer"] as const;
export const DEFAULT_RESTORE_DRILL_RETENTION = 3;
export const DEFAULT_CI_WORKFLOWS = Object.freeze([] as const);
export const worktreeSetupAdapters = ["node-modules"] as const;
export const worktreeSetupStepPattern = `^(?:${worktreeSetupAdapters.join("|")}|run: \\S.*)$`;

// Owner ruling (Zeyu, 2026-08-31): the idle timer is a floor, not the flush driver. The event and
// byte triggers stay load-bounded while an hour of idle activity replaces the former ~2s cadence.
export const DEFAULT_WAL_FLUSH_SETTINGS = Object.freeze({
  adaptive: true,
  events: 256,
  bytes: 8 * 1024 * 1024,
  milliseconds: 3_600_000,
});

export function defineSettingsField<const Declaration extends SettingsFieldDeclaration>(
  declaration: Declaration,
): Declaration {
  return Object.freeze({
    ...declaration,
    path: Object.freeze([...declaration.path]),
    ...(declaration.allowedValues ? { allowedValues: Object.freeze([...declaration.allowedValues]) } : {}),
    ...(declaration.action ? { action: Object.freeze({ ...declaration.action }) } : {}),
    ...(declaration.cli ? { cli: Object.freeze({ ...declaration.cli }) } : {}),
  }) as Declaration;
}

const settingId = {
    valueKind: "string" as const,
    pattern: settingValuePattern,
  },
  repository = "repository" as const,
  local = "local" as const,
  singleSettingCli = (name: string): SettingsFieldCliDeclaration => ({ name, kind: "single" });

export const SETTINGS_FIELD_DECLARATIONS = Object.freeze([
  defineSettingsField({
    path: ["defaultVertical"],
    ownership: repository,
    ...settingId,
    defaultValue: "software/coding",
    snapshotRequired: true,
    description: "Default vertical selected for new work.",
    action: { field: "defaultVertical", type: "string" },
    cli: singleSettingCli("--default-vertical"),
  }),
  defineSettingsField({
    path: ["defaultPreset"],
    ownership: repository,
    ...settingId,
    defaultValue: "standard-task",
    snapshotRequired: true,
    description: "Default task preset.",
    action: { field: "defaultPreset", type: "string" },
    cli: singleSettingCli("--default-preset"),
  }),
  defineSettingsField({
    path: ["defaultProfile"],
    ownership: repository,
    ...settingId,
    defaultValue: "baseline",
    snapshotRequired: true,
    description: "Default profile inside the selected preset.",
    action: { field: "defaultProfile", type: "string" },
    cli: singleSettingCli("--default-profile"),
  }),
  ...rolePreferenceFields.map((role, index) =>
    defineSettingsField({
      path: ["roles", role],
      ownership: repository,
      ...settingId,
      defaultValue: undefined,
      optional: true,
      description: `Preferred ${role} agent declaration.`,
      action: { field: "roles", type: "json-object", key: role },
      ...(index === 0 ? { cli: { name: "--roles", kind: "single" as const, projection: "json-object" as const } } : {}),
      ...(role === "defaultReviewer" ? { legacyPath: ["defaultReviewer"] as const } : {}),
    }),
  ),
  defineSettingsField({
    path: ["reviewIndependence"],
    ownership: repository,
    valueKind: "enum",
    defaultValue: "execution",
    allowedValues: reviewIndependenceLevels,
    description: "Identity axis on which an independent review is required.",
    action: { field: "reviewIndependence", type: "string" },
    cli: { name: "--review-independence", kind: "single", enum: reviewIndependenceLevels },
  }),
  defineSettingsField({
    path: ["reviewReturnBudget"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: 3,
    minimum: 1,
    description: "Maximum task review return count before escalation.",
    action: { field: "reviewReturnBudget", type: "number" },
    cli: { name: "--review-return-budget", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["locale"],
    ownership: local,
    valueKind: "enum",
    defaultValue: "en-US",
    snapshotRequired: true,
    allowedValues: settingsLocales,
    description: "Local presentation locale.",
    action: { field: "locale", type: "string" },
    cli: { name: "--locale", kind: "single", enum: settingsLocales },
  }),
  defineSettingsField({
    path: ["scaffolds", "task"],
    ownership: repository,
    ...settingId,
    defaultValue: "governance/task-scaffold.json",
    snapshotRequired: true,
    description: "Repository-relative task scaffold path.",
    action: { field: "taskScaffold", type: "string" },
    cli: singleSettingCli("--task-scaffold"),
  }),
  defineSettingsField({
    path: ["scaffolds", "repository"],
    ownership: repository,
    ...settingId,
    defaultValue: "governance/repository-scaffold.json",
    snapshotRequired: true,
    description: "Repository-relative repository scaffold path.",
    action: { field: "repositoryScaffold", type: "string" },
    cli: singleSettingCli("--repository-scaffold"),
  }),
  defineSettingsField({
    path: ["walFlush", "adaptive"],
    ownership: repository,
    valueKind: "boolean",
    defaultValue: DEFAULT_WAL_FLUSH_SETTINGS.adaptive,
    snapshotRequired: true,
    eventDefaultWhenMissing: true,
    description: "Whether WAL flushing adapts to load.",
    action: { field: "walFlushAdaptive", type: "boolean" },
    cli: { name: "--wal-flush-adaptive", kind: "single", enum: ["true", "false"] },
  }),
  defineSettingsField({
    path: ["walFlush", "events"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_WAL_FLUSH_SETTINGS.events,
    snapshotRequired: true,
    eventDefaultWhenMissing: true,
    minimum: 1,
    maximum: 1_000_000,
    description: "Event-count WAL flush trigger.",
    action: { field: "walFlushEvents", type: "number" },
    cli: { name: "--wal-flush-events", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["walFlush", "bytes"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_WAL_FLUSH_SETTINGS.bytes,
    snapshotRequired: true,
    eventDefaultWhenMissing: true,
    minimum: 1,
    maximum: 1_073_741_824,
    description: "Byte-count WAL flush trigger.",
    action: { field: "walFlushBytes", type: "number" },
    cli: { name: "--wal-flush-bytes", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["walFlush", "milliseconds"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_WAL_FLUSH_SETTINGS.milliseconds,
    snapshotRequired: true,
    eventDefaultWhenMissing: true,
    minimum: 1,
    maximum: 3_600_000,
    description: "Idle-time WAL flush floor in milliseconds.",
    action: { field: "walFlushMilliseconds", type: "number" },
    cli: { name: "--wal-flush-milliseconds", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["ci", "workflows"],
    ownership: repository,
    valueKind: "string-array",
    defaultValue: DEFAULT_CI_WORKFLOWS,
    pattern: settingValuePattern,
    forbiddenPattern: "\\.ya?ml$",
    uniqueItems: true,
    description: "Workflow names accepted as repository CI witnesses.",
    action: { field: "ciWorkflows", type: "string-array" },
    cli: {
      name: "--ci-workflows",
      kind: "repeated",
      regex: settingValuePattern,
      format: "workflow names, or none to disable CI witnessing (unconfigured repositories witness none)",
    },
    noneMeansEmpty: true,
  }),
  defineSettingsField({
    path: ["gates"],
    ownership: repository,
    valueKind: "gate-mappings",
    defaultValue: Object.freeze([] as readonly GateWitnessMappingV1[]),
    description: "Canonical gate-to-witness mappings imported from the authored document.",
    action: { field: "gates", type: "json-object-array", internal: true },
  }),
  defineSettingsField({
    path: ["closeout", "profile"],
    ownership: repository,
    valueKind: "enum",
    defaultValue: DEFAULT_CLOSEOUT_SETTINGS.profile,
    allowedValues: closeoutProfiles,
    description: "Repository closeout strictness profile.",
    action: { field: "closeoutProfile", type: "string" },
    cli: { name: "--closeout-profile", kind: "single", enum: closeoutProfiles },
  }),
  ...(["review", "consent", "factDisposition", "codeDoc"] as const).map((gate) => {
    const suffix = `${gate[0]!.toUpperCase()}${gate.slice(1)}`;
    return defineSettingsField({
      path: ["closeout", "overrides", gate],
      ownership: repository,
      valueKind: "boolean",
      defaultValue: undefined,
      optional: true,
      description: `Optional ${gate} closeout gate override.`,
      action: {
        field: `closeout${suffix}`,
        type: "boolean",
        project: "effective-closeout-gate",
      },
      cli: {
        name: `--closeout-${gate.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
        kind: "single",
        enum: ["true", "false"],
      },
    });
  }),
  defineSettingsField({
    path: ["agenda", "pinLimit"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: 30,
    minimum: 1,
    description: "Maximum number of entities pinned to the repository agenda.",
    action: { field: "agendaPinLimit", type: "number" },
    cli: { name: "--agenda-pin-limit", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["tasks", "wipLimit"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_TASK_WIP_LIMIT,
    minimum: 1,
    description: "Maximum number of tasks admitted to the execution worktable.",
    action: { field: "wipLimit", type: "number" },
    cli: { name: "--wip-limit", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["tasks", "rootThreshold"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_TASK_ROOT_THRESHOLD,
    minimum: 1,
    description: "Direct-child count at which a standard task is treated as a work root.",
    action: { field: "rootThreshold", type: "number" },
    cli: { name: "--root-threshold", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["worktree", "setup"],
    ownership: repository,
    valueKind: "string-array",
    defaultValue: Object.freeze([] as readonly string[]),
    pattern: worktreeSetupStepPattern,
    uniqueItems: true,
    description: "Ordered preparation steps run in every new task worktree.",
    action: { field: "worktreeSetup", type: "string-array" },
    cli: {
      name: "--worktree-setup",
      kind: "repeated",
      regex: `^(?:none|${worktreeSetupStepPattern.slice(1, -1)})$`,
      format: `built-in adapter (${worktreeSetupAdapters.join(", ")}), run: <command>, or none to clear`,
    },
    noneMeansEmpty: true,
    yamlStyle: "block-list",
  }),
  defineSettingsField({
    path: ["restoreDrillRetention"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_RESTORE_DRILL_RETENTION,
    minimum: 1,
    description: "Number of successful restore drills retained.",
    action: { field: "restoreDrillRetention", type: "number" },
    cli: { name: "--restore-drill-retention", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
] as const);

type DeclaredValue<Declaration extends SettingsFieldDeclaration> = Declaration["valueKind"] extends "enum"
  ? Declaration extends { readonly allowedValues: readonly (infer Value extends string)[] }
    ? Value
    : string
  : Declaration["valueKind"] extends "integer"
    ? number
    : Declaration["valueKind"] extends "boolean"
      ? boolean
      : Declaration["valueKind"] extends "string-array"
        ? readonly string[]
        : Declaration["valueKind"] extends "gate-mappings"
          ? readonly GateWitnessMappingV1[]
          : string;

type DeclaredPath<Path extends readonly string[], Value, Optional extends boolean> = Path extends readonly [
  infer Head extends string,
  ...infer Tail extends string[],
]
  ? Tail extends []
    ? Optional extends true
      ? { readonly [Key in Head]?: Value }
      : { readonly [Key in Head]: Value }
    : Optional extends true
      ? { readonly [Key in Head]?: DeclaredPath<Tail, Value, true> }
      : { readonly [Key in Head]: DeclaredPath<Tail, Value, false> }
  : unknown;

type DeclaredField<
  Declaration,
  Ownership extends SettingsFieldOwnership,
> = Declaration extends SettingsFieldDeclaration & {
  readonly ownership: Ownership;
  readonly path: infer Path extends readonly string[];
}
  ? DeclaredPath<Path, DeclaredValue<Declaration>, Declaration extends { readonly optional: true } ? true : false>
  : never;

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

export type DeclaredSettingsFields<Ownership extends SettingsFieldOwnership> = UnionToIntersection<
  DeclaredField<(typeof SETTINGS_FIELD_DECLARATIONS)[number], Ownership>
>;

export type WalFlushSettingsV1 = DeclaredSettingsFields<"repository">["walFlush"];

export function settingsFieldLabel(actionField: string): string {
  const declaration = SETTINGS_FIELD_DECLARATIONS.find(({ action }) => action?.field === actionField);
  if (!declaration) throw new Error(`Unknown Settings action field ${actionField}.`);
  return `settings.${declaration.path.join(".")}`;
}

export const AGENDA_PIN_LIMIT_SETTING = settingsFieldLabel("agendaPinLimit");

export function settingsActionInputFieldsFromDeclarations(
  declarations: readonly SettingsFieldDeclaration[],
): readonly EntityActionInputField[] {
  const fields = new Map<string, EntityActionInputField>();
  for (const declaration of declarations) {
    const action = declaration.action;
    if (!action || action.internal || fields.has(action.field)) continue;
    fields.set(
      action.field,
      Object.freeze({
        field: action.field,
        description: declaration.description,
        type: action.type,
        required: false,
        ...(declaration.allowedValues ? { enum: Object.freeze([...declaration.allowedValues]) } : {}),
      }),
    );
  }
  return Object.freeze([...fields.values()]);
}

export function settingsCliInputFieldsFromDeclarations(
  declarations: readonly SettingsFieldDeclaration[],
): readonly SettingsCliInputField[] {
  const fields = new Map<string, SettingsCliInputField>();
  for (const declaration of declarations) {
    if (!declaration.action || !declaration.cli || fields.has(declaration.action.field)) continue;
    fields.set(
      declaration.action.field,
      Object.freeze({
        field: declaration.action.field,
        description: declaration.description,
        ...declaration.cli,
        ...(declaration.cli.regex === undefined &&
        declaration.cli.projection !== "json-object" &&
        declaration.valueKind === "string" &&
        declaration.pattern
          ? { regex: declaration.pattern }
          : {}),
        ...(declaration.cli.projection === undefined && declaration.valueKind === "integer"
          ? { projection: "number" as const }
          : {}),
        ...(declaration.cli.projection === undefined && declaration.valueKind === "boolean"
          ? { projection: "boolean" as const }
          : {}),
      }),
    );
  }
  return Object.freeze([...fields.values()]);
}

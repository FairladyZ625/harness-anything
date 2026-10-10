import type { EntityActionInputField } from "./entity-kind-registry.ts";
import type { GateWitnessMappingV1 } from "./completion-contract.ts";
import { closeoutProfiles } from "./settings-closeout.ts";
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

/** Presentation group for a settings field, declared once here and derived by the GUI and CLI.
 * Group copy (label and the one-line description with product-term explanations) lives in the
 * GUI locale catalogs keyed by group id; the CLI help renders only the title. */
export interface SettingsFieldGroup {
  readonly id: string;
  /** English title; localized titles live in the GUI locale catalogs keyed by group id. */
  readonly title: string;
  /** Advanced groups render collapsed by default in the GUI (backup tunables). */
  readonly advanced?: boolean;
}

export const SETTINGS_FIELD_GROUPS = Object.freeze([
  {
    id: "new-task-defaults",
    title: "New task defaults",
  },
  {
    id: "dispatch-roles",
    title: "Dispatch roles",
  },
  {
    id: "review-closeout",
    title: "Review and closeout",
  },
  {
    id: "ci-gates",
    title: "CI and completion gates",
  },
  {
    id: "capacity-agenda",
    title: "Capacity and agenda",
  },
  {
    id: "worktree",
    title: "Task worktree setup",
  },
  {
    id: "schedules-nodes",
    title: "Schedules",
  },
  {
    id: "storage-backup",
    title: "Backup",
    advanced: true,
  },
  {
    id: "presentation",
    title: "Presentation",
  },
] as const satisfies readonly SettingsFieldGroup[]);

export type SettingsFieldGroupId = (typeof SETTINGS_FIELD_GROUPS)[number]["id"];

export interface SettingsFieldDeclaration<Value = unknown> {
  readonly path: readonly [string, ...string[]];
  readonly ownership: SettingsFieldOwnership;
  readonly valueKind: SettingsFieldValueKind;
  readonly defaultValue: Value;
  readonly optional?: boolean;
  readonly snapshotRequired?: boolean;
  readonly description: string;
  /** What changing this field does, in one concrete sentence; the description says what it governs. */
  readonly effect: string;
  readonly group: SettingsFieldGroupId;
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
  readonly group: SettingsFieldGroupId;
  readonly effect: string;
}

/** Per-action-field presentation metadata the daemon GUI catalog projects to the settings page. */
export interface SettingsFieldPresentation {
  readonly field: string;
  readonly group: SettingsFieldGroupId;
  readonly effect: string;
  /** Declared default; absent for optional fields whose default is "unset". */
  readonly defaultValue?: unknown;
}

export const settingValuePattern = "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$";
export const settingsLocales = ["en-US", "zh-CN"] as const;
export type SettingsLocale = (typeof settingsLocales)[number];
export const reviewIndependenceLevels = ["execution", "principal"] as const;
export type ReviewIndependence = (typeof reviewIndependenceLevels)[number];
export const decisionReviewRequirementLevels = ["off", "high", "medium_and_high", "all"] as const;
export type DecisionReviewRequirement = (typeof decisionReviewRequirementLevels)[number];
export const rolePreferenceFields = ["defaultWorker", "defaultCommander", "defaultReviewer"] as const;
export const DEFAULT_RESTORE_DRILL_RETENTION = 3;
export const DEFAULT_CI_WORKFLOWS = Object.freeze([] as const);
export const worktreeSetupAdapters = ["node-modules"] as const;
export const worktreeSetupStepPattern = `^(?:${worktreeSetupAdapters.join("|")}|run: \\S.*)$`;

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

// What each closeout check requires, and what switching it off gives up. The switch itself works
// the same for all four (on, off, or unset to follow the closeout profile).
const CLOSEOUT_GATE_COPY = {
  review: {
    description: "Whether a task needs a passing independent review before it can complete.",
    effect: "On: a task cannot complete without one. Off: it can complete unreviewed. Unset follows the profile.",
  },
  consent: {
    description: "Whether a task needs its owner's explicit consent before it can complete.",
    effect: "On: a task waits for the owner's sign-off. Off: it completes without it. Unset follows the profile.",
  },
  factDisposition: {
    description: "Whether every fact (a recorded observation) a task left open must be handled before it completes.",
    effect: "On: open facts block completion. Off: they are left as they are. Unset follows the profile.",
  },
  codeDoc: {
    description: "Whether a task's code changes must be checked against the documents describing them.",
    effect: "On: a task cannot complete until they match. Off: the check is skipped. Unset follows the profile.",
  },
} as const;

export const SETTINGS_FIELD_DECLARATIONS = Object.freeze([
  defineSettingsField({
    path: ["defaultVertical"],
    ownership: repository,
    ...settingId,
    defaultValue: "software/coding",
    snapshotRequired: true,
    description: "Vertical new tasks start in. A vertical is a field of work, such as software coding.",
    effect: "New tasks are offered this vertical's presets and templates.",
    group: "new-task-defaults",
    action: { field: "defaultVertical", type: "string" },
    cli: singleSettingCli("--default-vertical"),
  }),
  defineSettingsField({
    path: ["defaultPreset"],
    ownership: repository,
    ...settingId,
    defaultValue: "standard-task",
    snapshotRequired: true,
    description: "Preset new tasks use unless another is chosen. A preset is a template for one kind of task.",
    effect: "New tasks get this preset's plan template and the checks it requires before completion.",
    group: "new-task-defaults",
    action: { field: "defaultPreset", type: "string" },
    cli: singleSettingCli("--default-preset"),
  }),
  defineSettingsField({
    path: ["defaultProfile"],
    ownership: repository,
    ...settingId,
    defaultValue: "baseline",
    snapshotRequired: true,
    description: "Profile new tasks use within the default preset. A profile is a lighter or stricter variant.",
    effect: "New tasks created from the default preset use this profile's templates and checks.",
    group: "new-task-defaults",
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
      description: "Which agents are preferred as worker, commander and reviewer when work is handed out.",
      effect: "Work is handed to these agents first; a role left unset uses the built-in agent for that role.",
      group: "dispatch-roles",
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
    description: "How separate a reviewer must be from whoever did the work.",
    effect: "execution: another session may review, even the same person's. principal: only another person's agents.",
    group: "review-closeout",
    action: { field: "reviewIndependence", type: "string" },
    cli: { name: "--review-independence", kind: "single", enum: reviewIndependenceLevels },
  }),
  defineSettingsField({
    path: ["decisionReviewRequirement"],
    ownership: repository,
    valueKind: "enum",
    defaultValue: "off",
    allowedValues: decisionReviewRequirementLevels,
    description: "Which decisions, by risk level, need an approved review before they can be accepted.",
    effect: "A decision at a selected risk level cannot be accepted until it has an approved, up-to-date review.",
    group: "review-closeout",
    action: { field: "decisionReviewRequirement", type: "string" },
    cli: { name: "--decision-review-requirement", kind: "single", enum: decisionReviewRequirementLevels },
  }),
  defineSettingsField({
    path: ["reviewReturnBudget"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: 3,
    minimum: 1,
    description: "How many times review may send a task back for rework.",
    effect: "A task sent back more times than this goes to a person instead of another review round.",
    group: "review-closeout",
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
    description: "Language of the interface on this machine.",
    effect: "The GUI and CLI use this language on this machine only; collaborators are unaffected.",
    group: "presentation",
    action: { field: "locale", type: "string" },
    cli: { name: "--locale", kind: "single", enum: settingsLocales },
  }),
  defineSettingsField({
    path: ["scaffolds", "task"],
    ownership: repository,
    ...settingId,
    defaultValue: "governance/task-scaffold.json",
    snapshotRequired: true,
    description: "Repository file that adds to or replaces the preset's documents in every new task package.",
    effect: "New task packages are generated with this file's additions and replacements.",
    group: "new-task-defaults",
    action: { field: "taskScaffold", type: "string" },
    cli: singleSettingCli("--task-scaffold"),
  }),
  defineSettingsField({
    path: ["scaffolds", "repository"],
    ownership: repository,
    ...settingId,
    defaultValue: "governance/repository-scaffold.json",
    snapshotRequired: true,
    description: "Repository file that adds to or replaces the shared documents generated for the repository.",
    effect: "Repository documents are generated with this file's additions and replacements.",
    group: "new-task-defaults",
    action: { field: "repositoryScaffold", type: "string" },
    cli: singleSettingCli("--repository-scaffold"),
  }),
  defineSettingsField({
    path: ["ci", "workflows"],
    ownership: repository,
    valueKind: "string-array",
    defaultValue: DEFAULT_CI_WORKFLOWS,
    pattern: settingValuePattern,
    forbiddenPattern: "\\.ya?ml$",
    uniqueItems: true,
    description: "CI workflows whose runs count as proof that a task's code passed CI.",
    effect: "Only runs of these workflows count; with none selected, tasks are not checked against CI.",
    group: "ci-gates",
    action: { field: "ciWorkflows", type: "string-array" },
    cli: {
      name: "--ci-workflows",
      kind: "repeated",
      regex: settingValuePattern,
      format: "workflow names, or none to stop checking CI (the default)",
    },
    noneMeansEmpty: true,
    yamlStyle: "inline",
  }),
  defineSettingsField({
    path: ["gates"],
    ownership: repository,
    valueKind: "gate-mappings",
    defaultValue: Object.freeze([] as readonly GateWitnessMappingV1[]),
    description: "Canonical gate-to-witness mappings imported from the authored document.",
    effect: "Each completion gate is attested by its mapped witness adapter; none disables that gate.",
    group: "ci-gates",
    action: { field: "gates", type: "json-object-array", internal: true },
  }),
  defineSettingsField({
    path: ["closeout", "profile"],
    ownership: repository,
    valueKind: "enum",
    optional: true,
    defaultValue: undefined,
    allowedValues: closeoutProfiles,
    description: "How strict closeout is. Closeout is the final set of checks before a task is marked complete.",
    effect:
      "Unset follows the frozen domain defaults; standard turns the four checks off and strict turns all four on.",
    group: "review-closeout",
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
      ...CLOSEOUT_GATE_COPY[gate],
      group: "review-closeout",
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
    description: "Most items (tasks, decisions and the like) that can be pinned to the agenda at once.",
    effect: "Once this many are pinned, pinning another is refused until one is unpinned.",
    group: "capacity-agenda",
    action: { field: "agendaPinLimit", type: "number" },
    cli: { name: "--agenda-pin-limit", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["tasks", "wipLimit"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_TASK_WIP_LIMIT,
    minimum: 1,
    description: "Most tasks that can be in progress at once.",
    effect: "Once this many are in progress, starting another is refused until one completes or is cancelled.",
    group: "capacity-agenda",
    action: { field: "wipLimit", type: "number" },
    cli: { name: "--wip-limit", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["tasks", "rootThreshold"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_TASK_ROOT_THRESHOLD,
    minimum: 1,
    description: "Direct subtask count at which a task counts as a work root: a container for its subtasks.",
    effect: "A task with this many direct subtasks and no work of its own stops counting toward the in-progress limit.",
    group: "capacity-agenda",
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
    description: "Steps run in order in each new task worktree before work starts, such as installing dependencies.",
    effect: "New worktrees run the new steps; a failing step stops the task from starting and is named with its log.",
    group: "worktree",
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
    path: ["tasks", "assignmentTtlMs"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: 86_400_000,
    minimum: 1,
    description: "Default task assignment duration in milliseconds.",
    effect: "Applies to new assignments only; existing expiry and execution leases stay unchanged.",
    group: "new-task-defaults",
    action: { field: "taskAssignmentTtlMs", type: "number" },
    cli: { name: "--task-assignment-ttl-ms", kind: "single", regex: "^[1-9][0-9]*$" },
  }),
  defineSettingsField({
    path: ["fleet", "claim", "scope"],
    ownership: repository,
    valueKind: "enum",
    defaultValue: "node",
    allowedValues: ["node", "reserved", "startable"],
    description: "Which eligible tasks nodes may claim automatically.",
    effect: "Node selects named nodes; reserved includes people and teams; startable also includes unassigned tasks.",
    group: "schedules-nodes",
    action: { field: "fleetClaimScope", type: "string" },
    cli: { name: "--fleet-claim-scope", kind: "single", enum: ["node", "reserved", "startable"] },
  }),
  defineSettingsField({
    path: ["runtime", "allowedInstances"],
    ownership: repository,
    valueKind: "string-array",
    defaultValue: undefined,
    optional: true,
    pattern: settingValuePattern,
    uniqueItems: true,
    description: "Runtime instance ids this repository may use from the machine-level instance catalog.",
    effect:
      "When set, only enabled machine instances in this list can receive dispatches; an explicit empty list blocks every instance.",
    group: "schedules-nodes",
    action: { field: "runtimeAllowedInstances", type: "string-array" },
    cli: {
      name: "--runtime-allowed-instance",
      kind: "repeated",
      regex: settingValuePattern,
      format: "runtime instance ids, or none to block all machine instances",
    },
    noneMeansEmpty: true,
    yamlStyle: "block-list",
  }),
  defineSettingsField({
    path: ["schedule", "admissionWindowMs"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: 60_000,
    minimum: 1_000,
    description: "How late a scheduled run may still start when nothing was awake at its due time, in milliseconds.",
    effect:
      "Raise it and a run just missed during sleep or a restart still starts on wake; later ones count as missed.",
    group: "schedules-nodes",
    action: { field: "scheduleAdmissionWindowMs", type: "number" },
    cli: { name: "--schedule-admission-window-ms", kind: "single", regex: "^[1-9][0-9]{3,}$" },
  }),
  defineSettingsField({
    path: ["restoreDrillRetention"],
    ownership: repository,
    valueKind: "integer",
    defaultValue: DEFAULT_RESTORE_DRILL_RETENTION,
    minimum: 1,
    description: "How many successful restore drills are kept. A drill restores a backup to prove it works.",
    effect: "Only this many of the latest successful drills are kept; older ones are deleted.",
    group: "storage-backup",
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
        group: declaration.group,
        effect: declaration.effect,
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

/** Group/effect/default per action field for the GUI settings page; one row per rendered field. */
export function settingsFieldPresentationFromDeclarations(
  declarations: readonly SettingsFieldDeclaration[],
): readonly SettingsFieldPresentation[] {
  const rows = new Map<string, SettingsFieldPresentation>();
  for (const declaration of declarations) {
    const action = declaration.action;
    if (!action || action.internal) continue;
    const existing = rows.get(action.field);
    if (existing && existing.group !== declaration.group)
      throw new Error(`Settings action field ${action.field} spans groups ${existing.group} and ${declaration.group}.`);
    if (existing) continue;
    rows.set(
      action.field,
      Object.freeze({
        field: action.field,
        group: declaration.group,
        effect: declaration.effect,
        ...(declaration.defaultValue !== undefined ? { defaultValue: declaration.defaultValue } : {}),
      }),
    );
  }
  return Object.freeze([...rows.values()]);
}

export const SETTINGS_FIELD_PRESENTATION: readonly SettingsFieldPresentation[] =
  settingsFieldPresentationFromDeclarations(SETTINGS_FIELD_DECLARATIONS);

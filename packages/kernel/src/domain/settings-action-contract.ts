import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import {
  attributeEntityActionCriterion,
  type EntityActionCompileHook,
  type EntityActionCompileInput,
} from "./entity-action-execution.ts";
import { compileSettingsChangedEvent, type SettingsEventBundle } from "./settings-event.ts";
import {
  SETTINGS_ID,
  repositorySettings,
  reviewIndependenceLevels,
  settingsLocales,
  validateRepositorySettings,
  writeRepositorySettingsFacet,
  type RepositorySettingsV1,
  type SettingsLocale,
} from "./settings.ts";

export type SettingsActionDraft =
  | { readonly kind: "event"; readonly bundle: SettingsEventBundle }
  | { readonly kind: "no-changes"; readonly settings: RepositorySettingsV1; readonly revision: number };

export class SettingsActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SettingsActionError";
    this.code = code;
  }
}

const repositoryFieldNames = Object.freeze([
  "defaultVertical",
  "defaultPreset",
  "defaultProfile",
  "reviewIndependence",
  "taskScaffold",
  "repositoryScaffold",
  "walFlushAdaptive",
  "walFlushEvents",
  "walFlushBytes",
  "walFlushMilliseconds",
] as const);

const input = (fields: readonly EntityActionInputField[]): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((candidate) => Object.freeze(candidate))),
    exactlyOneOf: Object.freeze([]),
  });
const field = (
  name: string,
  type: EntityActionInputField["type"] = "string",
  required = false,
  values?: readonly string[],
): EntityActionInputField =>
  Object.freeze({ field: name, type, required, ...(values ? { enum: Object.freeze(values) } : {}) });
const noLease = Object.freeze({ authority: "not-applicable" });
const noOccurrence = Object.freeze({ authority: "not-applicable" });
const settingsConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({
    authority: "settings-event/v1 singleton projection revision",
    subject: `settings/${SETTINGS_ID}`,
    input: "expectedVersion",
    required: false,
    default: "center-bound-current-revision",
    arbitration: "center-single-write-queue",
    conflict: "revision_conflict",
  }),
  leasePolicy: noLease,
  occurrenceClaim: noOccurrence,
  idempotency: Object.freeze({
    authority: "operation-id",
    input: "idempotencyKey",
    scope: `settings/${SETTINGS_ID}/update`,
    retry: "canonical-event-replay",
  }),
  artifactOwnership: Object.freeze({
    owner: `settings/${SETTINGS_ID}`,
    repositoryDocument: "harness.yaml",
    repositoryPolicy: "settings-facet/v1",
    localPreference: ".harness/settings.local.json",
    localPolicy: "runtime-local-no-canonical-event",
  }),
});

export function createSettingsActionCatalog(
  baseAction: (id: "read" | "update") => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  const read = baseAction("read"),
    update = baseAction("update");
  return Object.freeze({
    ref: "kernel/settings-action/v1",
    actions: Object.freeze([
      Object.freeze({
        ...read,
        input: input([]),
        policy: Object.freeze({ ref: "default@5", action: null }),
        criteria: Object.freeze([]),
        concurrency: settingsConcurrency,
        effects: Object.freeze([]),
        returns: actionResultContract,
        explain: "Read the repository Settings singleton and this daemon's local locale preference.",
        execution: Object.freeze({
          ingress: "settings-read",
          compile: null,
          read: true,
          implementation: "catalog-runtime" as const,
          targetIdField: "settingsId",
        }),
      }),
      Object.freeze({
        ...update,
        input: input([
          field("defaultVertical"),
          field("defaultPreset"),
          field("defaultProfile"),
          field("reviewIndependence", "string", false, reviewIndependenceLevels),
          field("locale", "string", false, settingsLocales),
          field("taskScaffold"),
          field("repositoryScaffold"),
          field("walFlushAdaptive", "boolean"),
          field("walFlushEvents", "number"),
          field("walFlushBytes", "number"),
          field("walFlushMilliseconds", "number"),
          field("expectedVersion", "number"),
          field("idempotencyKey"),
        ]),
        policy: Object.freeze({ ref: "default@5", action: "settings-update" }),
        criteria: Object.freeze([
          Object.freeze({
            ref: "settings/singleton-revision",
            failureCode: "revision_conflict",
            explain: "When supplied, expectedVersion matches the current Settings singleton revision.",
          }),
          Object.freeze({
            ref: "settings/catalog-selection",
            failureCode: "invalid_settings_catalog_selection",
            explain: "The selected vertical, preset, and profile resolve to one valid catalog profile.",
          }),
        ]),
        concurrency: settingsConcurrency,
        effects: Object.freeze([
          Object.freeze({ ref: "settings-event/settings_changed", projection: "SettingsProjection" }),
          Object.freeze({ ref: "settings-local/locale_changed", projection: "DaemonLocalSettings" }),
        ]),
        returns: actionResultContract,
        explain:
          "Update the repository Settings singleton through settings-event/v1; locale remains a runtime-local effect.",
        execution: Object.freeze({
          ingress: "settings-update",
          compile: compileSettingsUpdateAction,
          read: false,
          implementation: "catalog-runtime" as const,
          topology: "center-forward-write" as const,
          localOnlyFields: Object.freeze(["locale"]),
          targetIdField: "settingsId",
        }),
      }),
    ]),
  });
}

export const compileSettingsUpdateAction: EntityActionCompileHook = (input) => ({
  kind: "settings",
  result: compileSettingsUpdate(input),
});

export function compileSettingsUpdate(input: EntityActionCompileInput): SettingsActionDraft {
  const current = currentSettings(input),
    revision = input.entityRevision ?? 0,
    expectedVersion = input.action.expectedVersion,
    repositoryChangeRequested = repositoryFieldNames.some((name) => Object.hasOwn(input.action, name));
  settingsActionLocale(input.action.locale);
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0))
    rejectSettings("invalid_command", "expectedVersion must be a non-negative integer when supplied.");
  if (!repositoryChangeRequested) return { kind: "no-changes", settings: current, revision };
  if (expectedVersion !== undefined && Number(expectedVersion) !== revision)
    throw attributeEntityActionCriterion(
      new SettingsActionError(
        "revision_conflict",
        `Settings expected revision ${String(expectedVersion)}, current revision is ${revision}.`,
      ),
      "update",
      "settings/singleton-revision",
    );
  const candidate: RepositorySettingsV1 = {
      schema: "settings/v1",
      settingsId: SETTINGS_ID,
      defaultVertical: updatedText(input.action, "defaultVertical", current.defaultVertical),
      defaultPreset: updatedText(input.action, "defaultPreset", current.defaultPreset),
      defaultProfile: updatedText(input.action, "defaultProfile", current.defaultProfile),
      reviewIndependence: updatedReviewIndependence(input.action.reviewIndependence, current.reviewIndependence),
      scaffolds: {
        task: updatedText(input.action, "taskScaffold", current.scaffolds.task),
        repository: updatedText(input.action, "repositoryScaffold", current.scaffolds.repository),
      },
      walFlush: {
        adaptive: updatedBoolean(input.action, "walFlushAdaptive", current.walFlush.adaptive),
        events: updatedPositiveInteger(input.action, "walFlushEvents", current.walFlush.events),
        bytes: updatedPositiveInteger(input.action, "walFlushBytes", current.walFlush.bytes),
        milliseconds: updatedPositiveInteger(input.action, "walFlushMilliseconds", current.walFlush.milliseconds),
      },
    },
    errors = validateRepositorySettings(candidate);
  if (errors.length) rejectSettings("invalid_command", errors.join("; "));
  const baseDocumentBody = input.currentDocumentBody;
  if (typeof baseDocumentBody !== "string")
    rejectSettings("content_not_ready", "The projected harness.yaml Settings document is unavailable.");
  const candidateDocumentBody = writeRepositorySettingsFacet(baseDocumentBody, candidate);
  if (candidateDocumentBody === baseDocumentBody && stableStringify(candidate) === stableStringify(current))
    return { kind: "no-changes", settings: current, revision };
  return {
    kind: "event",
    bundle: compileSettingsChangedEvent({
      settings: candidate,
      baseDocumentBody,
      candidateDocumentBody,
      eventId: `event-${sha256Text(input.opId)}`,
      opId: input.opId,
      workspaceRevision: input.workspaceRevision,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
    }),
  };
}

export function settingsActionLocale(value: unknown): SettingsLocale | undefined {
  if (value === undefined) return undefined;
  if (settingsLocales.includes(value as SettingsLocale)) return value as SettingsLocale;
  rejectSettings("invalid_command", `locale must be one of ${settingsLocales.join(", ")}.`);
}

function currentSettings(input: EntityActionCompileInput): RepositorySettingsV1 {
  const current = repositorySettings(input.currentEntity as RepositorySettingsV1);
  if (validateRepositorySettings(current).length)
    rejectSettings("content_not_ready", `Settings ${SETTINGS_ID} has no valid canonical projection.`);
  return current;
}

function updatedText(action: Readonly<Record<string, unknown>>, name: string, current: string): string {
  if (!Object.hasOwn(action, name)) return current;
  const value = action[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  rejectSettings("invalid_command", `${name} must be a non-empty string.`);
}

function updatedReviewIndependence(
  value: unknown,
  current: RepositorySettingsV1["reviewIndependence"],
): RepositorySettingsV1["reviewIndependence"] {
  if (value === undefined) return current;
  if (reviewIndependenceLevels.includes(value as RepositorySettingsV1["reviewIndependence"]))
    return value as RepositorySettingsV1["reviewIndependence"];
  rejectSettings("invalid_command", `reviewIndependence must be one of ${reviewIndependenceLevels.join(", ")}.`);
}

function updatedBoolean(action: Readonly<Record<string, unknown>>, name: string, current: boolean): boolean {
  if (!Object.hasOwn(action, name)) return current;
  const value = action[name];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  rejectSettings("invalid_command", `${name} must be true or false.`);
}

function updatedPositiveInteger(action: Readonly<Record<string, unknown>>, name: string, current: number): number {
  if (!Object.hasOwn(action, name)) return current;
  const value = action[name],
    parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  rejectSettings("invalid_command", `${name} must be a positive integer.`);
}

function rejectSettings(code: string, message: string): never {
  throw new SettingsActionError(code, message);
}

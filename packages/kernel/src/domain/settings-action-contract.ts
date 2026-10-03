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
import { consumeKnownError } from "../error-consumption.ts";
import { compileSettingsChangedEvent, type SettingsEventBundle } from "./settings-event.ts";
import {
  SETTINGS_DECLARATION_RUNTIME,
  SETTINGS_ID,
  readSettingsFacet,
  repositorySettings,
  SettingsDeclarationError,
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

/** Single source of the settings update field surface: the action catalog input and the daemon's
 * GUI catalog facet both derive from this list, so a new field appears in every consumer with one
 * edit here instead of per-surface hand-written field lists drifting apart. */
export const settingsUpdateInputFields: readonly EntityActionInputField[] = Object.freeze([
  ...SETTINGS_DECLARATION_RUNTIME.actionInputFields,
  field("gatesFromDocument", "boolean"),
  // Not a persisted setting and not a caller-declared `gates` value: a draft for the authored
  // `settings.gates` facet, which the daemon ingress splices into the authored harness.yaml and
  // mints `gates` from — the document stays the only declaration surface.
  field("gatesDraft", "json-object-array"),
  field("expectedVersion", "number"),
  field("idempotencyKey"),
]);
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
        policy: Object.freeze({ ref: "keycloak-policy@1", action: null }),
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
        input: input(settingsUpdateInputFields),
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
    repositoryChangeRequested = SETTINGS_DECLARATION_RUNTIME.repositoryActionFields.some((name) =>
      Object.hasOwn(input.action, name),
    );
  settingsActionLocale(input.action.locale);
  // The flag is a request to the daemon ingress, which mints `gates` from the authored
  // harness.yaml before compile; reaching the compiler without it means a caller bypassed the
  // read of the authored document and there is nothing honest to apply.
  if (input.action.gatesFromDocument === true && !Object.hasOwn(input.action, "gates"))
    rejectSettings(
      "invalid_command",
      "gatesFromDocument requires the settings-update ingress to mint gates from harness.yaml.",
    );
  if (Object.hasOwn(input.action, "gatesDraft") && !Object.hasOwn(input.action, "gates"))
    rejectSettings(
      "invalid_command",
      "gatesDraft requires the settings-update ingress to splice it into the authored " +
        "harness.yaml and mint gates from the document.",
    );
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0))
    rejectSettings("invalid_command", "expectedVersion must be a non-negative integer when supplied.");
  if (!repositoryChangeRequested) {
    const committed = input.currentDocumentBody;
    if (typeof committed === "string") {
      const authoredBase = authoredDocumentBase(input.action, current, committed);
      if (authoredBase !== committed)
        return {
          kind: "event",
          bundle: compileSettingsChangedEvent({
            settings: current,
            baseDocumentBody: authoredBase,
            candidateDocumentBody: writeRepositorySettingsFacet(authoredBase, current),
            eventId: `event-${sha256Text(input.opId)}`,
            opId: input.opId,
            workspaceRevision: input.workspaceRevision,
            actor: input.actor,
            source: input.source,
            occurredAt: input.occurredAt,
          }),
        };
    }
    return { kind: "no-changes", settings: current, revision };
  }
  if (expectedVersion !== undefined && Number(expectedVersion) !== revision)
    throw attributeEntityActionCriterion(
      new SettingsActionError(
        "revision_conflict",
        `Settings expected revision ${String(expectedVersion)}, current revision is ${revision}.`,
      ),
      "update",
      "settings/singleton-revision",
    );
  const candidate = applyRepositoryAction(current, input.action),
    errors = validateRepositorySettings(candidate);
  if (errors.length) rejectSettings("invalid_command", errors.join("; "));
  const baseDocumentBody = input.currentDocumentBody;
  if (typeof baseDocumentBody !== "string")
    rejectSettings("content_not_ready", "The projected harness.yaml Settings document is unavailable.");
  const authoredBase = authoredDocumentBase(input.action, current, baseDocumentBody),
    candidateDocumentBody = writeRepositorySettingsFacet(authoredBase, candidate);
  if (candidateDocumentBody === baseDocumentBody && stableStringify(candidate) === stableStringify(current))
    return { kind: "no-changes", settings: current, revision };
  return {
    kind: "event",
    bundle: compileSettingsChangedEvent({
      settings: candidate,
      baseDocumentBody: authoredBase,
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

function applyRepositoryAction(
  current: RepositorySettingsV1,
  action: Readonly<Record<string, unknown>>,
): RepositorySettingsV1 {
  try {
    return SETTINGS_DECLARATION_RUNTIME.applyRepositoryAction(
      current as unknown as Readonly<Record<string, unknown>>,
      action,
    ) as unknown as RepositorySettingsV1;
  } catch (error) {
    if (error instanceof SettingsDeclarationError) rejectSettings("invalid_command", error.message);
    throw error;
  }
}

/**
 * `action.authoredDocumentBody` is the live harness.yaml bytes the daemon ingress read — never a
 * caller input. When its settings facet parses to exactly the current projected settings, the file
 * carries no uncommitted semantic edits, so the write bases itself on it: the flag delta lands on
 * the authored bytes and a diverged-but-equal document (key order, formatting, comments) is
 * committed by the event instead of staying a permanent uncommittable worktree edit. A file that
 * parses to different settings keeps the committed base — its edits are imported through flags or
 * `--gates-from-document`, never silently reverted.
 */
function authoredDocumentBase(
  action: Readonly<Record<string, unknown>>,
  current: RepositorySettingsV1,
  committedBody: string,
): string {
  const body = action.authoredDocumentBody;
  if (typeof body !== "string" || body === committedBody) return committedBody;
  try {
    if (stableStringify(repositorySettings(readSettingsFacet(body))) === stableStringify(current)) return body;
  } catch (error) {
    consumeKnownError(error);
  }
  return committedBody;
}

function rejectSettings(code: string, message: string): never {
  throw new SettingsActionError(code, message);
}

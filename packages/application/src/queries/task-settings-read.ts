import {
  currentExecutionCuts,
  DEFAULT_CLOSEOUT_SETTINGS,
  effectiveCloseoutGates,
  INITIAL_SETTINGS_V1,
  repositorySettings,
  SETTINGS_ID,
  validateRepositorySettings,
  type CloseoutGate,
  type CloseoutSnapshot,
  type CloseoutSettingsV1,
  type LocalSettingsV1,
  type RepositorySettingsV1,
  type SettingsV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { queryCodedError } from "./task-query-ports.ts";

export const SETTINGS_ENTITY_MISSING = "settings_entity_missing" as const;

type PresetCloseoutSnapshot = {
  readonly completion: { readonly closeoutDefaults?: Parameters<typeof effectiveCloseoutGates>[2] };
};

/**
 * The one predicate for "does this projection hold a usable Settings entity?", keyed on the row's
 * VALUE rather than its presence. `getEntity` answers `null` for an absent row — never `undefined` —
 * so a presence test against `undefined` silently reports every never-minted repository as
 * already-initialized; that mismatch is what made the settings write loop on brain-os-frontend
 * (793 canonical events, zero settings_changed) while its read stayed uninitialized forever.
 */
export function projectedRepositorySettings(
  projection: Pick<TaskProjectionQueries, "getEntity">,
): RepositorySettingsV1 | null {
  const row = projection.getEntity("settings", SETTINGS_ID);
  if (row === null || row === undefined) return null;
  const value = row.value as unknown;
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length === 0) return null;
  return repositorySettings(value as RepositorySettingsV1);
}

export function readRepositorySettings(projection: Pick<TaskProjectionQueries, "getEntity">): RepositorySettingsV1 {
  const projected = projectedRepositorySettings(projection);
  if (projected === null)
    throw queryCodedError(
      SETTINGS_ENTITY_MISSING,
      // Actionable, and true: no repository action named `bootstrap` exists (`ha bootstrap` is a
      // Keycloak operation), waiting cannot mint an entity no event ever wrote, and a projection
      // rebuild only re-derives existing events — so `ha settings update` is the one command that
      // creates it. It is principal-only by design, which is what the last sentence must say.
      "This repository has no Settings entity yet; its ledger never recorded a settings_changed event. " +
        "Run `ha settings update` as a person (for example `ha settings update --locale en-US`): " +
        "it creates the entity from the authored harness/harness.yaml. Repository settings are " +
        "principal-owned, so this cannot be done inside an agent session — ask the principal to run it " +
        "in their own terminal.",
    );
  const errors = validateRepositorySettings(projected);
  if (errors.length) throw queryCodedError("projection_invalid", errors.join("; "));
  return projected;
}

export function mergeRepositoryLocalSettings(repository: RepositorySettingsV1, local: LocalSettingsV1): SettingsV1 {
  const { schema: _localSchema, runtime, decisions, ...preferences } = local;
  return {
    ...repository,
    ...preferences,
    runtime: { ...repository.runtime, ...runtime },
    ...(decisions === undefined ? {} : { decisions: { ...repository.decisions, ...decisions } }),
  } as unknown as SettingsV1;
}

/** The review-return round limit: the repository `reviewReturnBudget` setting, or the bootstrap
 * default before Settings are projected. A changes_requested verdict below it reopens the
 * implementation round; at or beyond it the cut awaits the owner. This budget only governs review
 * returns; automatic continuation after a worker stop has its own fixed task-level allowance
 * (`incidentContinuationBudget`), so raising this setting cannot extend that loop.
 */
export function readEffectiveReviewReturnBudget(projection: Pick<TaskProjectionQueries, "getEntity">): number {
  const projected = projection.getEntity("settings", "repository")?.value as
    | { readonly reviewReturnBudget?: number }
    | undefined;
  return projected?.reviewReturnBudget ?? INITIAL_SETTINGS_V1.reviewReturnBudget;
}

/**
 * The effective closeout gate set for read-side judgments. Reads the settings facet from
 * the same projection cut as the task being judged; a repository with no settings entity
 * (or a pre-closeout settings event) reads the same standard default bootstrap would mint.
 */
export function readEffectiveCloseoutGates(
  projection: Pick<TaskProjectionQueries, "getEntity" | "readPresetSnapshot">,
  snapshot: CloseoutSnapshot,
): Readonly<Record<CloseoutGate, boolean>> {
  const cuts = currentExecutionCuts(snapshot);
  if (cuts.length === 1) return cuts[0]!.submission!.completionContract!.closeoutGates;
  const preset = snapshot.task?.presetSnapshotDigest
    ? (projection.readPresetSnapshot(snapshot.task.presetSnapshotDigest).snapshot as PresetCloseoutSnapshot)
    : undefined;
  const projected = projection.getEntity("settings", "repository")?.value as
    | { readonly closeout?: CloseoutSettingsV1 }
    | undefined;
  return effectiveCloseoutGates(
    projected?.closeout ?? DEFAULT_CLOSEOUT_SETTINGS,
    snapshot.task?.closeoutOverrides,
    preset?.completion.closeoutDefaults,
  );
}

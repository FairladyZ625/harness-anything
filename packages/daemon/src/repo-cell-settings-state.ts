import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  DEFAULT_CLOSEOUT_SETTINGS,
  effectiveCloseoutGates,
  currentExecutionCuts,
  INITIAL_SETTINGS_V1,
  SETTINGS_ID,
  compileSettingsChangedEvent,
  localSettings,
  parseLocalSettings,
  readSettingsFacet,
  repositorySettings,
  resolveHarnessLayout,
  serializeLocalSettings,
  stableStringify,
  validateRepositorySettings,
  writeRepositorySettingsFacet,
  type CloseoutGate,
  type CloseoutSnapshot,
  type CloseoutSettingsV1,
  type LocalSettingsV1,
  type RepositorySettingsV1,
  type SettingsV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { writeFileDurably } from "../../storage/src/durable-file.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { DispatchArchiveRetention } from "./dispatch-stream-archive.ts";
import type {
  AuthoredSettingsInitialization,
  RepoCellActionContext,
  RepoCellSettingsState,
} from "./repo-cell-action-context.ts";
import type { PresetSnapshotV1 } from "@harness-anything/preset";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonSettingsLastChange } from "./protocol/daemon-settings-read-types.ts";

/** The code a reader sees when the ledger never minted Settings, as distinct from a cut still catching up. */
export const SETTINGS_ENTITY_MISSING = "settings_entity_missing" as const;

/**
 * Which command a mint is being written for. Each one brings its own authority: `settings-update` is
 * principal-only, while `repo-bootstrap` is what `ha init` runs to bring a repository into existence
 * and is legitimately performed by the owner's agent executor. Naming the command (rather than
 * passing a "skip the guard" boolean) is what keeps the two authorities from being confused.
 */
type MintAuthority = { readonly kind: "repo-bootstrap" } | { readonly kind: "settings-update" };

/**
 * Refuse a mint whose command does not actually authorize a repository-Settings write. `repo-bootstrap`
 * carries its own authorization decision, evaluated by the caller against `repo-bootstrap` before the
 * mint is reached, so it needs nothing further here; every other mint answers to the principal rule.
 */
function assertMintAuthority(authority: MintAuthority, binding: RepoCellBinding): void {
  if (authority.kind === "repo-bootstrap") return;
  const refusal = settingsPrincipalRefusal(binding.actor);
  if (refusal !== null) throw cellCodedError(refusal.code, refusal.message);
}

/**
 * The one authority rule for repository Settings: only a principal (no runtime executor) may write
 * them, because they are repository-wide constraints that govern the executor too. Both the
 * `settings-update` guard and the mint itself ask this, so a new caller of the mint cannot acquire
 * an authority the command it belongs to does not have. Returns the refusal, or null when allowed.
 */
export function settingsPrincipalRefusal(
  actor: RepoCellBinding["actor"],
): { readonly code: "settings_write_requires_principal"; readonly message: string } | null {
  if (actor.executor === null) return null;
  return {
    code: "settings_write_requires_principal",
    message:
      `Repository settings can only be changed by the principal; executor ` +
      `${actor.executor.kind}:${actor.executor.id} cannot run settings-update. ` +
      "Escalate to the dispatching principal — run the command yourself in your own terminal, " +
      "outside agent sessions (a `!` shell inside a session still runs as the session's executor) " +
      "— so a person actor can apply the change.",
  };
}

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
    throw cellCodedError(
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
  if (errors.length) throw cellCodedError("projection_invalid", errors.join("; "));
  return projected;
}

export function makeRepoCellSettingsState(cell: RepoCellActionContext): RepoCellSettingsState {
  // Machine-local preferences live under this repository's own local root, never a literal `.harness`.
  const localPath = resolveHarnessLayout(cell.rootDir).settingsLocalPath;

  const readRepository = (): RepositorySettingsV1 => readRepositorySettings(cell.projection);

  const readLocalState = (): { readonly value: LocalSettingsV1; readonly valid: boolean } => {
    const fallback = localSettings(INITIAL_SETTINGS_V1);
    if (!existsSync(localPath)) return { value: fallback, valid: false };
    try {
      const parsed = parseLocalSettings(JSON.parse(readFileSync(localPath, "utf8")));
      if (parsed) return { value: parsed, valid: true };
    } catch (error) {
      consumeKnownError(error);
      // The read boundary stays available while an invalid local preference is repaired by an update.
    }
    return { value: fallback, valid: false };
  };

  const readLocal = (): LocalSettingsV1 => readLocalState().value;

  // The local file's own schema marker is not part of the merged view; every local field is.
  const read = (): SettingsV1 => {
    const { schema: _localSchema, ...local } = readLocal();
    return { ...readRepository(), ...local };
  };

  const writeLocal = (value: LocalSettingsV1): boolean => {
    const current = readLocalState();
    if (current.valid && stableStringify(current.value) === stableStringify(value)) return false;
    writeFileDurably(localPath, serializeLocalSettings(value), 0o600);
    return true;
  };

  const appendInitialization = (
    settings: RepositorySettingsV1,
    baseDocumentBody: string,
    candidateDocumentBody: string,
    opId: string,
    revision: number,
    binding: RepoCellBinding,
  ) => {
    const bundle = compileSettingsChangedEvent({
        settings,
        baseDocumentBody,
        candidateDocumentBody,
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        opId,
        workspaceRevision: revision + 1,
        actor: binding.actor,
        source: binding.source,
        occurredAt: cell.now(),
      }),
      appended = cell.store.append(bundle);
    cell.projection.apply(bundle.event, bundle.plan);
    return appended;
  };

  /**
   * The canonical write that mints a missing Settings entity. It writes repository settings only.
   *
   * Machine-local preferences (`locale`, the GUI deadlines) are this host's own state, and deriving
   * them from a repository value fills every absent local field with its declared default — which is
   * how the mint used to reset a person's `settings.local.json` (2026-10-23 review B1). So the mint
   * never writes local state; only `ha init` seeds a defaults file, and only on a machine that has
   * none yet. Existing local preferences are always left exactly as they are.
   */
  const initialize = (
    initialization: AuthoredSettingsInitialization,
    binding: RepoCellBinding,
    authority: MintAuthority,
  ) => {
    // Same predicate as the reader: an existing row with no usable value is not initialized state.
    if (projectedRepositorySettings(cell.projection) !== null) return null;
    // A mint is a Settings write, so it needs an authority that actually covers repository Settings.
    // The check lives here — at the write, not at the callers — so a new entry point cannot inherit a
    // write that its own command would have refused.
    assertMintAuthority(authority, binding);
    const revision = cell.store.readHead()?.revision ?? 0,
      digest = createHash("sha256")
        .update(`${cell.input.repoId}\0${initialization.candidateDocumentBody}`)
        .digest("hex"),
      opId = `settings-initialize-${digest}`,
      appended = appendInitialization(
        initialization.repository,
        initialization.documentBody,
        initialization.candidateDocumentBody,
        opId,
        revision,
        binding,
      );
    // The defaults file belongs to the machine that just ran `ha init`, and never to a later mint.
    if (authority.kind === "repo-bootstrap" && !existsSync(localPath))
      writeLocal(localSettings(initialization.settings));
    return appended;
  };

  /**
   * `ha init`'s mint. Its authority is the `repo-bootstrap` decision the caller already evaluated —
   * not the principal rule, because init legitimately runs as the owner's agent executor and is the
   * only action that brings a repository into existence.
   */
  const initializeBootstrap = (settings: SettingsV1, documentBody: string, binding: RepoCellBinding) =>
    initialize(authoredInitializationOf(settings, documentBody), binding, { kind: "repo-bootstrap" });

  /** The write path's mint: canonical state only, never this machine's preferences file. */
  const initializeAuthored = (initialization: AuthoredSettingsInitialization, binding: RepoCellBinding) =>
    initialize(initialization, binding, { kind: "settings-update" });
  /**
   * What the mint *would* append, without writing anything: the request is judged against this
   * value first, so a rejected request leaves no event behind. `null` when the entity exists (the
   * authored file is then not consulted at all, so an in-progress edit cannot fail an unrelated
   * write) or when the repository carries no authored settings document to mint from.
   */
  const authoredInitialization = (): AuthoredSettingsInitialization | null => {
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml");
    if (!existsSync(configPath) || projectedRepositorySettings(cell.projection) !== null) return null;
    const documentBody = readFileSync(configPath, "utf8");
    // The authored facet is user input. A malformed one must name itself and the file it is in, not
    // surface as a codeless `service_rejected` from the declaration parser.
    let settings: SettingsV1;
    try {
      settings = readSettingsFacet(documentBody);
    } catch (error) {
      throw cellCodedError(
        "settings_document_invalid",
        `harness/harness.yaml has no usable settings block, so Settings cannot be initialized from it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return authoredInitializationOf(settings, documentBody);
  };

  return {
    initializeBootstrap,
    initializeAuthored,
    authoredInitialization,
    read,
    readLocal,
    readRepository,
    writeLocal,
  };
}

/** The authored settings value and the document bytes a mint would publish from them. */
function authoredInitializationOf(settings: SettingsV1, documentBody: string): AuthoredSettingsInitialization {
  const repository = repositorySettings(settings);
  return {
    settings,
    documentBody,
    repository,
    candidateDocumentBody: writeRepositorySettingsFacet(documentBody, repository),
  };
}

/**
 * The review-return round limit: the repository `reviewReturnBudget` setting, or the bootstrap
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
 * The dispatch-archive retention in force at this projection cut: the repository settings value,
 * else the declared defaults (60 days, no size limit) — including repositories whose Settings
 * entity predates the fields, where absence is the default rather than a hole.
 */
export function readEffectiveDispatchArchiveRetention(
  projection: Pick<TaskProjectionQueries, "getEntity">,
): DispatchArchiveRetention {
  const projected = projection.getEntity("settings", SETTINGS_ID)?.value as
    | { readonly dispatchArchive?: { readonly retentionDays?: number; readonly retentionBytes?: number } }
    | undefined;
  return {
    retentionDays: projected?.dispatchArchive?.retentionDays ?? INITIAL_SETTINGS_V1.dispatchArchive.retentionDays,
    retentionBytes: projected?.dispatchArchive?.retentionBytes ?? INITIAL_SETTINGS_V1.dispatchArchive.retentionBytes,
  };
}

/** The optimistic-concurrency token for repository settings: the Settings singleton row's
 * workspace revision, read at the same projection cut on both center and edge. The write path
 * compares `expectedVersion` against exactly this value, so every caller that needs the token
 * (GUI settings read, receipt evidence) derives it here instead of re-deriving an attribution
 * revision that a stale cache can diverge from. */
export function settingsSingletonRevision(projection: Pick<TaskProjectionQueries, "getEntity">): number {
  return projection.getEntity("settings", SETTINGS_ID)?.workspaceRevision ?? 0;
}

/** Attribution is read at the same projection cut as the settings value, on both center and edge. */
export function settingsLastChanged(
  projection: Pick<TaskProjectionQueries, "readSettingsEvent">,
): DaemonSettingsLastChange | "initial" {
  const event = projection.readSettingsEvent();
  if (!event) return "initial";
  return {
    occurredAt: event.occurredAt,
    actor:
      event.actor.executor === null
        ? `person:${event.actor.principal.personId}`
        : `${event.actor.executor.kind}:${event.actor.executor.id}`,
    revision: event.workspaceRevision,
  };
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
    ? (projection.readPresetSnapshot(snapshot.task.presetSnapshotDigest).snapshot as PresetSnapshotV1)
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

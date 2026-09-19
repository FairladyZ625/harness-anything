import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  DEFAULT_CLOSEOUT_SETTINGS,
  effectiveCloseoutGates,
  INITIAL_SETTINGS_V1,
  SETTINGS_LOCAL_PATH,
  compileSettingsChangedEvent,
  isSettingsEvent,
  parseLocalSettings,
  readSettingsFacet,
  repositorySettings,
  resolveHarnessLayout,
  serializeLocalSettings,
  validateRepositorySettings,
  writeRepositorySettingsFacet,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type CloseoutGate,
  type CloseoutOverridesV1,
  type CloseoutSettingsV1,
  type RepositorySettingsV1,
  type SettingsLocale,
  type SettingsV1,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
import { writeFileDurably } from "./durable-file.ts";
import type { RepoCellActionContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonSettingsLastChange } from "./protocol/daemon-settings-read-types.ts";

export function makeRepoCellSettingsState(cell: RepoCellActionContext): RepoCellSettingsState {
  const localPath = path.join(cell.rootDir, ...SETTINGS_LOCAL_PATH.split("/"));

  const readRepository = (): RepositorySettingsV1 => {
    const projected = cell.projection.getEntity("settings", "repository")?.value;
    if (projected === undefined)
      throw cell.cellCodedError(
        "projection_pending",
        "Settings projection is unavailable; bootstrap the repository before retrying.",
      );
    const current = repositorySettings(projected as unknown as RepositorySettingsV1),
      errors = validateRepositorySettings(current);
    if (errors.length) throw cell.cellCodedError("projection_invalid", errors.join("; "));
    return current;
  };

  const readLocalState = (): { readonly locale: SettingsLocale; readonly valid: boolean } => {
    if (!existsSync(localPath)) return { locale: INITIAL_SETTINGS_V1.locale, valid: false };
    try {
      const parsed = parseLocalSettings(JSON.parse(readFileSync(localPath, "utf8")));
      if (parsed) return { locale: parsed.locale, valid: true };
    } catch (error) {
      consumeKnownError(error);
      // The read boundary stays available while an invalid local preference is repaired by an update.
    }
    return { locale: INITIAL_SETTINGS_V1.locale, valid: false };
  };

  const read = (): SettingsV1 => ({ ...readRepository(), locale: readLocalState().locale });

  const writeLocal = (locale: SettingsLocale): boolean => {
    const current = readLocalState();
    if (current.valid && current.locale === locale) return false;
    writeFileDurably(localPath, serializeLocalSettings(locale), 0o600);
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

  const initialize = (settings: SettingsV1, documentBody: string, binding: RepoCellBinding) => {
    if (cell.projection.getEntity("settings", "repository")?.value !== undefined) return null;
    const repository = repositorySettings(settings),
      candidateDocumentBody = writeRepositorySettingsFacet(documentBody, repository),
      revision = cell.store.readHead()?.revision ?? 0,
      digest = createHash("sha256").update(`${cell.input.repoId}\0${candidateDocumentBody}`).digest("hex"),
      opId = `settings-initialize-${digest}`,
      appended = appendInitialization(repository, documentBody, candidateDocumentBody, opId, revision, binding);
    writeLocal(settings.locale);
    return appended;
  };

  // A repository that carries no authored settings document has nothing to mint into the ledger.
  const initializeFromAuthoredDocument = (binding: RepoCellBinding) => {
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml");
    if (!existsSync(configPath) || cell.projection.getEntity("settings", "repository") !== undefined) return null;
    const documentBody = readFileSync(configPath, "utf8");
    return initialize(readSettingsFacet(documentBody), documentBody, binding);
  };

  return { initialize, initializeFromAuthoredDocument, read, readRepository, writeLocal };
}

/**
 * The effective review return budget for one task: the task-scoped override when the contract
 * carries one, else the repository setting (or the bootstrap default before it is projected).
 */
export function readEffectiveReviewReturnBudget(
  projection: Pick<TaskProjectionQueries, "getEntity">,
  task: { readonly reviewReturnBudget?: number } | null | undefined,
): { readonly value: number; readonly source: "task" | "repository" } {
  if (task?.reviewReturnBudget !== undefined) return { value: task.reviewReturnBudget, source: "task" };
  const projected = projection.getEntity("settings", "repository")?.value as
    | { readonly reviewReturnBudget?: number }
    | undefined;
  return {
    value: projected?.reviewReturnBudget ?? INITIAL_SETTINGS_V1.reviewReturnBudget,
    source: "repository",
  };
}

/**
 * The `settings read` attribution: the latest `settings_changed` event carries the provenance
 * (occurredAt, actor, workspace revision). When projection and readEventAtRevision are available,
 * it resolves the latest settings entity revision in O(1) via primary-key lookup. When projection
 * has no settings entity, it immediately reports "initial". Otherwise it derives attribution through
 * the bounded `readBatch` window. The actor compacts to `person:<personId>` or `<executor-kind>:<id>`.
 */
export function settingsLastChanged(
  store: Pick<CanonicalEventStore, "readBatch"> & {
    readonly readEventAtRevision?: (revision: number) => CanonicalEventV1 | null;
  },
  projection?: Pick<TaskProjectionQueries, "getEntity">,
): DaemonSettingsLastChange | "initial" {
  if (projection) {
    const entity = projection.getEntity("settings", "repository");
    if (!entity) return "initial";
    if (typeof store.readEventAtRevision === "function") {
      const event = store.readEventAtRevision(entity.workspaceRevision);
      if (event && isSettingsEvent(event)) {
        return {
          occurredAt: event.occurredAt,
          actor:
            event.actor.executor === null
              ? `person:${event.actor.principal.personId}`
              : `${event.actor.executor.kind}:${event.actor.executor.id}`,
          revision: event.workspaceRevision,
        };
      }
    }
  }
  let latest: CanonicalEventV1 | undefined,
    cursor: string | null = null;
  for (;;) {
    const batch = store.readBatch(cursor, 1024);
    for (const event of batch.events) if (isSettingsEvent(event)) latest = event;
    cursor = batch.cursor;
    if (batch.done) break;
  }
  if (latest === undefined) return "initial";
  return {
    occurredAt: latest.occurredAt,
    actor:
      latest.actor.executor === null
        ? `person:${latest.actor.principal.personId}`
        : `${latest.actor.executor.kind}:${latest.actor.executor.id}`,
    revision: latest.workspaceRevision,
  };
}

/**
 * The effective closeout gate set for read-side judgments. Reads the settings facet from
 * the same projection cut as the task being judged; a repository with no settings entity
 * (or a pre-closeout settings event) reads the same standard default bootstrap would mint.
 */
export function readEffectiveCloseoutGates(
  projection: Pick<TaskProjectionQueries, "getEntity">,
  taskGateIds: readonly string[],
  taskOverrides?: CloseoutOverridesV1,
): Readonly<Record<CloseoutGate, boolean>> {
  const projected = projection.getEntity("settings", "repository")?.value as
    | { readonly closeout?: CloseoutSettingsV1 }
    | undefined;
  return effectiveCloseoutGates(projected?.closeout ?? DEFAULT_CLOSEOUT_SETTINGS, taskGateIds, taskOverrides);
}

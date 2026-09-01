import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  INITIAL_SETTINGS_V1,
  SETTINGS_LOCAL_PATH,
  compileSettingsChangedEvent,
  parseLocalSettings,
  readSettingsFacet,
  repositorySettings,
  resolveHarnessLayout,
  serializeLocalSettings,
  validateRepositorySettings,
  writeRepositorySettingsFacet,
  type RepositorySettingsV1,
  type SettingsLocale,
  type SettingsV1,
} from "../../kernel/src/index.ts";
import { writeFileDurably } from "./durable-file.ts";
import type { RepoCellActionContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

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
    cell.store.configureWalFlushPolicy?.(settings.walFlush);
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
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml"),
      isSettingsEvent = (event: { readonly schema: string }) => event.schema === "settings-event/v1";
    if (!existsSync(configPath) || cell.store.read().events.some(isSettingsEvent)) return null;
    const documentBody = readFileSync(configPath, "utf8");
    return initialize(readSettingsFacet(documentBody), documentBody, binding);
  };

  return { initialize, initializeFromAuthoredDocument, read, readRepository, writeLocal };
}

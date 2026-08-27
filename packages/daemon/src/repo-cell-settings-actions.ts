import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  INITIAL_SETTINGS_V1,
  SETTINGS_LOCAL_PATH,
  compileSettingsChangedEvent,
  parseLocalSettings,
  readSettingsFacet,
  repositorySettings,
  resolveHarnessLayout,
  serializeLocalSettings,
  validateRepositorySettings,
  validateSettingsV1,
  writeRepositorySettingsFacet,
  type RepositorySettingsV1,
  type SettingsLocale,
  type SettingsV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { writeFileDurably } from "./durable-file.ts";
import { runPresetAction } from "../../preset/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function makeRepoCellSettingsActions(cell: any) {
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
    } catch {
      // The read boundary stays available while an invalid local preference is repaired by an update.
    }
    return { locale: INITIAL_SETTINGS_V1.locale, valid: false };
  };
  const readLocal = (): SettingsLocale => readLocalState().locale;

  const read = (): SettingsV1 => {
    const repository = readRepository();
    return { ...repository, locale: readLocal() };
  };

  const append = (
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
      opId = `settings-initialize-${digest}`;
    const appended = append(repository, documentBody, candidateDocumentBody, opId, revision, binding);
    writeFileDurably(localPath, serializeLocalSettings(settings.locale), 0o600);
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

  const updateLocal = (locale: SettingsLocale, opId: string, revision: number): WriteReceipt => {
    const local = readLocalState(),
      current = local.locale,
      settings = { ...read(), locale };
    if (local.valid && current === locale)
      return {
        outcome: "no_changes",
        opId,
        revision,
        evidence: JSON.stringify({ schema: "settings-local-update/v1", settings }),
        visibility: "center",
        code: "no_changes",
        origin: "daemon",
        nextAction: "No action is required.",
        proof: {
          committedRevision: revision,
          appliedCut: revision,
          durable: true,
          canonicalVisible: true,
          worktreeVisible: true,
        },
        summary: "Local settings already match the requested values.",
      } as WriteReceipt;
    writeFileDurably(localPath, serializeLocalSettings(locale), 0o600);
    return {
      outcome: "applied",
      opId,
      revision,
      evidence: JSON.stringify({ schema: "settings-local-update/v1", settings }),
      visibility: "center",
      proof: {
        committedRevision: revision,
        appliedCut: revision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      summary: "Updated local settings.",
    } as WriteReceipt;
  };

  const update = async (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
    const current = read(),
      repository: RepositorySettingsV1 = {
        schema: current.schema,
        settingsId: current.settingsId,
        defaultVertical: settingsText(action.defaultVertical) ?? current.defaultVertical,
        defaultPreset: settingsText(action.defaultPreset) ?? current.defaultPreset,
        defaultProfile: settingsText(action.defaultProfile) ?? current.defaultProfile,
        scaffolds: {
          task: settingsText(action.taskScaffold) ?? current.scaffolds.task,
          repository: settingsText(action.repositoryScaffold) ?? current.scaffolds.repository,
        },
      },
      locale = (settingsText(action.locale) ?? current.locale) as SettingsLocale,
      settings: SettingsV1 = { ...repository, locale },
      errors = validateSettingsV1(settings),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, settingsText(action.idempotencyKey) ? 0 : revision);
    if (errors.length) throw cell.cellCodedError("invalid_command", errors.join("; "));

    const repositoryChanged = JSON.stringify(repository) !== JSON.stringify(repositorySettings(current)),
      localChanged = locale !== current.locale;
    if (!repositoryChanged) return updateLocal(locale, opId, revision);

    const presets = (await runPresetAction({
        rootDir: cell.rootDir,
        action: { kind: "preset-list", verticalId: repository.defaultVertical },
        settings,
      })) as readonly SettingsCatalogPreset[],
      preset = presets.find(
        (row) => row.id === repository.defaultPreset && row.verticalId === repository.defaultVertical,
      ),
      selection = [repository.defaultVertical, repository.defaultPreset, repository.defaultProfile].join("/");
    if (preset?.validity !== "valid" || !preset.profiles?.some((profile) => profile.id === repository.defaultProfile))
      throw cell.cellCodedError(
        "invalid_settings_catalog_selection",
        `Settings selection ${selection} is not a valid catalog preset profile.`,
      );

    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml"),
      baseDocumentBody = readFileSync(configPath, "utf8"),
      candidateDocumentBody = writeRepositorySettingsFacet(baseDocumentBody, repository);
    const existing = cell.store.readEvent(opId);
    if (existing) return cell.receiptForOperation(opId, binding);
    const appended = append(repository, baseDocumentBody, candidateDocumentBody, opId, revision, binding),
      publication = cell.publicPublication(appended),
      applied = cell.projection.readOperation(opId),
      canonicalVisible = applied !== null && applied.watermark >= appended.revision;
    if (localChanged) writeFileDurably(localPath, serializeLocalSettings(locale), 0o600);
    return {
      outcome: canonicalVisible ? "applied" : "pending",
      opId,
      revision: appended.revision,
      evidence: JSON.stringify({ schema: "settings-update/v1", settings }),
      visibility: "center",
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible: true,
      },
      ...publication,
      summary: localChanged ? "Updated repository and local settings." : "Updated repository settings.",
      ...(canonicalVisible ? {} : { nextAction: `Run ha receipt show ${opId} before retrying.` }),
    } as WriteReceipt;
  };

  return { initialize, initializeFromAuthoredDocument, read, readRepository, update };
}

interface SettingsCatalogPreset {
  readonly id: string;
  readonly verticalId: string;
  readonly validity: "valid" | "unavailable" | "blocked";
  readonly profiles?: ReadonlyArray<{ readonly id: string }>;
}

function settingsText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

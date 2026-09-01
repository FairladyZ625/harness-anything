import {
  SETTINGS_ID,
  isSettingsEvent,
  settingsActionLocale,
  type EntityActionCompileInput,
  type SettingsActionDraft,
  type SettingsV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { runPresetAction } from "../../preset/src/index.ts";
import type { RepoCellRuntimeContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

const repositoryEffect = "settings-event/settings_changed";
const localEffect = "settings-local/locale_changed";

export function makeSettingsActionRuntime(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
): EntityActionCatalogRunner {
  return async (contract, action, binding, catalogOpId): Promise<WriteReceipt> => {
    if (contract.execution.read) return readSettings(cell, settingsState, action, binding);
    if (binding.authorizationDecision?.outcome !== "allowed")
      throw cell.cellCodedError("actor_unauthorized", "Settings Action execution requires AuthorizationPort approval.");
    const row = cell.projection.getEntity("settings", SETTINGS_ID),
      revision = row?.workspaceRevision ?? 0,
      opId = settingsOperationId(cell, action, binding, revision, catalogOpId),
      targetRef = contract.target.refTemplate.replace("{id}", SETTINGS_ID),
      locale = settingsActionLocale(action.locale),
      existing = cell.store.readEvent(opId);
    if (existing) {
      if (!isSettingsEvent(existing))
        throw cell.cellCodedError("revision_conflict", `Operation ${opId} belongs to a non-Settings event.`);
      const localChanged = locale === undefined ? false : settingsState.writeLocal(locale),
        receipt = cell.receiptForOperation(opId, binding);
      return replayReceipt(receipt, settingsState.read(), localChanged, targetRef);
    }
    const document = cell.projection.readDocument("harness.yaml"),
      compile = contract.execution.compile;
    if (!compile) throw cell.cellCodedError("invalid_command", `${action.kind} has no Settings event compiler.`);
    const compiled = compile({
      action,
      actor: binding.actor,
      source: binding.source,
      session: resolveWriteSessionIdentity(binding, cell.projection),
      opId,
      occurredAt: cell.now(),
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      currentEntity: row?.value,
      entityRevision: revision,
      ...(document.document?.body === undefined ? {} : { currentDocumentBody: document.document.body }),
    } satisfies EntityActionCompileInput);
    if (compiled.kind !== "settings")
      throw cell.cellCodedError("invalid_store", `${action.kind} compiled a non-Settings action draft.`);
    return publishSettingsDraft(cell, settingsState, opId, compiled.result, locale, targetRef);
  };
}

function readSettings(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const row = cell.projection.getEntity("settings", SETTINGS_ID),
    settings = settingsState.read(),
    revision = row?.workspaceRevision ?? 0,
    cut = cell.projection.list(),
    visible = row !== undefined && cut.status === "ready",
    base = {
      opId: cell.operationId(action, binding, cell.input.repoId, revision),
      revision,
      evidence: JSON.stringify({
        schema: "settings-action-read/v1",
        settings,
        entityRevision: revision,
        status: cut.status,
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: cut.sourceRevision,
        appliedCut: cut.watermark,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: null,
      },
      settingsId: SETTINGS_ID,
      settings,
      effects: [] as readonly string[],
      updatedProjection: null,
    };
  return visible
    ? ({ outcome: "applied", ...base } as WriteReceipt)
    : ({
        outcome: "pending",
        ...base,
        nextAction: `Retry settings read after projection catch-up to revision ${cut.sourceRevision}.`,
      } as WriteReceipt);
}

async function publishSettingsDraft(
  cell: RepoCellRuntimeContext,
  settingsState: RepoCellSettingsState,
  opId: string,
  draft: SettingsActionDraft,
  locale: SettingsV1["locale"] | undefined,
  targetRef: string,
): Promise<WriteReceipt> {
  if (draft.kind === "no-changes") {
    const localChanged = locale === undefined ? false : settingsState.writeLocal(locale),
      headRevision = cell.store.readHead()?.revision ?? 0,
      settings = settingsState.read();
    return {
      outcome: localChanged ? "applied" : "no_changes",
      opId,
      revision: draft.revision,
      evidence: JSON.stringify({ schema: "settings-update/v1", settings }),
      visibility: "center",
      proof: {
        committedRevision: headRevision,
        appliedCut: headRevision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      effects: localChanged ? [localEffect] : [],
      updatedProjection: null,
      summary: localChanged ? "Updated local settings." : "Settings already match the requested values.",
      ...(localChanged
        ? {}
        : {
            code: "no_changes",
            origin: "daemon",
            nextAction: "No action is required.",
          }),
    } as WriteReceipt;
  }
  const repository = draft.bundle.event.payload.settings,
    fullSettings: SettingsV1 = { ...repository, locale: locale ?? settingsState.read().locale };
  await assertCatalogSelection(cell.rootDir, fullSettings);
  const appended = cell.store.append(draft.bundle),
    publication = cell.publicPublication(appended);
  cell.store.configureWalFlushPolicy?.(repository.walFlush);
  cell.projection.apply(draft.bundle.event, draft.bundle.plan);
  const localChanged = locale === undefined ? false : settingsState.writeLocal(locale),
    applied = cell.projection.readOperation(draft.bundle.event.opId),
    canonicalVisible = applied !== null && applied.watermark >= appended.revision,
    receipt = {
      opId: draft.bundle.event.opId,
      revision: appended.revision,
      evidence: JSON.stringify({ schema: "settings-update/v1", settings: settingsState.read() }),
      visibility: "center" as const,
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible: true,
      },
      ...publication,
      effects: localChanged ? [repositoryEffect, localEffect] : [repositoryEffect],
      updatedProjection: { kind: "settings", ref: targetRef, revision: appended.revision },
      summary: localChanged ? "Updated repository and local settings." : "Updated repository settings.",
    };
  return canonicalVisible
    ? ({ outcome: "applied", ...receipt } as WriteReceipt)
    : ({
        outcome: "pending",
        ...receipt,
        nextAction: `Run ha receipt show ${draft.bundle.event.opId} before retrying.`,
      } as WriteReceipt);
}

function replayReceipt(
  receipt: WriteReceipt,
  settings: SettingsV1,
  localChanged: boolean,
  targetRef: string,
): WriteReceipt {
  return {
    ...receipt,
    evidence: JSON.stringify({ schema: "settings-update/v1", settings, replay: true }),
    proof: receipt.proof ? { ...receipt.proof, worktreeVisible: true } : receipt.proof,
    effects: localChanged ? [repositoryEffect, localEffect] : [repositoryEffect],
    updatedProjection: { kind: "settings", ref: targetRef, revision: receipt.revision ?? null },
    summary: localChanged
      ? "Replayed repository settings and repaired local settings."
      : "Replayed repository settings.",
  } as WriteReceipt;
}

function settingsOperationId(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  catalogOpId: string,
): string {
  if (typeof action.idempotencyKey === "string" && action.idempotencyKey.trim())
    return cell.operationId(action, binding, cell.input.repoId, 0);
  const version = action.expectedVersion === undefined ? revision : Number(action.expectedVersion);
  return Number.isSafeInteger(version) ? cell.operationId(action, binding, cell.input.repoId, version) : catalogOpId;
}

async function assertCatalogSelection(rootDir: string, settings: SettingsV1): Promise<void> {
  const presets = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list", verticalId: settings.defaultVertical },
      settings,
    })) as readonly SettingsCatalogPreset[],
    preset = presets.find((row) => row.id === settings.defaultPreset && row.verticalId === settings.defaultVertical),
    selection = [settings.defaultVertical, settings.defaultPreset, settings.defaultProfile].join("/");
  if (preset?.validity !== "valid" || !preset.profiles?.some((profile) => profile.id === settings.defaultProfile))
    throw Object.assign(new Error(`Settings selection ${selection} is not a valid catalog preset profile.`), {
      code: "invalid_settings_catalog_selection",
    });
}

interface SettingsCatalogPreset {
  readonly id: string;
  readonly verticalId: string;
  readonly validity: "valid" | "unavailable" | "blocked";
  readonly profiles?: ReadonlyArray<{ readonly id: string }>;
}

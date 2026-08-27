import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  INITIAL_SETTINGS_V1,
  readSettingsFacet,
  resolveHarnessLayout,
  validateSettingsV1,
  writeSettingsFacet,
  type SettingsV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { runPresetAction } from "../../preset/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function makeRepoCellSettingsActions(cell: any) {
  const projected = (): SettingsV1 | null => {
    const projected = cell.projection.getEntity("settings", "repository")?.value;
    if (projected === undefined) return null;
    const errors = validateSettingsV1(projected);
    if (errors.length) throw cell.cellCodedError("invalid_store", errors.join("; "));
    return projected as unknown as SettingsV1;
  };

  const read = (): SettingsV1 => {
    const settings = projected();
    if (settings === null) {
      const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml");
      if (!existsSync(configPath)) return INITIAL_SETTINGS_V1;
      return readSettingsFacet(readFileSync(configPath, "utf8"));
    }
    return settings;
  };

  const update = async (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
    const current = read(),
      settings: SettingsV1 = {
        schema: current.schema,
        settingsId: current.settingsId,
        defaultVertical: settingsText(action.defaultVertical) ?? current.defaultVertical,
        defaultPreset: settingsText(action.defaultPreset) ?? current.defaultPreset,
        defaultProfile: settingsText(action.defaultProfile) ?? current.defaultProfile,
        locale: (settingsText(action.locale) ?? current.locale) as SettingsV1["locale"],
        scaffolds: {
          task: settingsText(action.taskScaffold) ?? current.scaffolds.task,
          repository: settingsText(action.repositoryScaffold) ?? current.scaffolds.repository,
        },
      },
      errors = validateSettingsV1(settings);
    if (errors.length) throw cell.cellCodedError("invalid_command", errors.join("; "));
    const presets = (await runPresetAction({
        rootDir: cell.rootDir,
        action: { kind: "preset-list", verticalId: settings.defaultVertical },
        settings,
      })) as readonly SettingsCatalogPreset[],
      preset = presets.find((row) => row.id === settings.defaultPreset && row.verticalId === settings.defaultVertical),
      selection = [settings.defaultVertical, settings.defaultPreset, settings.defaultProfile].join("/");
    if (preset?.validity !== "valid" || !preset.profiles?.some((profile) => profile.id === settings.defaultProfile))
      throw cell.cellCodedError(
        "invalid_settings_catalog_selection",
        `Settings selection ${selection} is not a valid catalog preset profile.`,
      );
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml"),
      baseDocumentBody = readFileSync(configPath, "utf8"),
      candidateDocumentBody = writeSettingsFacet(baseDocumentBody, settings),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, settingsText(action.idempotencyKey) ? 0 : revision);
    if (candidateDocumentBody === baseDocumentBody)
      return {
        outcome: "no_changes",
        opId,
        revision,
        evidence: JSON.stringify({ schema: "settings-update/v1", settings }),
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
        summary: "Repository settings already match the requested values.",
      } as WriteReceipt;
    const existing = cell.store.readEvent(opId);
    if (existing) return cell.receiptForOperation(opId, binding);
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
      appended = cell.store.append(bundle),
      publication = cell.publicPublication(appended);
    cell.projection.apply(bundle.event, bundle.plan);
    const applied = cell.projection.readOperation(opId),
      canonicalVisible = applied !== null && applied.watermark >= appended.revision;
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
      summary: "Updated repository settings.",
      ...(canonicalVisible ? {} : { nextAction: `Run ha receipt show ${opId} before retrying.` }),
    } as WriteReceipt;
  };

  return { read, update };
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

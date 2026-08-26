import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  readSettingsFacet,
  resolveHarnessLayout,
  validateSettingsV1,
  writeSettingsFacet,
  type SettingsV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function makeRepoCellSettingsActions(cell: any) {
  const read = (): SettingsV1 => {
    const projected = cell.projection.getEntity("settings", "repository")?.value;
    if (projected !== undefined) {
      const errors = validateSettingsV1(projected);
      if (errors.length) throw cell.cellCodedError("invalid_store", errors.join("; "));
      return projected as unknown as SettingsV1;
    }
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml");
    return readSettingsFacet(readFileSync(configPath, "utf8"));
  };

  const update = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt => {
    const current = read(),
      settings: SettingsV1 = {
        ...current,
        ...(text(action.defaultVertical) ? { defaultVertical: text(action.defaultVertical)! } : {}),
        ...(text(action.defaultPreset) ? { defaultPreset: text(action.defaultPreset)! } : {}),
        ...(text(action.defaultProfile) ? { defaultProfile: text(action.defaultProfile)! } : {}),
        ...(text(action.locale) ? { locale: text(action.locale)! as SettingsV1["locale"] } : {}),
        scaffolds: {
          task: text(action.taskScaffold) ?? current.scaffolds.task,
          repository: text(action.repositoryScaffold) ?? current.scaffolds.repository,
        },
      },
      errors = validateSettingsV1(settings);
    if (errors.length) throw cell.cellCodedError("invalid_command", errors.join("; "));
    const configPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "harness.yaml"),
      baseDocumentBody = readFileSync(configPath, "utf8"),
      candidateDocumentBody = writeSettingsFacet(baseDocumentBody, settings),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, text(action.idempotencyKey) ? 0 : revision);
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

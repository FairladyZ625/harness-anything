import { prepareDossierSynthesis } from "@harness-anything/application/internal/commands/living-dossier.ts";
import {
  readDossierContent,
  readDossierContext,
  readDossierStatus,
} from "@harness-anything/application/internal/queries/living-dossier.ts";
import { isDossierSynthesisEvent } from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import { scheduleClaimForSource } from "@harness-anything/kernel/internal/domain/schedule-action-contract.ts";
import type { ScheduleV1, WriteReceiptDraft } from "@harness-anything/kernel";
import { readCanonicalVerticalDeclaration, readDefaultVerticalDefinition } from "./vertical-declaration-action.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

export function dossierReads(cell: RepoCellOperationalContext) {
  const verticalId = cell.settings.readRepository().defaultVertical;
  const accepted = readCanonicalVerticalDeclaration(cell.projection)?.definition;
  // Existing repositories accepted a declaration before dossier slots existed. Read the active
  // package's authored slots until a declaration containing them has been accepted.
  const definition =
    accepted?.id === verticalId && accepted.livingDossier
      ? accepted
      : readDefaultVerticalDefinition(cell.rootDir, verticalId);
  const slot = (id: unknown) => {
    const selected = definition.livingDossier?.slots.find(({ id: candidate }) => candidate === id);
    if (!selected) throw cell.cellCodedError("entity_not_found", `Dossier slot ${String(id)} is not declared.`);
    return selected;
  };
  return {
    definition,
    slot,
    status: () => readDossierStatus(cell, definition, cell.now()),
    read: (id: unknown) => readDossierContent(cell, definition.id, slot(id)),
    context: (id: unknown, maxWatermark: unknown) =>
      readDossierContext(cell, definition.id, slot(id), maxWatermark, definition.entityKinds),
  };
}

export function runDossierAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceiptDraft {
  const reads = dossierReads(cell);
  if (action.kind === "dossier-status" || action.kind === "dossier-context") {
    const result =
      action.kind === "dossier-status" ? reads.status() : reads.context(action.slotId, action.maxWatermark);
    const revision = cell.store.readHead()?.revision ?? 0;
    return cell.readResult(cell.operationId(action, binding, cell.input.repoId, revision), result, revision, null);
  }

  // The enclosing RepoCell has authorized this action and owns its serialized publication turn.
  if (binding.authorizationDecision?.outcome !== "allowed")
    throw cell.cellCodedError("authorization_denied", "Dossier synthesis requires repository maintainer authority.");
  assertScheduleClaim(cell, action, binding);
  const opId = cell.operationId(action, binding, cell.input.repoId, 0);
  const existing = cell.store.readEvent(opId);
  if (existing) {
    if (!isDossierSynthesisEvent(existing))
      throw cell.cellCodedError("invalid_store", "Dossier operation id belongs to another action.");
    return dossierReceipt(cell.receiptForOperation(opId, binding), existing.payload.state);
  }
  const bundle = prepareDossierSynthesis({
    reader: cell,
    verticalId: reads.definition.id,
    slot: reads.slot(action.slotId),
    expectedWatermark: action.expectedWatermark,
    watermark: action.watermark,
    body: action.body,
    actor: binding.actor,
    source: binding.source,
    occurredAt: cell.now(),
    opId,
  });
  cell.store.append(bundle);
  cell.projection.apply(bundle.event, bundle.plan);
  return dossierReceipt(cell.receiptForOperation(opId, binding), bundle.event.payload.state);
}

function dossierReceipt(receipt: WriteReceiptDraft, state: object): WriteReceiptDraft {
  return { ...receipt, evidence: JSON.stringify({ schema: "dossier-synthesis/v1", ...state }) };
}

function assertScheduleClaim(cell: RepoCellOperationalContext, action: RepoTaskAction, binding: RepoCellBinding): void {
  const principal = binding.executionPrincipal;
  if (action.scheduleId === undefined && action.claimFence === undefined && !principal) return;
  if (typeof action.scheduleId !== "string" || typeof action.claimFence !== "string")
    throw cell.cellCodedError("invalid_command", "Scheduled dossier synthesis requires a schedule id and claim fence.");
  const schedule = cell.projection.getEntity("schedule", action.scheduleId)?.value as ScheduleV1 | undefined;
  const active = scheduleClaimForSource(schedule, action.claimFence, binding.source);
  if (!active || (principal && (principal.taskId !== null || active.runtimeSessionId !== principal.runtimeSessionId)))
    throw cell.cellCodedError(
      "schedule_claim_stale",
      "The authenticated writer does not hold this Schedule occurrence.",
    );
}

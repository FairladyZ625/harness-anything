import { createHash } from "node:crypto";
import {
  compileEntityPinEvent,
  parseEntityRef,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveAgendaPinLimit } from "./task-wip-settings.ts";

export function runEntityPinAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const entityRef =
      typeof action.entityRef === "string"
        ? action.entityRef
        : `task/${cell.requiredCellText(action.taskId, "taskId")}`,
    parsed = parseEntityRef(entityRef);
  if (parsed === null || parsed.externalHarness)
    throw cell.cellCodedError("invalid_field", `${entityRef} is not a local EntityRef.`);
  const exists =
    parsed.kind === "schedule"
      ? cell.projection.listEntities("schedule").some((row) => row.id === parsed.id)
      : cell.projection.readEntityVersionWitness(entityRef).currentVersion !== null;
  if (!exists) throw cell.cellCodedError("entity_not_found", `Entity ${entityRef} does not exist.`);
  const pinned = action.kind === "entity-pin",
    pinnedEntities = cell.projection.listPinnedEntities(),
    current = pinnedEntities.some((row) => row.entityRef === entityRef),
    revision = cell.store.readHead()?.revision ?? 0,
    opId = cell.operationId(action, binding, cell.input.repoId, revision);
  if (current === pinned)
    return { outcome: "no_changes", opId, revision, evidence: JSON.stringify({ entityRef, pinned }) };
  const capacity = resolveAgendaPinLimit(cell.rootDir);
  if (pinned && pinnedEntities.length >= capacity.limit)
    throw cell.cellCodedError(
      "pin_capacity_exceeded",
      `Agenda pin capacity is ${pinnedEntities.length}/${capacity.limit} (${capacity.label}); ` +
        "unpin an existing entity before pinning another.",
    );
  const compiled = compileEntityPinEvent({
      entityRef,
      pinned,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: revision + 1,
      actor: binding.actor,
      source: binding.source,
      occurredAt: cell.now(),
    }),
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  const applied = cell.projection.readOperation(opId),
    canonicalVisible = applied !== null && applied.watermark >= appended.revision;
  const base = {
    opId,
    revision: appended.revision,
    evidence: JSON.stringify({ entityRef, pinned }),
    visibility: "center" as const,
    proof: {
      committedRevision: appended.revision,
      appliedCut: applied?.watermark ?? 0,
      durable: true,
      canonicalVisible,
      worktreeVisible: null,
    },
    ...publication,
    summary: compiled.event.type,
  };
  const used = pinned ? pinnedEntities.length + 1 : pinnedEntities.length - 1,
    guidance =
      pinned && used / capacity.limit >= 0.8
        ? [{ kind: "pin-agenda" as const, args: { used, limit: capacity.limit } }]
        : undefined;
  return canonicalVisible
    ? { outcome: "applied", ...base, ...(guidance ? { guidance } : {}) }
    : { outcome: "pending", ...base, ...(guidance ? { guidance } : {}) };
}

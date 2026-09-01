import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  attributeEntityActionCriterion,
  isPeopleEvent,
  personActionCriterionRef,
  personActionIds,
  personActionUsage,
  resolveHarnessLayout,
  type CompiledPeopleRosterAction,
  type EntityActionCompileInput,
  type PersonActionId,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import {
  peopleAddJsonAllowedFields,
  peopleAddJsonFields,
  peopleBindJsonAllowedFields,
  peopleBindJsonFields,
  peopleDelegateJsonAllowedFields,
  peopleDelegateJsonFields,
  peopleRemoveJsonAllowedFields,
  peopleRemoveJsonFields,
  peopleRevokeDelegationJsonAllowedFields,
  peopleRevokeDelegationJsonFields,
  peopleSetRoleJsonAllowedFields,
  peopleSetRoleJsonFields,
} from "./protocol/daemon-protocol-commands-people.ts";
import type { RepoCellRuntimeContext } from "./repo-cell-action-context.ts";
import { resolvePacketAction, type PacketActionContract } from "./repo-cell-action-parse.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

const peopleEffect = "people-event/people_changed";

export function makePersonActionRuntime(cell: RepoCellRuntimeContext): EntityActionCatalogRunner {
  return async (contract, rawAction, binding, catalogOpId): Promise<WriteReceipt> => {
    const action = resolvePersonAction(cell.rootDir, contract, rawAction),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = personOperationId(cell, action, binding, revision, catalogOpId),
      existing = cell.store.readEvent(opId);
    if (binding.authorizationDecision?.outcome !== "allowed")
      throw cell.cellCodedError("actor_unauthorized", "Person Action execution requires AuthorizationPort approval.");
    if (existing) {
      if (!isPeopleEvent(existing))
        throw cell.cellCodedError("revision_conflict", `Operation ${opId} belongs to a non-People event.`);
      return replayReceipt(cell.receiptForOperation(opId, binding), existing.payload.targetPersonId);
    }
    const peoplePath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "people.yaml"),
      currentBody = existsSync(peoplePath) ? readFileSync(peoplePath, "utf8") : null,
      compile = contract.execution.compile;
    if (!compile) throw cell.cellCodedError("invalid_command", `${action.kind} has no Person event compiler.`);
    const compiled = compile({
      action,
      actor: binding.actor,
      source: binding.source,
      session: resolveWriteSessionIdentity(binding, cell.projection),
      opId,
      occurredAt: cell.now(),
      workspaceRevision: revision + 1,
      entityRevision: revision,
      ...(currentBody === null ? {} : { currentDocumentBody: currentBody }),
    } satisfies EntityActionCompileInput);
    if (compiled.kind !== "person")
      throw cell.cellCodedError("invalid_store", `${action.kind} compiled a non-Person action draft.`);
    return publishPersonDraft(cell, opId, compiled.result.compiled);
  };
}

function publishPersonDraft(
  cell: RepoCellRuntimeContext,
  opId: string,
  compiled: CompiledPeopleRosterAction,
): WriteReceipt {
  if (compiled.bundle === null) {
    const revision = cell.store.readHead()?.revision ?? 0;
    return {
      outcome: "no_changes",
      opId,
      revision,
      evidence: JSON.stringify({ schema: "person-action/v1", action: compiled.action, roster: compiled.roster }),
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
      personId: compiled.targetPersonId,
      effects: [],
      updatedProjection: null,
      summary: compiled.summary,
    } as WriteReceipt;
  }
  const appended = cell.store.append(compiled.bundle),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.bundle.event, compiled.bundle.plan);
  const applied = cell.projection.readOperation(compiled.bundle.event.opId),
    canonicalVisible = applied !== null && applied.watermark >= appended.revision,
    personId = compiled.targetPersonId,
    receipt = {
      opId: compiled.bundle.event.opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        schema: "person-action/v1",
        action: compiled.action,
        roster: compiled.roster,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible: true,
      },
      ...publication,
      personId,
      effects: [peopleEffect],
      updatedProjection:
        personId === null ? null : { kind: "person", ref: `person/${personId}`, revision: appended.revision },
      summary: compiled.summary,
    };
  return canonicalVisible
    ? ({ outcome: "applied", ...receipt } as WriteReceipt)
    : ({
        outcome: "pending",
        ...receipt,
        nextAction: `Run ha receipt show ${compiled.bundle.event.opId} before retrying.`,
      } as WriteReceipt);
}

function replayReceipt(receipt: WriteReceipt, personId: string | null): WriteReceipt {
  return {
    ...receipt,
    personId,
    effects: [peopleEffect],
    updatedProjection:
      personId === null ? null : { kind: "person", ref: `person/${personId}`, revision: receipt.revision ?? null },
  } as WriteReceipt;
}

const peoplePacketContracts: Readonly<Record<string, PacketActionContract>> = Object.freeze({
  "people-add": peopleContract(peopleAddJsonFields, peopleAddJsonAllowedFields),
  "people-set-role": peopleContract(peopleSetRoleJsonFields, peopleSetRoleJsonAllowedFields),
  "people-bind": peopleContract(peopleBindJsonFields, peopleBindJsonAllowedFields),
  "people-delegate": peopleContract(peopleDelegateJsonFields, peopleDelegateJsonAllowedFields),
  "people-revoke-delegation": peopleContract(peopleRevokeDelegationJsonFields, peopleRevokeDelegationJsonAllowedFields),
  "people-remove": peopleContract(peopleRemoveJsonFields, peopleRemoveJsonAllowedFields),
});

function resolvePersonAction(
  rootDir: string,
  contract: Parameters<EntityActionCatalogRunner>[0],
  action: RepoTaskAction,
): RepoTaskAction {
  const packet = peoplePacketContracts[action.kind];
  if (!packet) throw invalidPersonCommand(`Unknown people action: ${action.kind}`);
  try {
    return resolvePacketAction(rootDir, action, packet);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error),
      id = personActionId(contract.id);
    throw attributeEntityActionCriterion(
      error instanceof Error ? error : invalidPersonCommand(message),
      id,
      personActionCriterionRef(id, "input"),
      [`${message} Then retry ${personActionUsage(contract)}.`],
    );
  }
}

function peoplePacketValidation(packet: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(packet)) {
    if (field === "commandClass" || field === "action") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
        throw invalidPersonCommand(`${field} must be a non-empty array of non-empty strings`);
    } else if (field === "expiresAt" && value === null) continue;
    else if (typeof value !== "string" || !value.trim())
      throw invalidPersonCommand(`${field} must be a non-empty string`);
  }
}

function peopleContract(required: readonly string[], allowed: readonly string[]): PacketActionContract {
  return {
    required,
    allowed,
    source: "from-file",
    invalid: invalidPersonCommand,
    messages: {
      parse: "People input must be one UTF-8 JSON object; repair the JSON and retry",
      object: "People input must be one JSON object",
      unsupportedAction: (fields) => `Remove unsupported people action fields: ${fields.join(", ")}`,
      unsupportedInput: (fields) => `Remove unsupported people input fields: ${fields.join(", ")}`,
      missingInput: (fields) => `Add required people input fields: ${fields.join(", ")}`,
    },
    validate: peoplePacketValidation,
  };
}

function personOperationId(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  catalogOpId: string,
): string {
  if (typeof action.idempotencyKey === "string" && action.idempotencyKey.trim())
    return cell.operationId(action, binding, cell.input.repoId, 0);
  return Number.isSafeInteger(revision) ? cell.operationId(action, binding, cell.input.repoId, revision) : catalogOpId;
}

function personActionId(value: string): PersonActionId {
  if ((personActionIds as readonly string[]).includes(value)) return value as PersonActionId;
  throw invalidPersonCommand(`Unknown Person Action: ${value}`);
}

function invalidPersonCommand(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_command" });
}

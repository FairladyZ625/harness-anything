import { samePrincipal } from "@harness-anything/kernel";
import {
  executionDelegationPath,
  readExecutionDelegations,
  writeExecutionDelegation,
} from "./execution-delegation-store.ts";
import {
  attributeEntityActionCriterion,
  actionDeclarations,
  canonicalEventWritePlan,
  sha256Text,
  type ExecutionDelegationEventV1,
  stableStringify,
  personActionCriterionRef,
  personActionIds,
  personActionUsage,
  type EntityActionCompileInput,
  type PersonActionId,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import {
  peopleDelegateJsonAllowedFields,
  peopleDelegateJsonFields,
  peopleRevokeDelegationJsonAllowedFields,
  peopleRevokeDelegationJsonFields,
} from "./protocol/daemon-protocol-commands-people.ts";
import type { RepoCellRuntimeContext } from "./repo-cell-action-context.ts";
import { resolvePacketAction, type PacketActionContract } from "./repo-cell-action-parse.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

export function makePersonActionRuntime(cell: RepoCellRuntimeContext): EntityActionCatalogRunner {
  return async (contract, rawAction, binding, catalogOpId): Promise<WriteReceipt> => {
    const action = resolvePersonAction(cell.rootDir, contract, rawAction);
    if (binding.authorizationDecision?.outcome !== "allowed")
      throw cell.cellCodedError("actor_unauthorized", "Execution delegation requires Keycloak approval.");
    const route = cell.input.runtimeDaemonRoute;
    if (!route)
      throw cell.cellCodedError(
        "delegation_store_unavailable",
        "Execution delegation requires a center private store.",
      );
    const file = executionDelegationPath(route, cell.input.repoId),
      state = readExecutionDelegations(file, cell.input.repoId),
      revision = cell.store.readHead()?.revision ?? 0,
      opId =
        typeof action.idempotencyKey === "string"
          ? `op_delegation_${sha256Text(stableStringify({ repoId: cell.input.repoId, kind: action.kind, actor: binding.actor, source: binding.source, idempotencyKey: action.idempotencyKey }))}`
          : catalogOpId,
      fingerprint = stableStringify({ action, actor: binding.actor, source: binding.source }),
      prior = state.operations[opId];
    if (prior && prior.fingerprint !== fingerprint)
      throw cell.cellCodedError("revision_conflict", "Delegation operation is already owned by another request.");
    const accepted = cell.store.readEvent(opId);
    if (!prior) {
      const compile = contract.execution.compile;
      if (!compile) throw cell.cellCodedError("invalid_command", "Missing execution delegation compiler.");
      if (action.kind === "people-delegate") {
        const session =
            typeof action.runtimeSessionId === "string"
              ? cell.projection.readRuntimeSession(action.runtimeSessionId)
              : null,
          dispatch =
            typeof action.runtimeSessionId === "string"
              ? cell.projection.readRuntimeDispatch(action.runtimeSessionId)
              : null;
        if (
          !session ||
          !dispatch ||
          !samePrincipal(dispatch.actor.principal, binding.actor.principal) ||
          stableStringify(dispatch.source) !== stableStringify(binding.source)
        )
          throw cell.cellCodedError(
            "executor_binding_invalid",
            "Delegation requires the issuer's canonical RuntimeSession and source.",
          );
      }
      const compiled = compile({
        action,
        actor: binding.actor,
        source: binding.source,
        session: resolveWriteSessionIdentity(binding, cell.projection),
        opId,
        occurredAt: cell.now(),
        workspaceRevision: revision + 1,
        currentEntity: { repoId: cell.input.repoId, records: state.records },
      } satisfies EntityActionCompileInput);
      if (compiled.kind !== "person") throw cell.cellCodedError("invalid_store", "Invalid delegation draft.");
      for (const kind of compiled.result.record.token.allowedActions)
        if (!actionDeclarations.some((declaration) => declaration.kind === kind))
          throw cell.cellCodedError("invalid_command", `Unknown delegated Action ${kind}.`);
      writeExecutionDelegation({ file, state, record: compiled.result.record, opId, fingerprint });
    }
    if (!accepted) {
      const event: ExecutionDelegationEventV1 = {
          schema: "execution-delegation-event/v1",
          type: "execution_delegation_changed",
          eventId: `event-${sha256Text(opId)}`,
          opId,
          workspaceRevision: revision + 1,
          actor: binding.actor,
          source: binding.source,
          occurredAt: cell.now(),
          payload: {
            tokenId: String(action.tokenId),
            operation: action.kind === "people-delegate" ? "issue" : "revoke",
          },
        },
        plan = canonicalEventWritePlan(event, "execution-delegation-audit", opId);
      try {
        cell.store.append({ event, plan, blobs: [] });
        cell.projection.apply(event, plan);
      } catch (error) {
        throw Object.assign(
          cell.cellCodedError(
            "publication_indeterminate",
            "Delegation private write is durable but its audit did not settle.",
          ),
          { opId, cause: error },
        );
      }
    }
    return {
      ...cell.receiptForOperation(opId, binding),
      principal: binding.actor.principal,
      effects: ["execution-delegation/changed"],
      updatedProjection: null,
      summary: `${prior ? "Replayed" : "Accepted"} ${action.kind} for ${action.tokenId}.`,
    } as WriteReceipt;
  };
}

const peoplePacketContracts: Readonly<Record<string, PacketActionContract>> = Object.freeze({
  "people-delegate": peopleContract(peopleDelegateJsonFields, peopleDelegateJsonAllowedFields),
  "people-revoke-delegation": peopleContract(peopleRevokeDelegationJsonFields, peopleRevokeDelegationJsonAllowedFields),
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
    if (field === "action") {
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

function personActionId(value: string): PersonActionId {
  if ((personActionIds as readonly string[]).includes(value)) return value as PersonActionId;
  throw invalidPersonCommand(`Unknown Person Action: ${value}`);
}

function invalidPersonCommand(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_command" });
}

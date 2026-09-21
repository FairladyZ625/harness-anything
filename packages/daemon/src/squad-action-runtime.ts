import {
  createEntityStore,
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
  type SquadDeclarationV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import {
  agentDeclarationInvalidError,
  storedAgentDeclarationOutcome,
  validateAgentEntityAction,
} from "./agent-entities.ts";
import type { RepoCellRuntimeContext } from "./repo-cell-action-context.ts";
import { cellCriterionError } from "./repo-cell-errors.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export function makeSquadActionRuntime(cell: RepoCellRuntimeContext): EntityActionCatalogRunner {
  return async (contract, action, binding, opId): Promise<WriteReceipt> => {
    const revision = cell.store.readHead()?.revision ?? 0;
    if (contract.id === "list") return cell.readResult(opId, listSquads(cell), revision, null) as WriteReceipt;
    if (contract.id === "inspect")
      return cell.readResult(opId, inspectSquad(cell, squadRequiredText(action.squadId, "squadId")), revision, null);
    if (contract.id === "validate") {
      const report = validateAgentEntityAction({
        rootDir: cell.rootDir,
        action,
        entityStore: createEntityStore(cell.store),
        runtimeInstances: cell.input.runtimeInstances?.(),
      });
      return cell.readResult(opId, report as object, revision, null);
    }
    if (contract.id === "status") {
      const raw = cell.squadCoordinator.status(squadRequiredText(action.squadRunId, "squadRunId"));
      return coordinatorReceipt(cell, raw, opId, revision, []);
    }
    throw cell.cellCodedError("invalid_store", `Squad Action ${contract.id} has no catalog runtime implementation.`);
  };
}

export function makeAgentActionRuntime(cell: RepoCellRuntimeContext): EntityActionCatalogRunner {
  return async (contract, action, _binding, opId): Promise<WriteReceipt> => {
    const revision = cell.store.readHead()?.revision ?? 0;
    if (contract.id === "list") return cell.readResult(opId, listAgents(cell), revision, null) as WriteReceipt;
    if (contract.id === "inspect")
      return cell.readResult(opId, inspectAgent(cell, squadRequiredText(action.agentId, "agentId")), revision, null);
    if (contract.id === "validate") {
      const report = validateAgentEntityAction({
        rootDir: cell.rootDir,
        action,
        runtimeInstances: cell.input.runtimeInstances?.(),
      });
      return cell.readResult(opId, report, revision, null);
    }
    throw cell.cellCodedError("invalid_store", `Agent Action ${contract.id} has no catalog runtime implementation.`);
  };
}

function listAgents(cell: RepoCellRuntimeContext): object {
  const agents = cell.projection.listEntities("agent").map(({ value, id, freshness }) => {
    if (freshness === "orphaned")
      return {
        id,
        layer: "user" as const,
        state: "missing" as const,
        error: { code: "agent_not_found" as const, hint: `${id} is not an installed agent.` },
      };
    const outcome = storedAgentDeclarationOutcome({
      agentId: id,
      read: () => parseAgentDeclarationV1(value),
    });
    if (outcome.kind !== "ok")
      return {
        id,
        layer: "user" as const,
        state: "invalid" as const,
        error: {
          code: "invalid_entity_contract" as const,
          hint: outcome.kind === "invalid" ? outcome.error.message : `${id} is not an installed agent.`,
        },
      };
    const { instructions: _instructions, ...row } = outcome.value;
    return {
      ...row,
      layer: "user" as const,
      source: `agents/${id}.json`,
    };
  });
  return { schema: "agent-list/v1", agents };
}

function inspectAgent(cell: RepoCellRuntimeContext, agentId: string): object {
  const row = cell.projection.getEntity("agent", agentId);
  if (!row)
    throw cellCriterionError(
      "agent_not_found",
      `${agentId} is not an installed agent.`,
      "inspect",
      "agent/entity-present",
      ["Run ha agent list and choose an existing Agent id."],
    );
  try {
    return { schema: "agent-inspection/v1", agent: parseAgentDeclarationV1(row.value) };
  } catch (error) {
    // An installed declaration whose stored shape the current schema rejects is a reinstall need
    // for that agent; the inspect read answers with the command, not the raw contract message.
    if ((error as { readonly code?: unknown }).code !== "invalid_entity_contract") throw error;
    throw cellCriterionError(
      "agent_declaration_invalid",
      agentDeclarationInvalidError(agentId, error).message,
      "inspect",
      "agent/declaration-schema",
      [`Rewrite harness/agents/${agentId}.json, then run ha agent install --source harness/agents/${agentId}.json.`],
    );
  }
}

type SquadListRow =
  | (Omit<SquadDeclarationV1, "roster"> & {
      readonly layer: "user";
      readonly source: string;
    })
  | {
      readonly id: string;
      readonly layer: "user";
      readonly state: "invalid";
      readonly error: { readonly code: "invalid_entity_contract"; readonly hint: string };
    };

function listSquads(cell: RepoCellRuntimeContext): {
  readonly schema: "squad-list/v1";
  readonly squads: SquadListRow[];
} {
  const squads = cell.projection.listEntities("squad").map(({ value, id }) => {
    try {
      const declaration = parseSquadDeclarationV1(value),
        { roster: _roster, ...row } = declaration;
      return {
        ...row,
        layer: "user" as const,
        source: `squads/${id}.json`,
      };
    } catch (error) {
      if ((error as { readonly code?: unknown })?.code !== "invalid_entity_contract") throw error;
      return {
        id,
        layer: "user" as const,
        state: "invalid" as const,
        error: {
          code: "invalid_entity_contract" as const,
          hint: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  return { schema: "squad-list/v1", squads };
}

function inspectSquad(cell: RepoCellRuntimeContext, squadId: string): object {
  const row = cell.projection.getEntity("squad", squadId);
  if (!row)
    throw cellCriterionError(
      "squad_not_found",
      `${squadId} is not an installed squad.`,
      "inspect",
      "squad/entity-present",
      ["Run ha squad list and choose an existing Squad id."],
    );
  const squad = parseSquadDeclarationV1(row.value),
    missing = [...new Set([squad.leader, ...squad.workers])]
      .map((agentId) => unavailableMember(cell, agentId))
      .filter((entry): entry is { readonly agentId: string; readonly hint: string } => entry !== null);
  if (missing.length)
    throw cellCriterionError(
      "squad_agent_not_found",
      `Squad ${squad.id} references unavailable agents: ${missing.map(({ agentId }) => agentId).join(", ")}.`,
      "inspect",
      "squad/member-declarations",
      missing.map(({ hint }) => `${hint}, then retry ha squad inspect ${squad.id}.`),
    );
  return { schema: "squad-inspection/v1", squad };
}

function coordinatorReceipt(
  cell: RepoCellRuntimeContext,
  raw: JsonObject,
  opId: string,
  revision: number,
  effects: readonly string[],
): WriteReceipt {
  const cut = cell.projection.readCut();
  return {
    ...raw,
    outcome: "applied",
    opId,
    revision,
    evidence: JSON.stringify(raw),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: cut.watermark,
      durable: true,
      canonicalVisible: cut.status === "ready",
      worktreeVisible: true,
    },
    effects,
    updatedProjection: null,
  } as unknown as WriteReceipt;
}

/**
 * One squad member is unavailable either because it is absent or because its stored declaration
 * fails the current schema (the declaration-rewrite window); each case names its own recovery.
 */
function unavailableMember(
  cell: RepoCellRuntimeContext,
  agentId: string,
): { readonly agentId: string; readonly hint: string } | null {
  const agent = cell.projection.getEntity("agent", agentId);
  if (agent === null) return { agentId, hint: `Install agent/${agentId}` };
  const outcome = storedAgentDeclarationOutcome({
    agentId,
    read: () => parseAgentDeclarationV1(agent.value),
  });
  if (outcome.kind === "ok") return null;
  return {
    agentId,
    hint: outcome.kind === "invalid" ? outcome.error.message : `Install agent/${agentId}`,
  };
}

function squadRequiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw Object.assign(new Error(`${field} is required.`), { code: "invalid_command" });
}

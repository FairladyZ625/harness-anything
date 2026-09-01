import {
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { runAgentEntityAction } from "./agent-entities.ts";
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
      const report = runAgentEntityAction({
        rootDir: cell.rootDir,
        action,
        runtimeInstances: cell.input.runtimeInstances?.(),
      });
      return cell.readResult(opId, report as object, revision, null);
    }
    if (contract.id === "status") {
      const raw = cell.squadCoordinator.status(squadRequiredText(action.squadRunId, "squadRunId"));
      return coordinatorReceipt(cell, raw, opId, revision, []);
    }
    if (contract.id === "run") {
      const raw = await cell.squadCoordinator.start(action as JsonObject, binding);
      return coordinatorReceipt(
        cell,
        raw,
        opId,
        revision,
        contract.effects.map(({ ref }) => ref),
      );
    }
    if (contract.id === "cancel") {
      const raw = await cell.squadCoordinator.cancel(squadRequiredText(action.squadRunId, "squadRunId"), binding);
      return coordinatorReceipt(
        cell,
        raw,
        opId,
        revision,
        contract.effects.map(({ ref }) => ref),
      );
    }
    throw cell.cellCodedError("invalid_store", `Squad Action ${contract.id} has no catalog runtime implementation.`);
  };
}

function listSquads(cell: RepoCellRuntimeContext): object {
  const squads = cell.projection.listEntities("squad").map(({ value, id }) => {
    const declaration = parseSquadDeclarationV1(value),
      { roster: _roster, ...row } = declaration;
    return {
      ...row,
      layer: "user",
      source: `squads/${id}.json`,
      validity: "valid",
      issues: [],
    };
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
    missing = [...new Set([squad.leader, ...squad.workers])].filter((agentId) => {
      const agent = cell.projection.getEntity("agent", agentId);
      if (!agent) return true;
      parseAgentDeclarationV1(agent.value);
      return false;
    });
  if (missing.length)
    throw cellCriterionError(
      "squad_agent_not_found",
      `Squad ${squad.id} references unavailable agents: ${missing.join(", ")}.`,
      "inspect",
      "squad/member-declarations",
      missing.map((agentId) => `Install agent/${agentId}, then retry ha squad inspect ${squad.id}.`),
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
  const cut = cell.projection.list(),
    outcome = raw.outcome === "running" ? "running" : "applied";
  return {
    ...raw,
    outcome,
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

function squadRequiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw Object.assign(new Error(`${field} is required.`), { code: "invalid_command" });
}

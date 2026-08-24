import type { AgentDeclarationV1, SquadDeclarationV1 } from "../../../daemon/src/agent-entities.contract.ts";
import type {
  AgentEntityGuiDetail as AgentEntityDetail,
  AgentEntityGuiRead as AgentEntityRead,
  AgentEntityGuiRow as AgentEntityRow,
  AgentSkillGuiRead,
  SquadEntityGuiDetail as SquadEntityDetail,
  SquadEntityGuiRow as SquadEntityRow,
} from "../../../daemon/src/agent-entities.ts";
import { containsSecretLikeKey, entityRecord } from "../api/entity-payload-hygiene.ts";
export type { AgentEntityDetail, AgentEntityRead, AgentEntityRow, SquadEntityDetail, SquadEntityRow };
export type AgentSkillRow = AgentSkillGuiRead["skills"][number];
export type EntitySaveResult = {
  readonly outcome: "applied" | "pending" | "op_rejected";
  readonly opId?: string;
  readonly error?: { readonly code?: string; readonly hint?: string };
};

// Renderer client for the Agent/Squad identity layers. The renderer never
// sees only the closed declaration projection plus the absolute skill paths needed
// for explicit prompt injection; it never sees skill bodies or anything secret-shaped.
// This client rejects credential-shaped payloads before any component renders them.
type Bridge = {
  readonly listAgents: (payload: { readonly repoId: string }) => Promise<unknown>;
  readonly showAgent: (payload: { readonly repoId: string; readonly agentId: string }) => Promise<unknown>;
  readonly listAgentSkills: (payload: { readonly repoId: string }) => Promise<unknown>;
  readonly listSquads: (payload: { readonly repoId: string }) => Promise<unknown>;
  readonly showSquad: (payload: { readonly repoId: string; readonly squadId: string }) => Promise<unknown>;
  readonly saveAgent: (payload: {
    readonly repoId: string;
    readonly declaration: AgentDeclarationV1;
  }) => Promise<unknown>;
  readonly saveSquad: (payload: {
    readonly repoId: string;
    readonly declaration: SquadDeclarationV1;
  }) => Promise<unknown>;
};
const bridge = (): Bridge => {
  const value = window.harness as unknown as Partial<Bridge> | undefined,
    required = [
      "listAgents",
      "showAgent",
      "listAgentSkills",
      "listSquads",
      "showSquad",
      "saveAgent",
      "saveSquad",
    ] as const;
  if (!value || required.some((method) => typeof value[method] !== "function"))
    throw new Error("Agent entity bridge is unavailable.");
  return value as Bridge;
};
export const agentEntityClient = {
  listAgents: async (repoId: string): Promise<readonly AgentEntityRow[]> =>
    catalog(await bridge().listAgents({ repoId }), "agent-entity-catalog/v1", "agents") as readonly AgentEntityRow[],
  listAgentSkills: async (repoId: string): Promise<readonly AgentSkillRow[]> =>
    catalog(await bridge().listAgentSkills({ repoId }), "agent-skill-catalog/v1", "skills") as readonly AgentSkillRow[],
  listSquads: async (repoId: string): Promise<readonly SquadEntityRow[]> =>
    catalog(await bridge().listSquads({ repoId }), "squad-entity-catalog/v1", "squads") as readonly SquadEntityRow[],
  showAgent: async (repoId: string, agentId: string): Promise<AgentEntityDetail> =>
    detail(await bridge().showAgent({ repoId, agentId }), "agent-entity-detail/v1", "agent") as AgentEntityDetail,
  showSquad: async (repoId: string, squadId: string): Promise<SquadEntityDetail> =>
    detail(await bridge().showSquad({ repoId, squadId }), "squad-entity-detail/v1", "squad") as SquadEntityDetail,
  saveAgent: async (repoId: string, declaration: AgentDeclarationV1): Promise<EntitySaveResult> =>
    save(await bridge().saveAgent({ repoId, declaration })),
  saveSquad: async (repoId: string, declaration: SquadDeclarationV1): Promise<EntitySaveResult> =>
    save(await bridge().saveSquad({ repoId, declaration })),
};
function catalog(value: unknown, schema: string, field: string): readonly unknown[] {
  const row = entityRecord(value);
  if (row.schema !== schema || row.ok !== true || !Array.isArray(row[field]))
    throw new Error(hint(row, "Agent entity catalog read returned an invalid payload."));
  for (const entry of row[field])
    if (containsSecretLikeKey(entry))
      throw new Error("Agent entity catalog contains a forbidden credential-shaped key.");
  return row[field];
}
function detail(value: unknown, schema: string, field: string): unknown {
  const row = entityRecord(value);
  if (row.schema !== schema || row.ok !== true || !entityRecord(row[field]).id)
    throw new Error(hint(row, "Agent entity detail read returned an invalid payload."));
  if (containsSecretLikeKey(row)) throw new Error("Agent entity detail contains a forbidden credential-shaped key.");
  return row[field];
}
function save(value: unknown): EntitySaveResult {
  const row = entityRecord(value),
    outcome = row.outcome;
  if (containsSecretLikeKey(row)) throw new Error("Agent entity save returned a forbidden credential-shaped key.");
  if (!["applied", "pending", "op_rejected"].includes(String(outcome)))
    throw new Error(hint(row, "Agent entity save returned an invalid receipt."));
  const error = entityRecord(row.error);
  return {
    outcome: outcome as EntitySaveResult["outcome"],
    ...(typeof row.opId === "string" ? { opId: row.opId } : {}),
    ...(Object.keys(error).length
      ? {
          error: {
            ...(typeof error.code === "string" ? { code: error.code } : {}),
            ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
          },
        }
      : {}),
  };
}
function hint(value: Record<string, unknown>, fallback: string): string {
  const error = entityRecord(value.error);
  return typeof error.hint === "string" && error.hint ? error.hint : fallback;
}

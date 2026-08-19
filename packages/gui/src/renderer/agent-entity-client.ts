import type { AgentEntityGuiDetail as AgentEntityDetail, AgentEntityGuiRead as AgentEntityRead, AgentEntityGuiRow as AgentEntityRow, SquadEntityGuiDetail as SquadEntityDetail, SquadEntityGuiRow as SquadEntityRow } from "../../../daemon/src/agent-entities.ts";
import { containsSecretLikeKey, entityRecord } from "../api/entity-payload-hygiene.ts";
export type { AgentEntityDetail, AgentEntityRead, AgentEntityRow, SquadEntityDetail, SquadEntityRow };

// Read-only renderer client for the Agent/Squad identity layers. The renderer never
// sees declaration files, host paths, or anything secret-shaped: the main process
// projects closed rows and this client rejects payloads that carry credential-shaped
// keys before any component renders them.
type Bridge = { readonly listAgents: (payload: { readonly repoId: string }) => Promise<unknown>; readonly showAgent: (payload: { readonly repoId: string; readonly agentId: string }) => Promise<unknown>; readonly listSquads: (payload: { readonly repoId: string }) => Promise<unknown>; readonly showSquad: (payload: { readonly repoId: string; readonly squadId: string }) => Promise<unknown> };
const bridge = (): Bridge => { const value = window.harness as unknown as Partial<Bridge> | undefined, required = ["listAgents", "showAgent", "listSquads", "showSquad"] as const; if (!value || required.some((method) => typeof value[method] !== "function")) throw new Error("Agent entity bridge is unavailable."); return value as Bridge; };
export const agentEntityClient = {
listAgents: async (repoId: string): Promise<readonly AgentEntityRow[]> => catalog(await bridge().listAgents({ repoId }), "agent-entity-catalog/v1", "agents") as readonly AgentEntityRow[],
  listSquads: async (repoId: string): Promise<readonly SquadEntityRow[]> => catalog(await bridge().listSquads({ repoId }), "squad-entity-catalog/v1", "squads") as readonly SquadEntityRow[],
  showAgent: async (repoId: string, agentId: string): Promise<AgentEntityDetail> => detail(await bridge().showAgent({ repoId, agentId }), "agent-entity-detail/v1", "agent") as AgentEntityDetail,
  showSquad: async (repoId: string, squadId: string): Promise<SquadEntityDetail> => detail(await bridge().showSquad({ repoId, squadId }), "squad-entity-detail/v1", "squad") as SquadEntityDetail
};
function catalog(value: unknown, schema: string, field: string): readonly unknown[] { const row = entityRecord(value); if (row.schema !== schema || row.ok !== true || !Array.isArray(row[field])) throw new Error(hint(row, "Agent entity catalog read returned an invalid payload.")); for (const entry of row[field]) if (containsSecretLikeKey(entry)) throw new Error("Agent entity catalog contains a forbidden credential-shaped key."); return row[field]; }
function detail(value: unknown, schema: string, field: string): unknown { const row = entityRecord(value); if (row.schema !== schema || row.ok !== true || !entityRecord(row[field]).id) throw new Error(hint(row, "Agent entity detail read returned an invalid payload.")); if (containsSecretLikeKey(row)) throw new Error("Agent entity detail contains a forbidden credential-shaped key."); return row[field]; }
function hint(value: Record<string, unknown>, fallback: string): string { const error = entityRecord(value.error); return typeof error.hint === "string" && error.hint ? error.hint : fallback; }

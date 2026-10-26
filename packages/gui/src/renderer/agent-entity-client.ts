import type { AgentDeclarationV1, SquadDeclarationV1 } from "@harness-anything/daemon/protocol";
import type {
  AgentDiffField,
  AgentEntityGuiDetail as AgentEntityDetail,
  AgentEntityGuiAvailableRow as AgentEntityAvailableRow,
  AgentEntityGuiRead as AgentEntityRead,
  AgentEntityGuiRow as AgentEntityRow,
  AgentHistoryRead,
  AgentHistoryVersion,
  AgentSkillGuiRead,
  AgentVersionRead,
  SquadEntityGuiDetail as SquadEntityDetail,
  SquadEntityGuiAvailableRow as SquadEntityAvailableRow,
  SquadEntityGuiRow as SquadEntityRow,
} from "@harness-anything/daemon/protocol";
import { containsSecretLikeKey, entityRecord } from "../api/entity-payload-hygiene.ts";
import { rendererErrorHint } from "./result-validation.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { invoke } from "./api-client-invoke.ts";
export type {
  AgentDiffField,
  AgentEntityAvailableRow,
  AgentEntityDetail,
  AgentEntityRead,
  AgentEntityRow,
  AgentHistoryRead,
  AgentHistoryVersion,
  AgentVersionRead,
  SquadEntityAvailableRow,
  SquadEntityDetail,
  SquadEntityRow,
};
export const isAvailableAgentEntityRow = (row: AgentEntityRow): row is AgentEntityAvailableRow => !("state" in row);
export const isAvailableSquadEntityRow = (row: SquadEntityRow): row is SquadEntityAvailableRow => !("state" in row);
export type AgentSkillRow = AgentSkillGuiRead["skills"][number];
export type EntitySaveResult = {
  readonly outcome: "applied" | "pending" | "op_rejected";
  readonly opId?: string;
  readonly revision?: number;
  readonly proof?: {
    readonly durable?: boolean;
    readonly canonicalVisible?: boolean;
    readonly worktreeVisible?: boolean | null;
  };
  readonly nextAction?: string;
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
  readonly readAgentHistory: (payload: {
    readonly repoId: string;
    readonly agentId: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly noSummary?: boolean;
  }) => Promise<unknown>;
  readonly readAgentVersion: (payload: {
    readonly repoId: string;
    readonly agentId: string;
    readonly revision: number;
  }) => Promise<unknown>;
};
const bridge = (): Bridge => {
  const value = guiHostBridge() as unknown as Partial<Bridge> | undefined,
    required = [
      "listAgents",
      "showAgent",
      "listAgentSkills",
      "listSquads",
      "showSquad",
      "readAgentHistory",
      "readAgentVersion",
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
  readAgentHistory: async (
    repoId: string,
    agentId: string,
    input: { readonly limit?: number; readonly cursor?: string; readonly noSummary?: boolean } = {},
  ): Promise<AgentHistoryRead> =>
    versioned(
      await bridge().readAgentHistory({
        repoId,
        agentId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.noSummary === undefined ? {} : { noSummary: input.noSummary }),
      }),
      "agent-history/v1",
    ) as AgentHistoryRead,
  readAgentVersion: async (repoId: string, agentId: string, revision: number): Promise<AgentVersionRead> =>
    versioned(await bridge().readAgentVersion({ repoId, agentId, revision }), "agent-version/v1") as AgentVersionRead,
  // 保存带上详情里的声明 revision:daemon 的 agent-install 动作已有 expectedVersion 栅栏,
  // 这里只是把编辑者读到的那一版递过去。并发保存的后者因此得到 revision_conflict,而不是
  // 静默覆盖前者。新建没有既有 revision,显式递 0(空实体通过栅栏)。
  saveAgent: async (repoId: string, declaration: AgentDeclarationV1, expectedVersion = 0): Promise<EntitySaveResult> =>
    save(
      await invoke(
        "repo.agent.entity.write",
        { repoId, declaration, expectedVersion } as { readonly repoId: string } & object,
        "saveAgent",
      ),
    ),
  saveSquad: async (repoId: string, declaration: SquadDeclarationV1): Promise<EntitySaveResult> =>
    save(
      await invoke(
        "repo.squad.entity.write",
        { repoId, declaration } as { readonly repoId: string } & object,
        "saveSquad",
      ),
    ),
  // U/D 复用 CLI 同一条 daemon 实体动作(agent-retire / agent-delete / squad-delete);
  // 删除的 expectedVersion 是 show 结果里的声明自身 revision,调用方从 detail 拿,不由用户输入。
  retireAgent: async (
    repoId: string,
    input: { readonly agentId: string; readonly reason: string; readonly successor?: string },
  ): Promise<EntitySaveResult> =>
    save(
      await invoke(
        "repo.agent.entity.retire",
        { repoId, ...input } as { readonly repoId: string } & object,
        "retireAgent",
      ),
    ),
  deleteAgent: async (
    repoId: string,
    input: { readonly agentId: string; readonly reason: string; readonly expectedVersion: number },
  ): Promise<EntitySaveResult> =>
    save(
      await invoke(
        "repo.agent.entity.delete",
        { repoId, ...input } as { readonly repoId: string } & object,
        "deleteAgent",
      ),
    ),
  deleteSquad: async (
    repoId: string,
    input: { readonly squadId: string; readonly reason: string; readonly expectedVersion: number },
  ): Promise<EntitySaveResult> =>
    save(
      await invoke(
        "repo.squad.entity.delete",
        { repoId, ...input } as { readonly repoId: string } & object,
        "deleteSquad",
      ),
    ),
};
function catalog(value: unknown, schema: string, field: string): readonly unknown[] {
  const row = entityRecord(value);
  if (row.schema !== schema || row.ok !== true || !Array.isArray(row[field]))
    throw new Error(rendererErrorHint(row, "Agent entity catalog read returned an invalid payload."));
  for (const entry of row[field])
    if (containsSecretLikeKey(entry))
      throw new Error("Agent entity catalog contains a forbidden credential-shaped key.");
  return row[field];
}
function detail(value: unknown, schema: string, field: string): unknown {
  const row = entityRecord(value);
  if (row.schema !== schema || row.ok !== true || !entityRecord(row[field]).id)
    throw new Error(rendererErrorHint(row, "Agent entity detail read returned an invalid payload."));
  if (containsSecretLikeKey(row)) throw new Error("Agent entity detail contains a forbidden credential-shaped key.");
  return row[field];
}
/** Version reads carry a closed schema like every other Agent read; an unexpected shape fails closed. */
function versioned(value: unknown, schema: string): unknown {
  const row = entityRecord(value);
  if (row.schema !== schema || row.ok !== true)
    throw new Error(rendererErrorHint(row, `Agent version read returned an invalid ${schema} payload.`));
  if (containsSecretLikeKey(row)) throw new Error("Agent version read contains a forbidden credential-shaped key.");
  return row;
}
function save(value: unknown): EntitySaveResult {
  const row = entityRecord(value),
    outcome = row.outcome;
  const proof = entityRecord(row.proof);
  if (containsSecretLikeKey(row)) throw new Error("Agent entity save returned a forbidden credential-shaped key.");
  if (!["applied", "pending", "op_rejected"].includes(String(outcome)))
    throw new Error(rendererErrorHint(row, "Agent entity save returned an invalid receipt."));
  const error = entityRecord(row.error);
  return {
    outcome: outcome as EntitySaveResult["outcome"],
    ...(typeof row.opId === "string" ? { opId: row.opId } : {}),
    ...(typeof row.revision === "number" && Number.isInteger(row.revision) ? { revision: row.revision } : {}),
    ...(typeof proof.canonicalVisible === "boolean"
      ? {
          proof: {
            ...(typeof proof.durable === "boolean" ? { durable: proof.durable } : {}),
            canonicalVisible: proof.canonicalVisible,
            ...(proof.worktreeVisible === null || typeof proof.worktreeVisible === "boolean"
              ? { worktreeVisible: proof.worktreeVisible }
              : {}),
          },
        }
      : {}),
    ...(typeof row.nextAction === "string" ? { nextAction: row.nextAction } : {}),
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

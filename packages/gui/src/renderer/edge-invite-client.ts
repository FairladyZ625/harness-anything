import type {
  AccessPolicyGroup,
  EdgeJoinIssued,
  EdgeJoinStatusReply,
  EdgeJoinSummary,
} from "../api/access-admin-contract.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { isRendererRecord, rendererReadError } from "./result-validation.ts";

/** Invitation create, status, list, and revoke all use the center typed access-admin channel. */
type CreateJoinInput = {
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly personId: string;
  readonly repoIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly nodeLabel?: string;
  readonly platform?: "darwin" | "linux";
};
type AccessBridge = {
  readonly groups: () => Promise<unknown>;
  readonly issueEdgeJoin: (input: CreateJoinInput) => Promise<unknown>;
  readonly edgeJoinStatus: (input: { readonly joinId: string }) => Promise<unknown>;
  readonly edgeJoinList: () => Promise<unknown>;
  readonly revokeEdgeJoin: (input: { readonly joinId: string }) => Promise<unknown>;
};

function accessBridge(): AccessBridge {
  const bridge = guiHostBridge() as unknown as { readonly access?: AccessBridge } | undefined;
  if (!bridge?.access) throw new Error("Access admin bridge is unavailable.");
  return bridge.access;
}

export async function issueEdgeJoin(input: CreateJoinInput): Promise<EdgeJoinIssued> {
  return readIssued(await accessBridge().issueEdgeJoin(input));
}

export async function fetchEdgeJoinGroups(): Promise<{ readonly groups: readonly AccessPolicyGroup[] }> {
  const value = await accessBridge().groups();
  if (!isRendererRecord(value) || value.ok !== true || !Array.isArray(value.groups))
    throw rendererReadError(value, "Edge join permission groups returned an invalid result.");
  const groups = value.groups.map((group) => {
    if (
      !isRendererRecord(group) ||
      typeof group.id !== "string" ||
      typeof group.displayName !== "string" ||
      !Array.isArray(group.effectiveScopes) ||
      !group.effectiveScopes.every((scope) => typeof scope === "string") ||
      typeof group.version !== "string"
    )
      throw rendererReadError(group, "Edge join permission groups returned an invalid group.");
    return group as unknown as AccessPolicyGroup;
  });
  return { groups };
}

export function readIssued(value: unknown): EdgeJoinIssued {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    typeof value.joinId !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.inviteLink !== "string" ||
    !value.inviteLink.startsWith("https://")
  )
    throw rendererReadError(value, "Edge join creation returned an invalid result.");
  return {
    joinId: value.joinId,
    state: "pending",
    expiresAt: value.expiresAt,
    inviteLink: value.inviteLink,
  };
}

export async function fetchEdgeJoinStatus(joinId: string): Promise<EdgeJoinStatusReply> {
  return readJoinStatus(await accessBridge().edgeJoinStatus({ joinId }));
}

export async function fetchEdgeJoinList(): Promise<readonly EdgeJoinSummary[]> {
  const value = await accessBridge().edgeJoinList();
  if (!isRendererRecord(value) || value.ok !== true || !Array.isArray(value.joins))
    throw rendererReadError(value, "Edge join list returned an invalid result.");
  return value.joins.map(readJoinSummary);
}

export async function revokeEdgeJoin(joinId: string): Promise<EdgeJoinStatusReply> {
  return readJoinStatus(await accessBridge().revokeEdgeJoin({ joinId }));
}

export function readJoinStatus(value: unknown): EdgeJoinStatusReply {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    typeof value.joinId !== "string" ||
    !["pending", "consumed", "expired", "revoked"].includes(String(value.state)) ||
    (value.nodeId !== undefined && typeof value.nodeId !== "string")
  )
    throw rendererReadError(value, "Edge join status returned an invalid result.");
  return {
    joinId: value.joinId,
    state: value.state as EdgeJoinStatusReply["state"],
    ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
  };
}

function readJoinSummary(value: unknown): EdgeJoinSummary {
  const status = readJoinStatus({ ok: true, ...(isRendererRecord(value) ? value : {}) });
  if (
    !isRendererRecord(value) ||
    typeof value.personId !== "string" ||
    !Array.isArray(value.repoIds) ||
    !value.repoIds.every((repoId) => typeof repoId === "string") ||
    !Array.isArray(value.groupIds) ||
    !value.groupIds.every((groupId) => typeof groupId === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string"
  )
    throw rendererReadError(value, "Edge join list returned an invalid invitation.");
  return {
    ...status,
    personId: value.personId,
    repoIds: value.repoIds as string[],
    groupIds: value.groupIds as string[],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

import type { EdgeJoinIssued, EdgeJoinStatusReply } from "../api/access-admin-contract.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { isRendererRecord, rendererReadError } from "./result-validation.ts";

/**
 * 中心面板「邀请边缘节点」的 renderer 客户端:签发与状态都走 preload 的 access 通道
 * (daemon.rbac.manage 的 edge-join-create / edge-join-status),GUI 不另写签发逻辑。
 * 邀请链接是凭据:这里不缓存、不落存储,字符串只随签发回执进面板一次;
 * 后续状态只凭 joinId 查询,链接不需要在场。拒绝按 access 面同一口径折叠成带 code 的 Error。
 */

type AccessBridge = {
  readonly issueEdgeJoin: (input: {
    readonly nodeId: string;
    readonly centerUrl: string;
    readonly spkiSha256: string;
  }) => Promise<unknown>;
  readonly edgeJoinStatus: (input: { readonly inviteId: string }) => Promise<unknown>;
};

function accessBridge(): AccessBridge {
  const bridge = guiHostBridge() as unknown as { readonly access?: AccessBridge } | undefined;
  if (!bridge?.access) throw new Error("Access admin bridge is unavailable.");
  return bridge.access;
}

export async function issueEdgeJoin(input: {
  readonly nodeId: string;
  readonly centerUrl: string;
  readonly spkiSha256: string;
}): Promise<EdgeJoinIssued> {
  return readIssued(await accessBridge().issueEdgeJoin(input));
}

export function readIssued(value: unknown): EdgeJoinIssued {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    typeof value.joinId !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.inviteLink !== "string" ||
    !value.inviteLink.startsWith("harness-edge://join/")
  )
    throw rendererReadError(value, "Edge join creation returned an invalid result.");
  return {
    joinId: value.joinId,
    state: "pending",
    expiresAt: value.expiresAt,
    inviteLink: value.inviteLink,
  };
}

export async function fetchEdgeJoinStatus(inviteId: string): Promise<EdgeJoinStatusReply> {
  return readJoinStatus(await accessBridge().edgeJoinStatus({ inviteId }));
}

export function readJoinStatus(value: unknown): EdgeJoinStatusReply {
  const status = isRendererRecord(value) ? String(value.status) : "";
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    !["pending", "consumed", "expired"].includes(status) ||
    typeof value.inviteId !== "string" ||
    typeof value.personId !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.expiresAt !== "string" ||
    !(value.consumedAt === null || typeof value.consumedAt === "string")
  )
    throw rendererReadError(value, "Edge join status returned an invalid result.");
  return {
    inviteId: value.inviteId,
    status: status as EdgeJoinStatusReply["status"],
    personId: value.personId,
    nodeId: value.nodeId,
    expiresAt: value.expiresAt,
    consumedAt: value.consumedAt,
  };
}

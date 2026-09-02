import type { AdminConnectionRow } from "../../../api/connection-admin-contract.ts";
import type { SystemRepoRow } from "../../api-client.ts";

/**
 * 仓库与连接页的信息模型派生(纯函数,便于 vitest 锁行为):
 * 左树 = 本机连接(隐含)+ 各远端端点连接 + 中心占位;仓库按 connectionId 挂到连接下。
 */

export type ConnectionNodeId = "local" | "center" | `remote:${string}`;

export type TreeSelection =
  | { readonly kind: "connection"; readonly id: ConnectionNodeId }
  | { readonly kind: "repo"; readonly repoId: string };

export interface ConnectionTreeNode {
  readonly selection: TreeSelection;
  readonly connection: AdminConnectionRow | null;
  readonly nodeId: ConnectionNodeId;
  readonly repos: readonly SystemRepoRow[];
}

export function connectionNodeId(connection: AdminConnectionRow): ConnectionNodeId {
  return `remote:${connection.id}`;
}

export function buildConnectionTree(
  connections: readonly AdminConnectionRow[],
  repos: readonly SystemRepoRow[],
): readonly ConnectionTreeNode[] {
  const remote = connections.filter((connection) => connection.kind === "remote-endpoint"),
    local = connections.find((connection) => connection.kind === "local") ?? {
      id: "local",
      kind: "local",
      displayName: "This device",
      state: "enabled",
    };
  return [
    {
      selection: { kind: "connection", id: "local" },
      connection: local,
      nodeId: "local",
      repos: repos.filter((repo) => repo.connectionId === "local"),
    },
    ...remote.map((connection) => ({
      selection: { kind: "connection" as const, id: connectionNodeId(connection) },
      connection,
      nodeId: connectionNodeId(connection),
      repos: repos.filter((repo) => repo.connectionId === connection.id),
    })),
    {
      selection: { kind: "connection", id: "center" },
      connection: connections.find((connection) => connection.kind === "fleet-center") ?? null,
      nodeId: "center",
      repos: repos.filter((repo) => repo.mode === "remote-edge" || repo.mode === "remote-center"),
    },
  ];
}

/** remote-proxy 仓不可切 local:设计稿 §3.2 的固定提示,视图与动作共用同一句。 */
export function isRemoteProxy(repo: SystemRepoRow): boolean {
  return repo.mode === "remote-proxy";
}

/** local ↔ remote-edge 切换的可用判据:存在 fleet-center 连接(本轮占位,注册面未开)。 */
export function centerConnectionAvailable(connections: readonly AdminConnectionRow[]): boolean {
  return connections.some((connection) => connection.kind === "fleet-center" && connection.state === "enabled");
}

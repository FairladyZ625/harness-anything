import { ACCESS_ADMIN_CHANNEL, type AccessAdminApi, type AccessAdminRequest } from "../api/access-admin-contract.ts";

/**
 * 账号与访问控制页的 preload 面:每个方法是同一通道上的一条带类型请求,主进程收窄见
 * main/access-admin-ipc.ts。渲染进程只拿到 daemon 的答复,不接触 Keycloak 与管理凭据。
 */
export function accessAdminPreloadApi(
  invoke: (channel: string, request: AccessAdminRequest) => Promise<unknown>,
): AccessAdminApi {
  const ask = (request: AccessAdminRequest) => invoke(ACCESS_ADMIN_CHANNEL, request) as Promise<never>;
  return {
    groups: () => ask({ operation: "group-list" }),
    createGroup: (input) => ask({ operation: "group-create", ...input }),
    updateGroup: (input) => ask({ operation: "group-update", ...input }),
    deleteGroup: (input) => ask({ operation: "group-delete", ...input }),
    grants: () => ask({ operation: "grant-list" }),
    grant: (input) => ask({ operation: "grant", ...input }),
    revoke: (input) => ask({ operation: "revoke", ...input }),
    effectivePermissions: (input) => ask({ operation: "effective-permissions", ...input }),
    receipts: () => ask({ operation: "receipt-list" }),
    reconcile: (input) => ask({ operation: "receipt-reconcile", ...input }),
    sessionLifetime: () => ask({ operation: "session-lifetime" }),
    setSessionLifetime: (input) => ask({ operation: "session-lifetime-set", ...input }),
  };
}

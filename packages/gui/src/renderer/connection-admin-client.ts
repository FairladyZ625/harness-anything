import type { AdminConnectionRow, AdminReceipt, ConnectionProbeSuccess } from "../api/connection-admin-contract.ts";
import { isRendererRecord } from "./result-validation.ts";

/**
 * Settings → 仓库与连接 的 renderer 客户端(PLT-EdgeGUI-W3)。
 *
 * 一切连接/仓库 admin 都经 preload 的 connections/repoAdmin 通道直达主进程,
 * 主进程再走本机 daemon RPC;renderer 不做 endpoint 拨号,不读注册表文件。
 * 失败以 `{ok:false, error:{code,hint}}` 的 daemon 形态回来,这里折叠成
 * Error(hint) 交给 react-query,视图就地显示 —— 与 settings-data 同一口径。
 */

type ConnectionsBridge = {
  readonly status: () => Promise<unknown>;
  readonly probe: (input: { readonly endpoint: string }) => Promise<unknown>;
  readonly register: (input: Record<string, unknown>) => Promise<unknown>;
  readonly update: (input: Record<string, unknown>) => Promise<unknown>;
  readonly unregister: (input: Record<string, unknown>) => Promise<unknown>;
};
type RepoAdminBridge = {
  readonly register: (input: Record<string, unknown>) => Promise<unknown>;
  readonly update: (input: Record<string, unknown>) => Promise<unknown>;
  readonly unregister: (input: Record<string, unknown>) => Promise<unknown>;
  readonly inspectWorkspace: (input: { readonly rootDir: string }) => Promise<unknown>;
};

function connectionsBridge(): ConnectionsBridge {
  const bridge = window.harness as unknown as { readonly connections?: ConnectionsBridge } | undefined;
  if (!bridge?.connections) throw new Error("Connection admin bridge is unavailable.");
  return bridge.connections;
}

function repoAdminBridge(): RepoAdminBridge {
  const bridge = window.harness as unknown as { readonly repoAdmin?: RepoAdminBridge } | undefined;
  if (!bridge?.repoAdmin) throw new Error("Repository admin bridge is unavailable.");
  return bridge.repoAdmin;
}

const CONNECTION_KINDS = ["local", "remote-endpoint", "fleet-center"];
const isConnectionRow = (value: unknown): value is AdminConnectionRow =>
  isRendererRecord(value) &&
  typeof value.id === "string" &&
  CONNECTION_KINDS.includes(String(value.kind)) &&
  typeof value.displayName === "string" &&
  ["enabled", "disabled"].includes(String(value.state)) &&
  (value.endpoint === undefined || typeof value.endpoint === "string");

export async function fetchConnectionStatus(): Promise<readonly AdminConnectionRow[]> {
  const result = connectionsBridge().status();
  return readStatus(await result);
}

export function readStatus(value: unknown): readonly AdminConnectionRow[] {
  if (!isRendererRecord(value) || value.ok !== true || !Array.isArray(value.connections))
    throw new Error(daemonHint(value, "Connection status bridge returned an invalid result."));
  return value.connections.filter(isConnectionRow);
}

export async function probeConnection(endpoint: string): Promise<ConnectionProbeSuccess> {
  return readProbe(await connectionsBridge().probe({ endpoint }));
}

export function readProbe(value: unknown): ConnectionProbeSuccess {
  if (!isRendererRecord(value) || value.ok !== true) throw new Error(daemonHint(value, "Connection probe failed."));
  const version = isRendererRecord(value.protocolVersion) ? value.protocolVersion : null,
    build = isRendererRecord(value.build) ? value.build : null,
    repos = Array.isArray(value.repos) ? value.repos : [];
  if (
    typeof value.endpoint !== "string" ||
    !version ||
    !Number.isInteger(version.major) ||
    !Number.isInteger(version.minor) ||
    !repos.every((repo) => isRendererRecord(repo) && typeof repo.repoId === "string" && typeof repo.state === "string")
  )
    throw new Error(daemonHint(value, "Connection probe bridge returned an invalid result."));
  return {
    ok: true,
    endpoint: value.endpoint,
    protocolVersion: {
      major: typeof version.major === "number" ? version.major : 0,
      minor: typeof version.minor === "number" ? version.minor : 0,
    },
    build: { commit: typeof build?.commit === "string" ? build.commit : null },
    repos: repos.flatMap((repo) => {
      const row = repo as { readonly repoId: string; readonly mode?: unknown; readonly state: string };
      return [
        {
          repoId: row.repoId,
          mode: typeof row.mode === "string" ? (row.mode as ConnectionProbeSuccess["repos"][number]["mode"]) : null,
          state: row.state,
        },
      ];
    }),
  };
}

export async function registerConnection(input: {
  readonly connectionId?: string;
  readonly displayName?: string;
  readonly endpoint: string;
}): Promise<AdminReceipt> {
  return readReceipt(await connectionsBridge().register(input as Record<string, unknown>), "Connection register");
}

export async function updateConnection(input: {
  readonly connectionId: string;
  readonly displayName?: string;
  readonly endpoint?: string;
  readonly state?: "enabled" | "disabled";
}): Promise<AdminReceipt> {
  return readReceipt(await connectionsBridge().update(input as Record<string, unknown>), "Connection update");
}

export async function unregisterConnection(connectionId: string): Promise<AdminReceipt> {
  return readReceipt(await connectionsBridge().unregister({ connectionId }), "Connection unregister");
}

export async function registerRepo(input: {
  readonly repoId?: string;
  readonly rootDir?: string;
  readonly displayName?: string;
  readonly mode?: string;
  readonly endpoint?: string;
  readonly connectionId?: string;
}): Promise<AdminReceipt> {
  return readReceipt(await repoAdminBridge().register(input as Record<string, unknown>), "Repo register");
}

export async function updateRepo(input: {
  readonly repoId: string;
  readonly displayName?: string;
  readonly mode?: string;
  readonly endpoint?: string;
  readonly connectionId?: string;
  readonly state?: "enabled" | "disabled";
}): Promise<AdminReceipt> {
  return readReceipt(await repoAdminBridge().update(input as Record<string, unknown>), "Repo update");
}

export async function unregisterRepo(repoId: string): Promise<AdminReceipt> {
  return readReceipt(await repoAdminBridge().unregister({ repoId }), "Repo unregister");
}

export async function inspectWorkspace(
  rootDir: string,
): Promise<{ readonly hasWorkspace: boolean; readonly suggestedRepoId: string }> {
  const value = await repoAdminBridge().inspectWorkspace({ rootDir });
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    typeof value.hasWorkspace !== "boolean" ||
    typeof value.suggestedRepoId !== "string"
  )
    throw new Error(daemonHint(value, "Workspace inspect bridge returned an invalid result."));
  return { hasWorkspace: value.hasWorkspace, suggestedRepoId: value.suggestedRepoId };
}

function readReceipt(value: unknown, label: string): AdminReceipt {
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.ok !== "boolean")
    throw new Error(daemonHint(value, `${label} bridge returned an invalid receipt.`));
  if (value.ok !== true) throw new Error(daemonHint(value, `${label} was rejected.`));
  return value as unknown as AdminReceipt;
}

function daemonHint(value: unknown, fallback: string): string {
  if (isRendererRecord(value) && isRendererRecord(value.error) && typeof value.error.hint === "string")
    return value.error.hint;
  return fallback;
}

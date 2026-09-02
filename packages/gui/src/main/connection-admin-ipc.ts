import { statSync } from "node:fs";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import {
  CONNECTION_PROBE_CHANNEL,
  CONNECTION_REGISTER_CHANNEL,
  CONNECTION_STATUS_CHANNEL,
  CONNECTION_UNREGISTER_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  REPO_REGISTER_CHANNEL,
  REPO_UNREGISTER_CHANNEL,
  REPO_UPDATE_CHANNEL,
  WORKSPACE_INSPECT_CHANNEL,
} from "../api/connection-admin-contract.ts";
import { consumeKnownError } from "../api/error-consumption.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

/**
 * Settings → 仓库与连接 的 admin IPC(PLT-EdgeGUI-W3)。
 *
 * 渲染进程只提闭合的意图字段;这里做字段闭合与形状校验后,把同一组参数转发给
 * 本机 daemon 的 admin RPC(`daemon.connection.*` / `daemon.repo.*`,W2 交付),
 * 不做任何本地注册表写路,也不做任何远程拨号 —— probe 由 daemon 对端点发起。
 * `inspectWorkspace` 是唯一在主进程本地完成的动作:只读检查所选文件夹是否已有台账。
 *
 * electron 不在本模块引入(node 单测要能加载);daemon 调用由 electron-main 注入。
 */

export type AdminJsonRpcRequest = (method: string, params: JsonObject) => Promise<JsonObject>;
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;

export interface ConnectionAdminServices {
  /** 经本机 daemon 的 admin RPC 通道(唯一写路;daemon 侧 closed receipt)。 */
  readonly request: AdminJsonRpcRequest;
}

export interface ConnectionAdminRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>,
  ) => void;
}

export function registerConnectionAdminIpc(
  registrar: ConnectionAdminRegistrar,
  services: ConnectionAdminServices,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  const call = (method: string, params: JsonObject) => services.request(method, params);
  registrar.handle(CONNECTION_STATUS_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    requireEmptyPayload(payload, "Connection status");
    return call("daemon.status", {});
  });
  registrar.handle(CONNECTION_PROBE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["endpoint"], "Connection probe");
    return call("daemon.connection.probe", { endpoint: requireEndpoint(record.endpoint) });
  });
  registrar.handle(CONNECTION_REGISTER_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["connectionId", "displayName", "endpoint"], "Connection register");
    return call("daemon.connection.register", {
      ...(optionalSlug(record.connectionId) ? { connectionId: record.connectionId } : {}),
      ...(optionalOneLine(record.displayName) ? { displayName: record.displayName } : {}),
      endpoint: requireEndpoint(record.endpoint),
    });
  });
  registrar.handle(CONNECTION_UPDATE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["connectionId", "displayName", "endpoint", "state"], "Connection update");
    return call("daemon.connection.update", {
      connectionId: requireSlug(record.connectionId, "connectionId"),
      ...(optionalOneLine(record.displayName) ? { displayName: record.displayName } : {}),
      ...(optionalEndpoint(record.endpoint) ? { endpoint: record.endpoint } : {}),
      ...(optionalState(record.state) ? { state: record.state } : {}),
    });
  });
  registrar.handle(CONNECTION_UNREGISTER_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["connectionId"], "Connection unregister");
    return call("daemon.connection.unregister", {
      connectionId: requireSlug(record.connectionId, "connectionId"),
    });
  });
  registrar.handle(REPO_REGISTER_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(
      payload,
      ["repoId", "rootDir", "displayName", "mode", "endpoint", "connectionId"],
      "Repo register",
    );
    return call("daemon.repo.register", {
      ...(optionalSlug(record.repoId) ? { repoId: record.repoId } : {}),
      ...(optionalRootDir(record.rootDir) ? { rootDir: record.rootDir } : {}),
      ...(optionalOneLine(record.displayName) ? { displayName: record.displayName } : {}),
      ...(optionalMode(record.mode) ? { mode: record.mode } : {}),
      ...(optionalEndpoint(record.endpoint) ? { endpoint: record.endpoint } : {}),
      ...(optionalSlug(record.connectionId) ? { connectionId: record.connectionId } : {}),
    });
  });
  registrar.handle(REPO_UPDATE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(
      payload,
      ["repoId", "displayName", "mode", "endpoint", "connectionId", "state"],
      "Repo update",
    );
    return call("daemon.repo.update", {
      repoId: requireSlug(record.repoId, "repoId"),
      ...(optionalOneLine(record.displayName) ? { displayName: record.displayName } : {}),
      ...(optionalMode(record.mode) ? { mode: record.mode } : {}),
      ...(optionalEndpoint(record.endpoint) ? { endpoint: record.endpoint } : {}),
      ...(optionalSlug(record.connectionId) ? { connectionId: record.connectionId } : {}),
      ...(optionalState(record.state) ? { state: record.state } : {}),
    });
  });
  registrar.handle(REPO_UNREGISTER_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["repoId"], "Repo unregister");
    return call("daemon.repo.unregister", { repoId: requireSlug(record.repoId, "repoId") });
  });
  registrar.handle(WORKSPACE_INSPECT_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = closedRecord(payload, ["rootDir"], "Workspace inspect");
    const rootDir = requireRootDir(record.rootDir);
    let hasWorkspace: boolean;
    try {
      hasWorkspace = statSync(path.join(rootDir, ".harness")).isDirectory();
    } catch (cause) {
      // 目录不存在/不可读都归到同一条「无台账」判定;能否注册由 daemon 决定。
      consumeKnownError(cause);
      hasWorkspace = false;
    }
    return {
      ok: true,
      rootDir,
      hasWorkspace,
      suggestedRepoId: suggestedRepoId(path.basename(rootDir)),
    };
  });
}

/** 与 daemon 端 safeRepoId 同一口径的显示建议;真值由 daemon normalize 决定。 */
export function suggestedRepoId(folderName: string): string {
  const sanitized = folderName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const prefixed = /^[a-z]/u.test(sanitized) ? sanitized : `repo-${sanitized}`;
  return prefixed.slice(0, 63).replace(/-+$/gu, "") || "repo";
}

function requireEmptyPayload(payload: unknown, label: string): void {
  if (payload !== null && payload !== undefined) throw new Error(`${label} does not accept a payload.`);
}

function closedRecord(payload: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error(`${label} requires an object payload.`);
  const record = payload as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !fields.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} does not accept field ${unexpected}.`);
  return record;
}

const SLUG = /^[a-z][a-z0-9-]{0,62}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function requireSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !SLUG.test(value)) throw new Error(`${field} must be a lowercase slug.`);
  return value;
}

function optionalSlug(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== "string" || !SLUG.test(value)) throw new Error("field must be a lowercase slug.");
  return true;
}

function requireEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || CONTROL_CHARACTERS.test(value))
    throw new Error("endpoint must be a tcp://host:port or absolute socket path string.");
  return value;
}

function optionalEndpoint(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.trim().length === 0 || CONTROL_CHARACTERS.test(value))
    throw new Error("endpoint must be a tcp://host:port or absolute socket path string.");
  return true;
}

function optionalState(value: unknown): value is "enabled" | "disabled" {
  if (value === undefined) return true;
  if (value !== "enabled" && value !== "disabled") throw new Error("state must be enabled or disabled.");
  return true;
}

const REPO_MODES = ["local", "remote-proxy", "remote-center", "remote-edge"] as const;
function optionalMode(value: unknown): value is (typeof REPO_MODES)[number] {
  if (value === undefined) return true;
  if (typeof value !== "string" || !(REPO_MODES as readonly string[]).includes(value))
    throw new Error("mode must be local, remote-proxy, remote-center, or remote-edge.");
  return true;
}

function requireRootDir(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || CONTROL_CHARACTERS.test(value))
    throw new Error("Workspace inspect requires an absolute repository path.");
  return value;
}

function optionalRootDir(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== "string" || !path.isAbsolute(value) || CONTROL_CHARACTERS.test(value))
    throw new Error("rootDir must be an absolute repository path.");
  return true;
}

function optionalOneLine(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/u.test(value))
    throw new Error("displayName must be one non-empty line.");
  return true;
}

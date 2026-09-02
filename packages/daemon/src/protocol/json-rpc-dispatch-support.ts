import type { DaemonRequestLogEntry } from "../request-log.ts";
import {
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  isDaemonStreamMethod,
  type DaemonGuiActionMethod,
  type DaemonGuiRpcReadMethod,
  type DaemonRpcCall,
  type DaemonRpcMethod,
  type DaemonStreamMethod,
} from "./daemon-protocol.contract.ts";
import { isJsonObject, type JsonObject, type JsonRpcId, type JsonRpcResponse } from "./json-rpc-types.ts";

type DaemonRpcCallFor<Method extends DaemonRpcMethod> = Extract<DaemonRpcCall, { readonly method: Method }>;
type RuntimeInstanceMethod = Extract<DaemonRpcMethod, `daemon.runtimeInstance.${string}`>;
type RuntimeInstanceAuthMethod = Extract<DaemonRpcMethod, `repo.runtimeInstance.auth.${string}`>;
type RepoGuiReadMethod = Exclude<DaemonGuiRpcReadMethod, "daemon.gui.system.read" | "daemon.gui.control.receipt">;
type TerminalActionMethod = "repo.gui.catalog.reread" | Extract<DaemonGuiActionMethod, `repo.terminal.${string}`>;
type WithRepoPayload<Call> = Call extends {
  readonly params: {
    readonly repo: { readonly repoId: string };
    readonly payload: JsonObject;
  };
}
  ? Call
  : never;
export type DaemonRepoPayloadCall = WithRepoPayload<DaemonRpcCall>;

export function isRuntimeInstanceCall(call: DaemonRpcCall): call is DaemonRpcCallFor<RuntimeInstanceMethod> {
  return call.method.startsWith("daemon.runtimeInstance.");
}
export function isRuntimeInstanceAuthCall(call: DaemonRpcCall): call is DaemonRpcCallFor<RuntimeInstanceAuthMethod> {
  return call.method.startsWith("repo.runtimeInstance.auth.");
}
export function isDaemonStreamCall(call: DaemonRpcCall): call is DaemonRpcCallFor<DaemonStreamMethod> {
  return isDaemonStreamMethod(call.method);
}
export function isRepoGuiReadCall(call: DaemonRpcCall): call is DaemonRpcCallFor<RepoGuiReadMethod> {
  return (
    isDaemonGuiReadMethod(call.method) &&
    call.method !== "daemon.gui.system.read" &&
    call.method !== "daemon.gui.control.receipt"
  );
}
export function isTerminalActionCall(call: DaemonRpcCall): call is DaemonRpcCallFor<TerminalActionMethod> {
  return (
    call.method === "repo.gui.catalog.reread" ||
    (isDaemonGuiActionMethod(call.method) && call.method.startsWith("repo.terminal."))
  );
}
export function repoIdFromParams(params: JsonObject): string {
  const repo = params.repo;
  return isJsonObject(repo) && typeof repo.repoId === "string" ? repo.repoId : "";
}
// The executor rides on the resolved action, which is where the daemon reads it for attribution:
// Task action methods carry it inside payload.action; every other method merges payload into the action.
export function declaredExecutorOrNull(action: JsonObject): DaemonRequestLogEntry["executor"] {
  const executor = action.executor;
  return isJsonObject(executor) && executor.kind === "agent" && typeof executor.id === "string"
    ? { kind: "agent", id: executor.id }
    : null;
}
export function resultOk(result: object): boolean {
  return "ok" in result && result.ok === true;
}
export function resultErrorCode(result: object): string | null {
  if ("code" in result && typeof result.code === "string") return result.code;
  const error = "error" in result ? result.error : undefined;
  return isJsonObject(error) && typeof error.code === "string" ? error.code : null;
}
export function resultErrorDetail(result: object): string | null {
  if (resultOk(result)) return null;
  const diagnostic = "diagnostic" in result ? result.diagnostic : undefined,
    detail =
      (isJsonObject(diagnostic) ? JSON.stringify(diagnostic) : null) ??
      ("evidence" in result && typeof result.evidence === "string" ? result.evidence : null);
  return detail?.slice(0, 500) ?? "Unknown request failure.";
}
export function rpcError(id: JsonRpcId, errorCode: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: errorCode, message } };
}
export function rpcServerErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "bootstrap_failed";
}

type ProtocolDispatchError =
  | { readonly _tag: "NativeError"; readonly message: string }
  | { readonly _tag: "UnknownThrownValue"; readonly message: string };

export function protocolErrorMessage(error: unknown): string {
  let normalized: ProtocolDispatchError;
  if (error instanceof Error) normalized = { _tag: "NativeError", message: error.message };
  else normalized = { _tag: "UnknownThrownValue", message: String(error) };
  switch (normalized._tag) {
    case "NativeError":
    case "UnknownThrownValue":
      return normalized.message;
  }
}

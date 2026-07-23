import { isDaemonLogContractError, type DaemonLogService } from "@harness-anything/application";
import type { DaemonRepoNamespace, JsonRpcServerOptions } from "./json-rpc-server.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";
import { resolveServicesForRepo } from "./repo-service-resolution.ts";
import { failureReceipt, successReceipt } from "./receipt-envelope.ts";
import {
  isJsonObject,
  type JsonObject,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./json-rpc-types.ts";
import {
  serializeDaemonRequestPerformanceSummary,
  setCurrentDaemonRequestPerformanceTerminalSink,
  type DaemonRequestPerformanceSummary
} from "../observability/request-performance.ts";

export function isRepoDiagnosticMethod(contract: JsonRpcMethodContract): boolean {
  return contract.method === "repo.daemon.status"
    || contract.method === "repo.daemon.logs.list"
    || contract.mode === "notification";
}

export async function callDaemonLogList(
  service: DaemonLogService | undefined,
  payload: JsonObject | undefined,
  repo: DaemonRepoNamespace | undefined
) {
  if (!service || !repo) {
    return failureReceipt(
      "repo.daemon.logs.list",
      "daemon_log_service_unavailable",
      "Daemon log service is not configured; run `ha daemon status --json` to verify the reachable service before retrying."
    );
  }
  try {
    const page = await service.list(payload ?? {}, { repo });
    return successReceipt("repo.daemon.logs.list", "read daemon logs", page as unknown as JsonObject);
  } catch (error) {
    if (isDaemonLogContractError(error)) return failureReceipt("repo.daemon.logs.list", error.code, error.message);
    return failureReceipt(
      "repo.daemon.logs.list",
      "daemon_log_unavailable",
      "Daemon operational logs are unavailable; run `ha daemon status --json` to verify daemon health, then retry `ha daemon logs --json`."
    );
  }
}

export async function appendDaemonLogOutcome(
  service: DaemonLogService | undefined,
  request: JsonRpcRequest,
  result: unknown,
  repo: DaemonRepoNamespace | undefined
): Promise<void> {
  if (!service || !repo || !isJsonObject(result) || result.schema !== "command-receipt/v2") return;
  const error = isJsonObject(result.error) ? result.error : undefined;
  try {
    await service.append({
      level: result.ok === false ? "error" : "info",
      source: request.method === "repo.command.run" ? "cli" : "daemon",
      component: "protocol.json-rpc",
      event: request.method,
      message: typeof result.summary === "string" ? result.summary : `completed ${request.method}`,
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      ...(typeof error?.hint === "string" ? { hint: error.hint } : {}),
      ...(request.id !== undefined && request.id !== null ? { requestId: String(request.id) } : {})
    }, { repo });
  } catch {
    // Operational logging must not change the command receipt outcome.
  }
}

export function daemonLoggedResponse(
  service: DaemonLogService | undefined,
  request: JsonRpcRequest,
  repo: DaemonRepoNamespace | undefined
): (result: unknown) => Promise<JsonRpcResponse | undefined> {
  return async (result) => {
    void appendDaemonLogOutcome(service, request, result, repo);
    return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id ?? null, result };
  };
}

export async function appendDaemonRequestPerformance(
  service: DaemonLogService | undefined,
  summary: DaemonRequestPerformanceSummary,
  repo: DaemonRepoNamespace | undefined
): Promise<void> {
  if (!service || !repo) return;
  try {
    await service.append({
      level: summary.outcome === "response-written" ? "debug" : "warn",
      source: summary.method === "repo.command.run" ? "cli" : "daemon",
      component: "protocol.json-rpc",
      event: "request.performance",
      message: serializeDaemonRequestPerformanceSummary(summary),
      requestId: summary.requestId
    }, { repo });
  } catch {
    // Operational telemetry must not change the command receipt outcome.
  }
}

export function bindDaemonRequestPerformanceLog(
  service: DaemonLogService | undefined,
  repo: DaemonRepoNamespace | undefined
): void {
  if (!service || !repo) return;
  setCurrentDaemonRequestPerformanceTerminalSink(
    (summary) => appendDaemonRequestPerformance(service, summary, repo)
  );
}

export function bindDaemonRequestPerformanceForRepo(
  method: string,
  repo: DaemonRepoNamespace | undefined,
  options: JsonRpcServerOptions
): DaemonLogService | undefined {
  const service = repo
    ? resolveServicesForRepo(method, repo, options)?.DaemonLogService ?? options.services.DaemonLogService
    : undefined;
  bindDaemonRequestPerformanceLog(service, repo);
  return service;
}

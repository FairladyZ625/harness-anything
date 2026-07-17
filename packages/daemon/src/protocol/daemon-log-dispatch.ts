import { isDaemonLogContractError, type DaemonLogService } from "../../../application/src/index.ts";
import type { DaemonRepoNamespace } from "./json-rpc-server.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt, successReceipt } from "./receipt-envelope.ts";
import { isJsonObject, type JsonObject, type JsonRpcRequest } from "./json-rpc-types.ts";

export function isRepoDiagnosticMethod(contract: JsonRpcMethodContract): boolean {
  return contract.method === "repo.daemon.status"
    || contract.method === "repo.daemon.logs.list"
    || contract.mode === "notification-stub";
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

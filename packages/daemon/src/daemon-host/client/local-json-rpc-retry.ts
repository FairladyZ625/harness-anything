import { actionDeclarations } from "@harness-anything/kernel/internal/domain/action-declaration.ts";
import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { runDaemonRetry } from "../daemon-retry.ts";
import { clientRetryDelay } from "../protocol/client-retry.ts";
import {
  daemonMethodPayloadFields,
  maybeCommandDescriptorForAction,
  daemonRpcByMethod,
} from "../protocol/daemon-protocol-commands.ts";
import { resultErrorCode } from "../protocol/json-rpc-dispatch-support.ts";
import { isJsonObject, type JsonObject } from "../protocol/json-rpc-types.ts";

export function declaresCanonicalRetryKey(method: string, payload: JsonObject): boolean {
  const route = daemonRpcByMethod.get(method);
  if (method === "repo.task.run") {
    const action = payload.action;
    if (!isJsonObject(action) || typeof action.kind !== "string") return false;
    const command = maybeCommandDescriptorForAction(action.kind);
    return (
      command?.method === method &&
      command.inputs.some((field) => field.name === "--idempotency-key") &&
      actionDeclarations.some(({ kind, residency }) => kind === action.kind && residency.scope === "canonical")
    );
  }
  if (!route || !("actionKind" in route) || !daemonMethodPayloadFields(method).includes("idempotencyKey")) return false;
  return actionDeclarations.some(({ kind, residency }) => kind === route.actionKind && residency.scope === "canonical");
}

const transientReceipts = new Set(["repo_warming", "repo_unavailable", "daemon_stopping", "daemon_build_draining"]);
const interruptedRequests = new Set([
  "daemon_closed",
  "daemon_unavailable",
  "daemon_response_timeout",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

export function retryLocalDaemonWrite(request: () => Promise<JsonObject>): Promise<JsonObject> {
  return runDaemonRetry({
    request,
    retryDelay(settled, attempt) {
      const transient = settled.ok
        ? settled.value.ok === false && transientReceipts.has(resultErrorCode(settled.value) ?? "")
        : isJsonObject(settled.error) &&
          typeof settled.error.code === "string" &&
          interruptedRequests.has(settled.error.code);
      return transient ? clientRetryDelay(attempt) : null;
    },
  });
}

/** A warming receipt precedes admission, so an unkeyed request can still wait for attachment. */
export function retryLocalRepoWarming(
  initial: JsonObject,
  read: () => Promise<JsonObject>,
  isWarming: (result: JsonObject) => boolean,
  onRetry: () => void,
): Promise<JsonObject> {
  const { warmingAttempts, warmingPollMs } = cliOperationalPolicy.defaultValue.daemon;
  let first = true;
  return runDaemonRetry({
    request: () => (first ? Promise.resolve(initial) : read()),
    retryDelay(settled, attempt) {
      if (!settled.ok || !isWarming(settled.value) || attempt >= warmingAttempts) return null;
      first = false;
      onRetry();
      return warmingPollMs;
    },
  });
}

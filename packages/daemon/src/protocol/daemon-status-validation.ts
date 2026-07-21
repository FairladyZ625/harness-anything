import {
  decodeDaemonStatusRequestV2,
  decodeDaemonStatusResultV2
} from "@harness-anything/application";
import type { DaemonStatusRequestV2 } from "@harness-anything/application";
import type { JsonObject } from "./json-rpc-types.ts";

import { failureReceipt } from "./receipt-envelope.ts";

/** Runtime codecs used by the JSON-RPC handler before it emits a success receipt. */
export function validateDaemonStatusRequest(params: JsonObject): DaemonStatusRequestV2 {
  return decodeDaemonStatusRequestV2(params);
}

export function validateDaemonStatusResult(status: unknown): JsonObject {
  return decodeDaemonStatusResultV2(status) as unknown as JsonObject;
}

export function daemonStatusValidationFailure(method: string, error: unknown): ReturnType<typeof failureReceipt> {
  if (error instanceof Error && "code" in error && error.code === "invalid_daemon_status_request") {
    return failureReceipt(
      method,
      "daemon_status_request_invalid",
      "Daemon status request must match daemon.status-request/v2: params.repo.repoId is required. Run `ha daemon status --json` with a registered repository."
    );
  }
  return failureReceipt(
    method,
    "daemon_status_result_invalid",
    "Daemon status service result must match daemon-status/v2 with non-negative queue counters plus service and requestedRepo fields. Run `ha daemon status --json` to inspect the producer output."
  );
}

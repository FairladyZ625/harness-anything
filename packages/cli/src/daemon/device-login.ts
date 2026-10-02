import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

/** Keycloak's pending response and interval drive polling; one deadline ends browser authorization. */
export async function awaitDeviceLogin(
  begun: JsonObject,
  request: (params: JsonObject) => Promise<JsonObject>,
  onPhase: (receipt: JsonObject) => void,
): Promise<JsonObject> {
  onPhase(begun);
  let receipt = begun,
    timer: ReturnType<typeof setTimeout>,
    intervalTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, Number(begun.expiresAt) - Date.now()));
  });
  try {
    while (receipt.pending === true) {
      const interval = new Promise<true>((resolve) => {
        intervalTimer = setTimeout(() => resolve(true), Number(receipt.interval) * 1_000);
      });
      if (!(await Promise.race([interval, deadline])))
        return {
          ok: false,
          code: "oidc_device_expired",
          command: "bootstrap",
          rejectionExplanation: "Device login expired; start login again.",
        };
      receipt = await request({ operation: "login-poll" });
      if (receipt.ok === false) return receipt;
    }
    return receipt;
  } finally {
    clearTimeout(timer!);
    clearTimeout(intervalTimer);
  }
}

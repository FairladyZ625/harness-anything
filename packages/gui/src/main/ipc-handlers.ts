import type { IpcMainInvokeEvent } from "electron";
import { assertPreloadPayload, preloadAllowlist } from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { isTrustedRendererUrl } from "./window-config.ts";

export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  ) => void;
}

export function registerHarnessIpcHandlers(registrar: HarnessIpcRegistrar, bridge: GuiServiceBridge): void {
  for (const method of preloadAllowlist) {
    registrar.handle(`harness:${method}`, async (event, payload) => {
      assertTrustedIpcSender(event);
      assertPreloadPayload(method, payload);
      return bridge.invoke(method, payload);
    });
  }
}

export function assertTrustedIpcSender(event: Pick<IpcMainInvokeEvent, "senderFrame">): true {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
    throw new Error("Rejected IPC message from untrusted renderer frame.");
  }
  return true;
}

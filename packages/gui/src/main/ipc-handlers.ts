import type { IpcMainInvokeEvent } from "electron";
import { assertPreloadPayload, preloadAllowlist } from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";

export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  ) => void;
}

export function registerHarnessIpcHandlers(registrar: HarnessIpcRegistrar, bridge: GuiServiceBridge): void {
  for (const method of preloadAllowlist) {
    registrar.handle(`harness:${method}`, async (_event, payload) => {
      assertPreloadPayload(method, payload);
      return bridge.invoke(method, payload);
    });
  }
}

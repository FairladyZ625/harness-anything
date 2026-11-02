import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { daemonGuiStreamFacets } from "@harness-anything/daemon/protocol";
import { assertPreloadPayload, preloadAllowlist } from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { assertTrustedIpcSender } from "./ipc-trust.ts";
export { assertTrustedIpcSender } from "./ipc-trust.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { registerAgentRuntimeIpc } from "./agent-runtime-ipc.ts";
export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>,
  ) => void;
  readonly on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => void;
}
export function registerHarnessIpcHandlers(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  assertUniqueHarnessIpcChannels(preloadAllowlist);
  for (const method of preloadAllowlist) {
    if (daemonGuiStreamFacets.some(({ guiBridgeMethod }) => guiBridgeMethod === method)) continue;
    registrar.handle(`harness:${method}`, async (event, payload) => {
      assertTrustedIpcSender(event, trustPolicy);
      assertPreloadPayload(method, payload);
      return bridge.invoke(method, payload);
    });
  }
  registerAgentRuntimeIpc(registrar, bridge, trustPolicy);
}
export function assertUniqueHarnessIpcChannels(methods: ReadonlyArray<string>): true {
  const channels = new Set<string>();
  for (const method of methods) {
    const channel = `harness:${method}`;
    if (channels.has(channel)) {
      throw new Error(`Duplicate Harness IPC handler channel: ${channel}`);
    }
    channels.add(channel);
  }
  return true;
}

/** Electron drops Error properties; preserve domain failures across this process boundary. */
export function withIpcDomainErrors(registrar: HarnessIpcRegistrar): HarnessIpcRegistrar {
  return {
    on: (channel, listener) => registrar.on(channel, listener),
    handle: (channel, listener) =>
      registrar.handle(channel, async (event, payload) => {
        try {
          return await listener(event, payload);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") throw error;
          return { ipcFailure: { code: error.code, message: error.message } };
        }
      }),
  };
}

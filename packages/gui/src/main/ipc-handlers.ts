import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { assertPreloadPayload, preloadAllowlist } from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { evaluateIpcSender, type IpcSenderIdentity, type IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { registerAgentRuntimeIpc } from "./agent-runtime-ipc.ts";
export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  ) => void;
  readonly on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => void;
}
export function registerHarnessIpcHandlers(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy
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
export function assertTrustedIpcSender(
  event: IpcSenderIdentity,
  trustPolicy: IpcWebContentsTrustPolicy
): true {
  const decision = evaluateIpcSender(event, trustPolicy);
  if (decision.action === "deny") {
    throw new Error(`Rejected IPC message: ${decision.reason}.`);
  }
  return true;
}

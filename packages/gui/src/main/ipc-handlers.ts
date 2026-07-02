import type { IpcMainInvokeEvent } from "electron";
import { assertPreloadPayload, preloadAllowlist } from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { evaluateIpcSender, type IpcSenderIdentity, type IpcWebContentsTrustPolicy } from "./security-policy.ts";

export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  ) => void;
}

export function registerHarnessIpcHandlers(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy
): void {
  assertUniqueHarnessIpcChannels(preloadAllowlist);
  for (const method of preloadAllowlist) {
    registrar.handle(`harness:${method}`, async (event, payload) => {
      assertTrustedIpcSender(event, trustPolicy);
      assertPreloadPayload(method, payload);
      return bridge.invoke(method, payload);
    });
  }
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

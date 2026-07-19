import type { IpcMainInvokeEvent } from "electron";
import {
  HARNESS_PROJECTION_CHANGED_CHANNEL,
  HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL,
  assertPreloadPayload,
  assertProjectionWatchPayload,
  preloadAllowlist,
  type ProjectionWatchResult,
  type RendererProjectionNotification
} from "../preload/allowlist.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { evaluateIpcSender, type IpcSenderIdentity, type IpcWebContentsTrustPolicy } from "./security-policy.ts";

export interface HarnessIpcRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  ) => void;
}

export interface HarnessProjectionNotificationSource {
  readonly watch: (
    repoId: string,
    sink: (notification: RendererProjectionNotification) => void
  ) => Promise<ProjectionWatchResult>;
}

export function registerHarnessIpcHandlers(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy,
  projectionNotifications?: HarnessProjectionNotificationSource
): void {
  assertUniqueHarnessIpcChannels(preloadAllowlist);
  for (const method of preloadAllowlist) {
    registrar.handle(`harness:${method}`, async (event, payload) => {
      assertTrustedIpcSender(event, trustPolicy);
      assertPreloadPayload(method, payload);
      return bridge.invoke(method, payload);
    });
  }
  if (projectionNotifications) {
    registrar.handle(HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL, async (event, payload) => {
      assertTrustedIpcSender(event, trustPolicy);
      assertProjectionWatchPayload(payload);
      return projectionNotifications.watch(payload.repoId, (notification) => {
        event.sender.send(HARNESS_PROJECTION_CHANGED_CHANNEL, notification);
      });
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

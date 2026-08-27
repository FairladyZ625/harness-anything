import type { IpcMainEvent } from "electron";
import {
  daemonGuiStreamFacets,
  type DaemonStreamPayloadMap,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { assertPreloadPayload } from "../preload/allowlist.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { isMainProcessRecord } from "./value-validation.ts";
export interface AgentRuntimeIpcRegistrar {
  readonly on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => void;
}
type GuiStreamMethod = (typeof daemonGuiStreamFacets)[number]["method"];
export function registerAgentRuntimeIpc(
  registrar: AgentRuntimeIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  const active = new Map<string, Promise<() => void>>();
  for (const facet of daemonGuiStreamFacets) {
    const openChannel = `harness:${facet.guiBridgeMethod}`,
      detachChannel = `${openChannel}:detach`;
    registrar.on(openChannel, (event, value) => {
      assertTrustedIpcSender(event, trustPolicy);
      const envelope = checkedEnvelope(value),
        key = `${event.sender.id}:${facet.guiBridgeMethod}:${envelope.subscriptionId}`,
        frameChannel = `${openChannel}:frame:${envelope.subscriptionId}`;
      assertPreloadPayload(facet.guiBridgeMethod, envelope.payload);
      const pending = bridge.stream(facet.guiBridgeMethod, envelope.payload, (frame) =>
        event.sender.send(frameChannel, frame),
      );
      active.set(key, pending);
      event.sender.once("destroyed", () => {
        void detach(key);
      });
      void pending.catch((error) => {
        event.sender.send(frameChannel, {
          ok: false,
          code: "daemon_stream_error",
          hint: error instanceof Error ? error.message : String(error),
        });
        active.delete(key);
      });
    });
    registrar.on(detachChannel, (event, value) => {
      assertTrustedIpcSender(event, trustPolicy);
      const subscriptionId = checkedSubscription(value);
      void detach(`${event.sender.id}:${facet.guiBridgeMethod}:${subscriptionId}`);
    });
  }
  async function detach(key: string): Promise<void> {
    const pending = active.get(key);
    if (!pending) return;
    active.delete(key);
    (await pending)();
  }
}
function checkedEnvelope(value: unknown): {
  readonly subscriptionId: string;
  readonly payload: DaemonStreamPayloadMap[GuiStreamMethod];
} {
  if (!isMainProcessRecord(value) || typeof value.subscriptionId !== "string" || !isMainProcessRecord(value.payload))
    throw new Error("Stream envelope is invalid.");
  return value as { subscriptionId: string; payload: DaemonStreamPayloadMap[GuiStreamMethod] };
}
function checkedSubscription(value: unknown): string {
  if (!isMainProcessRecord(value) || typeof value.subscriptionId !== "string")
    throw new Error("Agent runtime subscription id is required.");
  return value.subscriptionId;
}

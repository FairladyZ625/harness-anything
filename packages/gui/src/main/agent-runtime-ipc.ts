import { streamRpcDescriptor, type DaemonStreamPayloadMap } from "@harness-anything/daemon/protocol";
import type { GuiServiceBridge } from "./local-composition-root.ts";
import {
  assertRendererRpc,
  STREAM_CLOSE_CHANNEL,
  STREAM_OPEN_CHANNEL,
  streamFrameChannel,
} from "../preload/allowlist.ts";
import { assertTrustedIpcSender } from "./ipc-trust.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { isMainProcessRecord } from "./value-validation.ts";
import type { HarnessIpcRegistrar } from "./ipc-handlers.ts";

export function registerAgentRuntimeIpc(
  registrar: HarnessIpcRegistrar,
  bridge: GuiServiceBridge,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  const active = new Map<string, () => void>();
  registrar.handle(STREAM_OPEN_CHANNEL, async (event, value) => {
    assertTrustedIpcSender(event, trustPolicy);
    const id = subscriptionId(value),
      method =
        isMainProcessRecord(value) && typeof value.method === "string" ? streamRpcDescriptor(value.method) : undefined;
    if (!method || !isMainProcessRecord(value)) throw new Error("Unknown renderer stream.");
    assertRendererRpc(method.method, value.params, true);
    const key = `${event.sender.id}:${id}`;
    if (active.has(key)) throw new Error("Stream subscription already exists.");
    const controller = new AbortController();
    const detach = () => {
      controller.abort();
      active.delete(key);
      event.sender.off("destroyed", detach);
    };
    active.set(key, detach);
    event.sender.once("destroyed", detach);
    try {
      await bridge.stream(
        method.method,
        value.params as { repo: { repoId: string }; payload: DaemonStreamPayloadMap[typeof method.method] },
        (frame) => {
          if (!controller.signal.aborted) event.sender.send(streamFrameChannel(id), frame);
        },
        controller.signal,
      );
    } catch (error) {
      detach();
      throw error;
    }
  });
  registrar.handle(STREAM_CLOSE_CHANNEL, async (event, value) => {
    assertTrustedIpcSender(event, trustPolicy);
    active.get(`${event.sender.id}:${subscriptionId(value)}`)?.();
  });
}

function subscriptionId(value: unknown): string {
  if (
    !isMainProcessRecord(value) ||
    typeof value.subscriptionId !== "string" ||
    !/^renderer-[1-9][0-9]{0,15}$/u.test(value.subscriptionId)
  )
    throw new Error("A valid stream subscription id is required.");
  return value.subscriptionId;
}

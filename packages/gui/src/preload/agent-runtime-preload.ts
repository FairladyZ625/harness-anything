import {
  daemonGuiStreamFacets,
  type DaemonStreamPayloadMap,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { assertPreloadPayload } from "./allowlist.ts";
let sequence = 0;
export type TerminalPreloadStream = (
  payload: DaemonStreamPayloadMap["repo.terminal.attach"],
  onValue: (value: unknown) => void,
) => () => void;
interface RendererIpc {
  readonly on: (channel: string, listener: (event: unknown, value: unknown) => void) => void;
  readonly send: (channel: string, value: unknown) => void;
  readonly removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => void;
}
export function agentRuntimePreloadApi(ipc: RendererIpc): {
  readonly attachTerminal: TerminalPreloadStream;
} {
  const result: Record<string, (payload: never, onValue: (value: unknown) => void) => () => void> = {};
  for (const facet of daemonGuiStreamFacets)
    result[facet.guiBridgeMethod] = ((payload: unknown, onValue: (value: unknown) => void) => {
      assertPreloadPayload(facet.guiBridgeMethod, payload);
      if (typeof onValue !== "function") throw new Error("Stream listener is required.");
      const subscriptionId = `renderer-${++sequence}`,
        frameChannel = `harness:${facet.guiBridgeMethod}:frame:${subscriptionId}`,
        listener = (_event: unknown, value: unknown) => onValue(value);
      ipc.on(frameChannel, listener);
      ipc.send(`harness:${facet.guiBridgeMethod}`, { subscriptionId, payload });
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        ipc.removeListener(frameChannel, listener);
        ipc.send(`harness:${facet.guiBridgeMethod}:detach`, { subscriptionId });
      };
    }) as never;
  return result as unknown as {
    readonly attachTerminal: TerminalPreloadStream;
  };
}

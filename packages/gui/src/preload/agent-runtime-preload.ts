import { daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { assertPreloadPayload } from "./allowlist.ts";

const facet = daemonGuiStreamFacets[0]; let sequence = 0;
export type AgentRuntimePreloadStream = (payload: { readonly runtimeSessionId: string; readonly afterCursor: string }, onValue: (value: unknown) => void) => () => void;
interface RendererIpc { readonly on: (channel: string, listener: (event: unknown, value: unknown) => void) => void; readonly send: (channel: string, value: unknown) => void; readonly removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => void }
export function agentRuntimePreloadApi(ipc: RendererIpc): { readonly attachAgentRuntime: AgentRuntimePreloadStream } { return { attachAgentRuntime: (payload, onValue) => { assertPreloadPayload(facet.guiBridgeMethod, payload); if (typeof onValue !== "function") throw new Error("Agent runtime stream listener is required.");
  const subscriptionId = `renderer-${++sequence}`, frameChannel = `harness:${facet.guiBridgeMethod}:frame:${subscriptionId}`, listener = (_event: unknown, value: unknown) => onValue(value); ipc.on(frameChannel, listener); ipc.send(`harness:${facet.guiBridgeMethod}`, { subscriptionId, payload });
  let detached = false; return () => { if (detached) return; detached = true; ipc.removeListener(frameChannel, listener); ipc.send(`harness:${facet.guiBridgeMethod}:detach`, { subscriptionId }); }; } }; }

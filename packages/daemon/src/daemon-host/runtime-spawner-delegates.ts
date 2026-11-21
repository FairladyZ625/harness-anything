import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "@harness-anything/kernel";
import type { RuntimeSpawnerContext, RuntimeTerminalReplay } from "./runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeBinding } from "./runtime-spawn-types.ts";
import {
  consumeProviderChunk,
  consumeProviderLine,
  bindProvider as bindProviderImpl,
  captureErrorOutput as captureErrorOutputImpl,
  markProtocolError as markProtocolErrorImpl,
} from "./runtime-spawn-provider-stream.ts";
import {
  publishExit as publishExitImpl,
  runtimeResultText as runtimeResultTextImpl,
  applied as appliedImpl,
} from "./runtime-spawn-settlement.ts";
export { controlReceipt } from "./runtime-spawn-settlement.ts";

export const consumeChunk = (
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  chunk: string,
  flush: boolean,
  persisted = false,
) => consumeProviderChunk(context, active, chunk, flush, persisted);
export const consumeLine = (
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  line: string,
  persisted = false,
  publishSignals = true,
) => consumeProviderLine(context, active, line, persisted, publishSignals);
export const captureErrorOutput = (context: RuntimeSpawnerContext, active: ActiveRuntime, chunk: string): void =>
  captureErrorOutputImpl(context, active, chunk);
export const bindProvider = (context: RuntimeSpawnerContext, active: ActiveRuntime, identity: SessionIdentity) =>
  bindProviderImpl(context, active, identity);
export const markProtocolError = (context: RuntimeSpawnerContext, active: ActiveRuntime): void =>
  markProtocolErrorImpl(context, active);
export const publishExit = (
  context: RuntimeSpawnerContext,
  active: ActiveRuntime | RuntimeTerminalReplay,
  code: number | null,
  resumePublishedExit = false,
) => publishExitImpl(context, active, code, resumePublishedExit);
export const runtimeResultText = (
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  code: number | null,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped",
) => runtimeResultTextImpl(context, active, code, outcome);
export const applied = (
  context: RuntimeSpawnerContext,
  event: AgentRuntimeEventV1,
  publication: ReturnType<CanonicalEventStore["publication"]>,
  runtimeSessionId: string,
  dispatchId: string,
) => appliedImpl(context, event, publication, runtimeSessionId, dispatchId);

export function runtimeControlDelegates(context: RuntimeSpawnerContext) {
  const { processes, input } = context;
  return {
    activeRuntimeSessionIds: (): readonly string[] => [...processes.keys()],
    activeRuntimeCount: (): number => processes.size,
    isRuntimeActive: (runtimeSessionId: string): boolean => processes.has(runtimeSessionId),
    activeDispatchId: (runtimeSessionId: string): string | null => processes.get(runtimeSessionId)?.dispatchId ?? null,
    activeRuntimeForSelector: (
      selector: { readonly dispatchId: string } | { readonly runtimeSessionId: string },
    ): { readonly runtimeSessionId: string; readonly dispatchId: string } | null => {
      if ("runtimeSessionId" in selector) {
        const active = processes.get(selector.runtimeSessionId);
        return active ? { runtimeSessionId: active.runtimeSessionId, dispatchId: active.dispatchId } : null;
      }
      for (const active of processes.values()) {
        if (active.dispatchId === selector.dispatchId)
          return { runtimeSessionId: active.runtimeSessionId, dispatchId: active.dispatchId };
      }
      return null;
    },
    flushPendingSteerReceipts: async (defaultBinding?: RuntimeBinding): Promise<void> => {
      const { flushPendingSteerReceipts: flushReceipts } = await import("./runtime-spawn-active.ts");
      const { readAllPendingSteerReceipts } = await import("./dispatch-steer-state.ts");
      const { readDispatchStreamHeader } = await import("./dispatch-stream.ts");
      const dispatches = new Map<string, string>();
      for (const entry of readAllPendingSteerReceipts(input.rootDir)) {
        if (!dispatches.has(entry.dispatchId)) dispatches.set(entry.dispatchId, entry.runtimeSessionId);
      }
      for (const [dispatchId, runtimeSessionId] of dispatches) {
        const active = processes.get(runtimeSessionId),
          binding = active?.binding ?? readDispatchStreamHeader(input.rootDir, dispatchId)?.binding ?? defaultBinding;
        if (!binding) continue;
        await flushReceipts(context, dispatchId, runtimeSessionId, binding);
      }
    },
  };
}

import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "@harness-anything/kernel";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeAttemptTerminal } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome } from "./runtime-fallback-contract.ts";
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
  controlReceipt as controlReceiptImpl,
} from "./runtime-spawn-settlement.ts";
import { settleFallbackAttempt } from "./runtime-spawn-fallback.ts";

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
  active: ActiveRuntime,
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
export const controlReceipt = (
  context: RuntimeSpawnerContext,
  opId: string,
  runtimeSessionId: string,
  detail?: string,
) => controlReceiptImpl(context, opId, runtimeSessionId, detail);
export const settleFallback = (
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
) => settleFallbackAttempt(context, active, outcome, terminal);

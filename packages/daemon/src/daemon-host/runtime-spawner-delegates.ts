import type { CloudRuntimeRegistration } from "@harness-anything/application/internal/commands/runtime-execution-target.ts";
import type { RuntimeExecutionTarget } from "@harness-anything/kernel";
import { isCloudRuntimeExecutionTarget } from "@harness-anything/kernel/internal/domain/runtime-execution-target.ts";
import { runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instance-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { agentRuntimeAmbiguityWarning, type selectedRuntimeInstance } from "./runtime-instance-selection.ts";
import type { AuthorizationDecision, SessionIdentity } from "@harness-anything/kernel";
import type { RuntimeSpawnerContext, RuntimeTerminalReplay } from "./runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeAgent } from "./runtime-spawn-types.ts";
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
/** Attach the selection and operator notices to either local or Fleet acceptance. */
export function decorateSpawnReceipt(input: {
  readonly receipt: JsonObject;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly runtimeSelection: ReturnType<typeof selectedRuntimeInstance>;
  readonly model: string;
  readonly agent: RuntimeAgent | null;
  readonly runtimeInstances: readonly RuntimeInstanceSummary[];
  readonly selectionStrategy: Parameters<typeof agentRuntimeAmbiguityWarning>[0]["selectionStrategy"];
  readonly githubCredentialNotice: string | undefined;
  readonly readOnlyDispatch: boolean;
  readonly authorizationDecision: AuthorizationDecision | null;
}): JsonObject {
  const { agent, runtimeInstances, runtimeSelection, selectionStrategy, receipt } = input;
  const ambiguity = agent
    ? agentRuntimeAmbiguityWarning({
        agent,
        runtimeInstances,
        selected: runtimeSelection.instanceId,
        selectionStrategy,
      })
    : null;
  const notices = [ambiguity?.message, input.githubCredentialNotice].filter(
    (notice): notice is string => typeof notice === "string",
  );
  const existingWarnings = Array.isArray(receipt.warnings)
    ? (receipt.warnings as readonly unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  const { instanceId, tier, selectionStrategy: strategy, basis, reason } = runtimeSelection;
  return {
    ...receipt,
    runtimeSessionId: input.runtimeSessionId,
    dispatchId: input.dispatchId,
    runtimeSelection: { instanceId, tier, selectionStrategy: strategy, basis, reason, model: input.model },
    ...(notices.length > 0 ? { warnings: [...existingWarnings, ...notices] } : {}),
    ...(input.readOnlyDispatch ? { ledgerAccess: "unavailable", reportDelivery: "stdout" } : {}),
    authorizationDecision: input.authorizationDecision as unknown as JsonObject | null,
  };
}

export function runtimeExecutionTarget(
  registration: CloudRuntimeRegistration | undefined,
  instanceId: string,
): RuntimeExecutionTarget {
  if (!registration || !Object.hasOwn(registration.instanceTargets, instanceId)) return { kind: "local" };
  const target = { kind: "cloud", hostId: registration.instanceTargets[instanceId]?.hostId };
  if (!isCloudRuntimeExecutionTarget(target))
    throw runtimeSpawnError("invalid_runtime_launch", "Cloud sandbox host identifier is invalid.");
  return target;
}

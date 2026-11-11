import { getExecutableEntityAction } from "@harness-anything/kernel";
import { commandDescriptorForAction } from "../protocol/daemon-protocol.contract.ts";
import type { FleetFrameV1 } from "./command-protocol.ts";
import type { FleetEdgeRuntimeRequest } from "../fleet-edge-runtime.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";

export type CommandForwardingIntent = Readonly<{
  kind: "command";
  commandId: string;
  method: string;
  inputs: Readonly<Record<string, unknown>> & { readonly kind: string };
  executionContext: Readonly<{ executionId?: string; requiredNodeId?: string }>;
}>;

export type RuntimeForwardingIntent = Readonly<{
  kind: "runtime";
  method: FleetEdgeRuntimeRequest["payload"]["method"];
  inputs: Readonly<{
    action: JsonObject;
    operation?: "run" | "reconcile";
    requiredNodeId?: string;
  }>;
}>;

export type OperationalReadForwardingIntent = Readonly<{
  kind: "operational-read";
  method: Extract<FleetFrameV1, { schema: "fleet.operational.read/v1" }>["method"];
  inputs: Readonly<Record<string, unknown>>;
}>;

export type ForwardingIntent = CommandForwardingIntent | RuntimeForwardingIntent | OperationalReadForwardingIntent;

export function forwardingIntentForAction(
  method: string,
  inputs: Readonly<Record<string, unknown>> & { readonly kind: string },
  executionContext: Readonly<{ requiredNodeId?: string }> = {},
): CommandForwardingIntent {
  return {
    kind: "command",
    commandId: inputs.kind,
    method,
    inputs,
    executionContext: {
      ...(typeof inputs.executionId === "string" ? { executionId: inputs.executionId } : {}),
      ...(executionContext.requiredNodeId ? { requiredNodeId: executionContext.requiredNodeId } : {}),
    },
  };
}

export function runtimeForwardingIntent(
  method: FleetEdgeRuntimeRequest["payload"]["method"],
  action: JsonObject,
  options: Readonly<{ operation?: "run" | "reconcile"; requiredNodeId?: string }> = {},
): RuntimeForwardingIntent {
  return { kind: "runtime", method, inputs: { action, ...options } };
}

export function forwardingIntentIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "forwarding intent must be an object";
  const intent = value as Partial<CommandForwardingIntent>,
    inputs = intent.inputs as (CommandForwardingIntent["inputs"] & { readonly executionId?: unknown }) | undefined;
  if (
    typeof intent.commandId !== "string" ||
    typeof intent.method !== "string" ||
    !inputs ||
    typeof inputs !== "object"
  )
    return "forwarding intent requires commandId, method and inputs";
  if (inputs.kind !== intent.commandId) return "forwarding intent commandId must match inputs.kind";
  let descriptor;
  try {
    descriptor = commandDescriptorForAction(intent.commandId);
  } catch {
    return `forwarding intent command ${intent.commandId} is not declared`;
  }
  if (descriptor.method !== intent.method) return `forwarding intent method does not match ${intent.commandId}`;
  if (
    descriptor.admission["remote-edge"] !== "via-center-forward" &&
    !(
      descriptor.admission["remote-center"] === "via-node" &&
      descriptor.admission["remote-edge"] === "direct" &&
      getExecutableEntityAction(intent.commandId)?.target.kind === "schedule"
    ) &&
    !(intent.commandId === "doc-show" && intent.method === "repo.task.read")
  )
    return `forwarding intent command ${intent.commandId} is not center-forwardable`;
  if (
    intent.executionContext !== undefined &&
    (typeof intent.executionContext !== "object" ||
      (intent.executionContext.requiredNodeId !== undefined &&
        (typeof intent.executionContext.requiredNodeId !== "string" || !intent.executionContext.requiredNodeId)) ||
      (intent.executionContext.executionId !== undefined && intent.executionContext.executionId !== inputs.executionId))
  )
    return "forwarding intent execution context does not match its inputs";
  return null;
}

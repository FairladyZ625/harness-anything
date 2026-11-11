import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";

/** Runtime ingestion and migration share this aggregate event constructor. */
export function createAgentRuntimeEvent(
  input: Omit<AgentRuntimeEventV1, "schema" | "payload"> & { readonly payload: Readonly<Record<string, unknown>> },
): AgentRuntimeEventV1 {
  return { ...input, schema: "agent-runtime-event/v1", type: input.type } as AgentRuntimeEventV1;
}

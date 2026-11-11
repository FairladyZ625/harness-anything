import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";

/** Runtime ingestion and migration share this aggregate event constructor. */
export function createAgentRuntimeEvent(
  input: Omit<AgentRuntimeEventV1, "schema" | "payload"> & { readonly payload: Readonly<Record<string, unknown>> },
): AgentRuntimeEventV1 {
  return { schema: "agent-runtime-event/v1", ...input } as AgentRuntimeEventV1;
}

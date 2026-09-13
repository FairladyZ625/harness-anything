import { readBundledAgentDeclaration } from "../../preset/src/index.ts";
import {
  entitySlug,
  openEntityStore,
  parseAgentDeclarationV1,
  type AgentDeclarationV1,
  type EntityStore,
} from "../../kernel/src/index.ts";

export interface AgentDeclarationResolution {
  readonly declaration: AgentDeclarationV1;
  readonly layer: "installed" | "bundled";
}

export function readAgentDeclarationResolution(input: {
  readonly rootDir: string;
  readonly agentId: string;
  readonly entityStore?: EntityStore;
}): AgentDeclarationResolution | null {
  if (!entitySlug(input.agentId)) return null;
  const stored = (input.entityStore ?? openEntityStore(input.rootDir)).get("agent", input.agentId);
  if (stored) return { declaration: parseAgentDeclarationV1(stored.value), layer: "installed" };
  const bundled = readBundledAgentDeclaration(input.agentId);
  return bundled ? { declaration: bundled, layer: "bundled" } : null;
}

export function readAgentDeclaration(input: {
  readonly rootDir: string;
  readonly agentId: string;
  readonly entityStore?: EntityStore;
}): AgentDeclarationV1 {
  const resolved = readAgentDeclarationResolution(input);
  if (!resolved)
    throw Object.assign(new Error(`${input.agentId} is not an installed or bundled agent.`), {
      code: "agent_not_found",
    });
  return resolved.declaration;
}

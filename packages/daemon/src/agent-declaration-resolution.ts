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

export const agentDeclarationInvalidCode = "agent_declaration_invalid" as const;

/**
 * One installed declaration whose stored shape the current schema rejects — the window between a
 * declaration-schema change landing and the ledger being rewritten — fails as itself. Every read
 * and dispatch surface converts the raw contract error into this: it names the agent, the schema
 * reason, and the reinstall command, so the entry point never leaks a parse stack upward.
 */
export function agentDeclarationInvalidError(
  agentId: string,
  cause: unknown,
): Error & { readonly code: typeof agentDeclarationInvalidCode } {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(
      `Agent ${agentId} is installed, but its stored declaration no longer satisfies ` +
        `agent-declaration/v1 (${reason}). Rewrite harness/agents/${agentId}.json with the current ` +
        `declaration shape, then run ha agent install --source harness/agents/${agentId}.json.`,
    ),
    { code: agentDeclarationInvalidCode },
  );
}

export function isAgentDeclarationInvalid(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === agentDeclarationInvalidCode
  );
}

export function readAgentDeclarationResolution(input: {
  readonly rootDir: string;
  readonly agentId: string;
  readonly entityStore?: EntityStore;
}): AgentDeclarationResolution | null {
  if (!entitySlug(input.agentId)) return null;
  const entityStore = input.entityStore ?? openEntityStore(input.rootDir);
  let stored: ReturnType<EntityStore["get"]>;
  try {
    stored = entityStore.get("agent", input.agentId);
  } catch (error) {
    // An installed declaration the current schema cannot parse is a per-agent reinstall need,
    // never a silent fallthrough to the bundled layer: installed shadows bundled by design.
    if ((error as { readonly code?: unknown }).code !== "invalid_entity_contract") throw error;
    throw agentDeclarationInvalidError(input.agentId, error);
  }
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

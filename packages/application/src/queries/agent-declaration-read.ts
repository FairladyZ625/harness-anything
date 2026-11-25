import {
  validateAgentDeclarationV1,
  withoutLegacyAgentInstanceBindings,
  type AgentState,
} from "@harness-anything/kernel/internal/domain/agent-squad-schema.ts";
import { parseAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";

export type ProjectedAgentDeclaration = AgentDeclarationV1 & {
  readonly lifecycleState?: AgentState;
  readonly retirement?: { readonly retiredAt: string; readonly reason: string; readonly successor?: string };
};

/** Projection metadata is not part of the authored declaration schema. */
export function readProjectedAgentDeclaration(value: unknown): ProjectedAgentDeclaration {
  const { lifecycleState, retirement, ...declaration } = withoutLegacyAgentInstanceBindings(
    value,
  ) as ProjectedAgentDeclaration;
  return {
    ...parseAgentDeclarationV1(declaration),
    ...(lifecycleState === undefined ? {} : { lifecycleState }),
    ...(retirement === undefined ? {} : { retirement }),
  };
}

export const agentDeclarationInvalidCode = "agent_declaration_invalid" as const;

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

export type AgentDeclarationInvalid = Error & { readonly code: typeof agentDeclarationInvalidCode };

export type StoredAgentDeclarationOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly error: AgentDeclarationInvalid };

export function readProjectedAgentDeclarationOutcome(
  agentId: string,
  value: unknown,
): StoredAgentDeclarationOutcome<ProjectedAgentDeclaration> {
  if (value === null || value === undefined) return { kind: "missing" };
  const candidate =
    typeof value === "object" && !Array.isArray(value)
      ? (() => {
          const {
            lifecycleState: _lifecycleState,
            retirement: _retirement,
            ...declaration
          } = withoutLegacyAgentInstanceBindings(value) as ProjectedAgentDeclaration;
          return declaration;
        })()
      : value;
  const issues = validateAgentDeclarationV1(candidate);
  if (issues.length > 0) {
    return {
      kind: "invalid",
      error: agentDeclarationInvalidError(agentId, issues.join("; ")),
    };
  }
  return { kind: "ok", value: readProjectedAgentDeclaration(value) };
}

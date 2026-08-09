import type { JsonObject } from "../protocol/json-rpc-types.ts";

export function repoWriteOutcomeQuery(
  action: { readonly kind?: unknown; readonly taskId?: unknown; readonly decisionId?: unknown }
): JsonObject {
  const decisionId = concreteId(action.decisionId);
  if (decisionId) {
    return {
      schema: "command-outcome-query/v1",
      method: "decision.show",
      command: `ha decision show ${decisionId} --json`,
      parameters: { decisionId },
      retry: "forbidden-after-absence"
    };
  }
  const taskId = concreteId(action.taskId);
  if (taskId) {
    return {
      schema: "command-outcome-query/v1",
      method: "task.show",
      command: `ha task show ${taskId} --json`,
      parameters: { taskId },
      retry: "forbidden-after-absence"
    };
  }
  return {
    schema: "command-outcome-query/v1",
    method: "daemon.logs",
    command: "ha daemon logs --errors --json",
    parameters: {},
    retry: "forbidden"
  };
}

export function repoWriteOutcomeUnknownHint(
  action: { readonly kind?: unknown },
  diagnostic: string,
  query: JsonObject
): string {
  const command = typeof query.command === "string"
    ? query.command
    : "ha daemon logs --errors --json";
  const kind = typeof action.kind === "string" ? action.kind : "write";
  const reason = diagnostic
    .replace(/\s*Exact repo-write outcome lookup failed[\s\S]*$/u, "")
    .replace(/\s*query the stable outer opId[\s\S]*$/u, "")
    .replace(/[.\s]+$/u, "");
  if (query.method === "decision.show") {
    return `The child writer may already have committed ${kind}, but its final outcome is unknown: ${reason}. Run \`${command}\` to inspect the canonical projection. If the decision is absent, the outcome is still unknown; do not replay the write.`;
  }
  if (query.method === "task.show") {
    return `The child writer may already have committed ${kind}, but its final outcome is unknown: ${reason}. Run \`${command}\` to inspect the canonical projection. If the task state does not prove the write, the outcome is still unknown; do not replay it.`;
  }
  return `The child writer may already have committed ${kind}, but its final outcome is unknown: ${reason}. Run \`${command}\` to capture diagnostics. The result does not authorize replay; an operator must reconcile the final state first.`;
}

function concreteId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

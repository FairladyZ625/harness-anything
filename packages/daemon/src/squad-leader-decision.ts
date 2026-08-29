import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";

export type LeaderDecision =
  | { readonly kind: "converged" }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "plan";
      readonly dispatches: readonly WorkerPlan[];
    };

type SquadDecision = Extract<LeaderDecision, { readonly kind: "converged" | "waiting" }>;

export function squadDecisionFromValue(value: unknown): SquadDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schema !== "squad-decision/v1") return null;
  if (row.action === "converged") return { kind: "converged" };
  if (row.action === "waiting") return { kind: "waiting" };
  return null;
}

export function isSquadDecisionResult(text: string): boolean {
  try {
    return squadDecisionFromValue(JSON.parse(text.trim())) !== null;
  } catch {
    return false;
  }
}

export type WorkerWaitTrigger = {
  readonly kind: "worker_wait";
  readonly runtimeSessionId: string;
  readonly reason: string;
};

export type LeaderTrigger =
  | { readonly kind: "initial" }
  | {
      readonly kind: "leader_retry";
      readonly turnId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "worker_outcome";
      readonly runtimeSessionId: string;
    }
  | {
      readonly kind: "worker_rejected";
      readonly attemptId: string;
    }
  | WorkerWaitTrigger;

export type LeaderTurn = {
  readonly turnId: string;
  readonly trigger: LeaderTrigger;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly decision: LeaderDecision | null;
};

export type WorkerAttempt = {
  readonly attemptId: string;
  readonly workerId: string;
  /** 派发该 attempt 的 leader 轮次(扇出树父子边)。 */
  readonly leaderTurnId: string;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly rejection: string | null;
};

export type WorkerPlan = {
  readonly instance: string;
  readonly workerId: string;
  readonly prompt: string;
};

type LeaderPromptState = {
  readonly runtimeInstanceId: string;
  readonly taskId: string;
  readonly squadRunId: string;
  readonly roster: string;
  readonly mission: string;
  readonly workerAttempts: readonly WorkerAttempt[];
};

export function initialLeaderPrompt(state: LeaderPromptState): string {
  const example = JSON.stringify({
    schema: "runtime-batch/v1",
    dispatches: [
      {
        instance: state.runtimeInstanceId,
        to: "worker-id",
        prompt: "worker mission",
      },
    ],
  });
  return [
    "# Squad dispatch protocol",
    "Return exactly one JSON object and no Markdown:",
    example,
    "Choose only declared workers. Harness owns agent identity, task, cwd, and spawning.",
    synthesisReportInstruction(state),
    `# Squad roster\n${state.roster}`,
    `# User mission\n${state.mission}`,
  ].join("\n\n");
}

export function callbackLeaderPrompt(
  state: LeaderPromptState,
  triggers: readonly LeaderTrigger[],
  rows: readonly TaskDispatchRow[],
): string {
  const statusRows = statusRowsForPrompt(state, rows),
    retries = triggers.filter((trigger) => trigger.kind === "leader_retry"),
    waits = triggers.filter((trigger) => trigger.kind === "worker_wait"),
    sourceCounts = new Map<string, number>();
  for (const trigger of triggers) sourceCounts.set(trigger.kind, (sourceCounts.get(trigger.kind) ?? 0) + 1);
  return [
    retries.length > 0 ? "# Squad leader retry" : "# Squad worker callback",
    `Merged callback batch: total=${String(triggers.length)}; sources=${[...sourceCounts]
      .map(([kind, count]) => `${kind}:${String(count)}`)
      .join(",")}`,
    `Triggers: ${JSON.stringify(triggers)}`,
    ...retries.map((trigger) => `Previous turn could not advance: ${trigger.reason}`),
    ...waits.map((trigger) => `Wait completed: ${trigger.reason}`),
    "Review the durable TaskDispatchRow receipts below. " +
      "Return runtime-batch/v1 to reassign or add work. " +
      "Every runtime-batch/v1 must contain at least one dispatch. " +
      'Return {"schema":"squad-decision/v1","action":"waiting"} while another worker is running. ' +
      'Return {"schema":"squad-decision/v1","action":"converged"} only when no worker is running. ' +
      "Return exactly one JSON object and no Markdown.",
    synthesisReportInstruction(state),
    ...statusRows,
    `# Original mission\n${state.mission}`,
  ].join("\n\n");
}

function statusRowsForPrompt(state: LeaderPromptState, rows: readonly TaskDispatchRow[]): readonly string[] {
  const byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
  return state.workerAttempts.map((attempt) => {
    const row = attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined;
    return [
      `worker ${attempt.workerId}`,
      `attempt=${attempt.attemptId}`,
      `dispatch=${attempt.dispatchId ?? "none"}`,
      `session=${attempt.runtimeSessionId ?? "none"}`,
      `status=${attempt.rejection ? "rejected" : (row?.status ?? "running")}`,
      `exitCode=${String(row?.exitCode ?? "none")}`,
      `resultRef=${row?.resultRef ?? "none"}`,
      `reportPath=${row?.reportPath ?? "none"}`,
      `rejection=${attempt.rejection ?? "none"}`,
    ].join(" ");
  });
}

export function parseLeaderDecision(
  text: string,
  runtimeInstanceId: string,
  workers: readonly string[],
): LeaderDecision {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error("Leader result was not JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Leader result was not an object.");
  const squadDecision = squadDecisionFromValue(value);
  if (squadDecision !== null) return squadDecision;
  const row = value as Record<string, unknown>;
  if (row.schema !== "runtime-batch/v1" || !Array.isArray(row.dispatches))
    throw new Error("Leader result must be runtime-batch/v1 or a waiting/converged squad-decision/v1.");
  if (row.dispatches.length === 0) throw new Error("Leader runtime-batch/v1 dispatches must be a non-empty array.");
  const seen = new Set<string>(),
    dispatches = row.dispatches.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Leader dispatch is invalid.");
      const item = entry as Record<string, unknown>,
        instance = requiredLeaderText(item.instance, "worker instance"),
        workerId = requiredLeaderText(item.to, "worker id"),
        prompt = requiredLeaderText(item.prompt, "worker prompt");
      if (instance !== runtimeInstanceId)
        throw new Error(`Leader dispatch must use runtime instance ${runtimeInstanceId}.`);
      if (!workers.includes(workerId) || seen.has(workerId))
        throw new Error(`Leader selected invalid or duplicate worker ${workerId}.`);
      const allowed = new Set(["instance", "to", "prompt"]);
      if (Object.keys(item).some((key) => !allowed.has(key)))
        throw new Error("Leader dispatch contains harness-owned fields.");
      seen.add(workerId);
      return { instance, workerId, prompt };
    });
  return { kind: "plan", dispatches };
}

function synthesisReportInstruction(state: LeaderPromptState): string {
  const reportPath = synthesisReportPath(state);
  return reportPath === null
    ? "The squad roster does not declare exactly one synthesis report under artifacts/reports; convergence will fail."
    : [
        `Before declaring convergence, write and submit the synthesis report to ${reportPath}.`,
        `Publish it from an untracked source with ha task artifact add ${state.taskId} --source <source.md> ` +
          `--destination ${reportPath.slice("artifacts/".length)}.`,
      ].join(" ");
}

export function synthesisReportPath(state: { readonly roster: string; readonly squadRunId: string }): string | null {
  const declared = [
    ...new Set([...state.roster.matchAll(/\bartifacts\/reports\/[A-Za-z0-9._{}-]+\.md\b/gu)].map(([match]) => match)),
  ];
  if (declared.length !== 1 || declared[0]!.startsWith("artifacts/reports/dispatch_")) return null;
  return declared[0]!.replaceAll("{squadRunId}", state.squadRunId);
}

export function triggerKey(trigger: Exclude<LeaderTrigger, { readonly kind: "initial" }>): string {
  if (trigger.kind === "leader_retry") return `retry:${trigger.turnId}`;
  if (trigger.kind === "worker_wait") return `wait:${trigger.runtimeSessionId}`;
  return trigger.kind === "worker_outcome" ? `outcome:${trigger.runtimeSessionId}` : `rejected:${trigger.attemptId}`;
}

function requiredLeaderText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required.`);
  return value;
}

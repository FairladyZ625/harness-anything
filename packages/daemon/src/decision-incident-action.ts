import path from "node:path";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonTaskRuntimeContextResult } from "./protocol/daemon-protocol-runtime-context.ts";
import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell-types.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import {
  continuationContext,
  currentWorktreeHead,
  type RuntimeContinuationSeed,
} from "./runtime-continuation-context.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import { withOnlineRuntimeSession, type RuntimeOperatorSession } from "./runtime-online-binding.ts";
import type { DecisionActionRecord } from "./decision-annotations.ts";
import { incidentContinuationUsed } from "./decision-incident-receipt.ts";

/** The fixed executable contract: a question with this version chooses exactly one of the five
 * disposition options (dec_EB24AB3EA19FA0A023FBE65C92). Any other selection id is not admissible. */
export const incidentDispositionQuestionVersion = "runtime-incident-disposition/v1";
export const incidentDispositionOptions = [
  "resume_original",
  "rerun_same_identity",
  "switch_declared_next",
  "needs_attention",
  "no_action",
] as const;
export type IncidentDispositionOption = (typeof incidentDispositionOptions)[number];

/** What a `needs_attention` disposition actually asks of the owner. A `question` is a worker or
 * provider asking for a ruling; a `guard` is the daemon refusing every automatic action, which the
 * owner must handle but must never be shown as a question. */
export type IncidentAttention = "question" | "guard";

/** The fixed automatic-continuation allowance: how many consecutive stops without measured
 * worktree progress the daemon may redispatch before it escalates to the owner. It is a daemon
 * constant, not the repository's review-return budget: review returns bound how many times a
 * reviewer may send a delivery back, while this allowance only bounds a no-progress loop. */
export const incidentContinuationBudget = 3;

export interface IncidentDecisionFields {
  readonly toolCallCount: number | null;
  readonly headStatus: "unchanged" | "changed" | "unavailable" | "no-previous-run";
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
  readonly currentHead: string | null;
  readonly roundsUsed: number;
  /** Consecutive no-progress automatic redispatches consumed through this stop. The declared
   * decision input id (`task.reworkBudget`) and its projected label are frozen contract names;
   * the measured value is this continuation allowance, independent of review returns. */
  readonly continuationBudget: {
    readonly used: number;
    readonly limit: number;
    readonly source: "daemon";
  };
}

/** Assemble the daemon-measured incident fields from the same reads runtime preparation uses.
 * Continuation seed and worktree HEAD come from task_3fedf360's single construction; nothing here
 * re-derives them from prose. */
export async function incidentDecisionFields(input: {
  readonly rootDir: string;
  readonly runtimeContext: DaemonTaskRuntimeContextResult;
  readonly dispatches: readonly TaskDispatchRow[];
  readonly toolCallCount: number | null;
}): Promise<IncidentDecisionFields> {
  const workspace = input.runtimeContext.snapshot.workspace,
    cwd =
      workspace?.kind === "worktree" && (workspace.state === "materialized" || workspace.state === "retained")
        ? path.resolve(input.rootDir, workspace.path)
        : null,
    seed: RuntimeContinuationSeed | null = input.runtimeContext.continuationContext,
    context = continuationContext(seed, cwd === null ? null : await currentWorktreeHead(cwd));
  return {
    toolCallCount: input.toolCallCount,
    headStatus: context.headStatus,
    lastConclusion: context.lastConclusion,
    exitHead: context.exitHead,
    currentHead: context.currentHead,
    roundsUsed: input.dispatches.length,
    continuationBudget: {
      used: incidentContinuationUsed(input.dispatches, context.headStatus === "changed"),
      limit: incidentContinuationBudget,
      source: "daemon",
    },
  };
}

/** Canonical evidence the action gate reads at the same cut as the provider input. */
export interface IncidentActionEvidence {
  readonly submitted: boolean;
  readonly successorActive: boolean;
  readonly leaseOccupied: boolean;
  readonly resumable: boolean;
  readonly agentId: string | null;
  /** Completed dispatches for this task, the round number the owner-visible reason names. */
  readonly roundsUsed: number;
  readonly budget: { readonly used: number; readonly limit: number };
  /** Whether the worktree HEAD is measurably known. A restart inherits the worktree; without a
   * measured HEAD there is no base to continue from, so automatic execution fails closed. */
  readonly headKnown: boolean;
}

export type IncidentGuardPlan = {
  readonly action: "needs_attention";
  readonly attention: "guard";
  readonly rationale: string;
  /** Why this option was refused, without the option and dispatch wrapper. */
  readonly guard: string;
};

export type IncidentActionPlan =
  | { readonly action: "resume"; readonly payload: JsonObject }
  | { readonly action: "rerun"; readonly payload: JsonObject }
  | {
      readonly action: "needs_attention";
      readonly attention: IncidentAttention;
      readonly rationale: string;
      /** Why this option was refused, without the option and dispatch wrapper. The provider-less
       * default reads it to name the guard in its own receipt. */
      readonly guard: string;
    }
  | { readonly action: "no_action" };

/** The owner-facing command that re-dispatches this incident under the same worker identity, or
 * acquires the execution when the source dispatch has no identity to reuse. */
export function redispatchCommand(taskId: string, agentId: string | null): string {
  return agentId === null ? `ha task start ${taskId}` : `ha agent run ${agentId} --task ${taskId}`;
}

/** A guard refusal is a CEO handling item, never a question: the reason names the worker stop, the
 * exhausted redispatch budget, and the command that moves the incident forward. `next` is explicit:
 * `undefined` uses the default redispatch command, `null` says this refusal has no safe automatic
 * successor (a running dispatch or an accepted submission), and a string names the command. */
export function incidentGuardPlan(input: {
  readonly taskId: string;
  readonly guard: string;
  readonly evidence: Pick<IncidentActionEvidence, "roundsUsed" | "budget" | "agentId">;
  readonly next?: string | null;
}): IncidentGuardPlan {
  const next = input.next === undefined ? redispatchCommand(input.taskId, input.evidence.agentId) : input.next;
  return {
    action: "needs_attention",
    attention: "guard",
    guard: input.guard,
    rationale: [
      `needs_attention: ${input.guard}`,
      `Worker stopped without a submitted delivery on round ${String(input.evidence.roundsUsed)};`,
      `automatic redispatch budget ${String(input.evidence.budget.used)}/${String(input.evidence.budget.limit)} used on consecutive stops without worktree progress.`,
      ...(next === null ? [] : [`Next: ${next}`]),
    ].join(" "),
  };
}

/** The daemon-side eligibility gate: the provider only chooses; admissibility is decided here and
 * every doubt escalates instead of launching (fail-closed, never a silent rerun). */
export function planIncidentAction(input: {
  readonly selected: string;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly evidence: IncidentActionEvidence;
}): IncidentActionPlan {
  const escalate = (guard: string, next?: string | null): IncidentActionPlan =>
    incidentGuardPlan({
      taskId: input.taskId,
      guard,
      evidence: input.evidence,
      ...(next === undefined ? {} : { next }),
    });
  if (!(incidentDispositionOptions as readonly string[]).includes(input.selected))
    return escalate("the selected option id is not declared by the incident disposition contract.");
  const automaticGuards = (): { readonly guard: string; readonly next?: string | null } | null =>
    input.evidence.submitted
      ? { guard: "the task already has an accepted submission.", next: null }
      : input.evidence.successorActive
        ? { guard: "another dispatch for this task is already running.", next: null }
        : input.evidence.leaseOccupied
          ? { guard: "the task lease is occupied.", next: null }
          : input.evidence.budget.used >= input.evidence.budget.limit
            ? { guard: "the automatic disposition budget is exhausted." }
            : !input.evidence.headKnown
              ? {
                  guard: "the worktree HEAD is unknown, so no automatic restart has a known base.",
                  next: `ha task start ${input.taskId}`,
                }
              : null;
  if (input.selected === "needs_attention") {
    const rationale = awaitRationale(input.taskId, input.dispatchId);
    return { action: "needs_attention", attention: "question", rationale, guard: rationale };
  }
  if (input.selected === "no_action") {
    if (input.evidence.submitted || input.evidence.successorActive) return { action: "no_action" };
    return escalate("no canonical submission or active successor backs doing nothing.");
  }
  if (input.selected === "switch_declared_next")
    return escalate("a worker-stop incident is not a provider fault, so the declared fallback ladder stays closed.");
  const guard = automaticGuards();
  if (guard) return escalate(guard.guard, guard.next);
  if (input.selected === "resume_original") {
    if (!input.evidence.resumable) return escalate("the source dispatch has no resumable provider session.");
    return { action: "resume", payload: incidentSpawnPayload(input.taskId, input.dispatchId, true, null) };
  }
  if (!input.evidence.agentId) return escalate("the source dispatch has no worker identity to rerun.");
  return {
    action: "rerun",
    payload: incidentSpawnPayload(input.taskId, input.dispatchId, false, input.evidence.agentId),
  };
}

function awaitRationale(taskId: string, dispatchId: string): string {
  return `question: Decisions API escalated the runtime incident on dispatch ${dispatchId} of task ${taskId} for an owner disposition.`;
}

/** Preference order of the provider-less disposition. This list is the only new information: which
 * declared option to try first. Whether a candidate is admissible stays with the gate above, so
 * there is no second copy of the guards. */
const defaultDispositionPreference = ["no_action", "resume_original", "rerun_same_identity"] as const;

export type DefaultIncidentDisposition =
  | {
      readonly kind: "execute";
      readonly selected: (typeof defaultDispositionPreference)[number];
      readonly plan: IncidentActionPlan;
    }
  | {
      readonly kind: "escalate";
      readonly guard: string;
      readonly plan: Extract<IncidentActionPlan, { readonly action: "needs_attention" }>;
    };

/** The disposition when the Decisions provider cannot answer: the provider accelerates the choice,
 * it is never the only route to one. Each candidate goes through the same admissibility gate; the
 * first admissible one wins, and only when every automatic option is refused does the incident go
 * to the owner, naming the guard that refused it. */
export function defaultIncidentDisposition(input: {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly evidence: IncidentActionEvidence;
}): DefaultIncidentDisposition {
  let refusal: Extract<IncidentActionPlan, { readonly action: "needs_attention" }> = incidentGuardPlan({
    taskId: input.taskId,
    guard: "no declared automatic disposition is admissible.",
    evidence: input.evidence,
  });
  for (const selected of defaultDispositionPreference) {
    const plan = planIncidentAction({ ...input, selected });
    if (plan.action !== "needs_attention") return { kind: "execute", selected, plan };
    refusal = plan;
  }
  // Every candidate was refused; the deepest refusal (rerun needs the most) names the real guard.
  return { kind: "escalate", guard: refusal.guard, plan: refusal };
}

function incidentSpawnPayload(
  taskId: string,
  sourceDispatchId: string,
  resume: boolean,
  agentId: string | null,
): JsonObject {
  return {
    taskId,
    ...(resume ? { dispatchId: sourceDispatchId } : {}),
    ...(agentId && !resume ? { agentId } : {}),
    prompt: [
      `Continue task ${taskId}.`,
      `The previous worker (dispatch ${sourceDispatchId}) stopped without a submitted delivery; inspect the current worktree and continue from the existing progress.`,
      "Submit the delivery or report a blocking decision.",
    ].join(" "),
    dispatchKey: `incident-action:${taskId}:${sourceDispatchId}`,
  };
}

/** The actor an automatic successor inherits: the source dispatch's own persisted binding, the
 * same authority the provider-fallback continuation launches under. */
export function incidentActionBinding(rootDir: string, dispatchId: string): RepoCellBinding | null {
  const stored = readDispatchStream(rootDir, dispatchId)?.header.binding;
  return stored ? runtimeBindingForDispatch(stored) : null;
}

export interface IncidentActionOutcome {
  readonly action: DecisionActionRecord["action"];
  readonly attention: IncidentAttention | null;
  readonly status: "applied" | "failed";
  readonly reason: string | null;
  readonly successorDispatchId: string | null;
}

/** Execute one disposition through the existing single entry point: spawn admission for
 * resume/rerun. An owner escalation is carried by the source dispatch's durable decision receipt;
 * its `attention` value is what keeps a guard refusal out of the ruling queue. */
export async function executeIncidentAction(input: {
  readonly cell: RepoCell;
  readonly taskId: string;
  readonly plan: IncidentActionPlan;
  readonly binding: RepoCellBinding | null;
  readonly dispatchId: string;
  /** The same daemon-local session source a manual runtime launch resolves at acceptance. */
  readonly keycloakSession: () => Promise<RuntimeOperatorSession>;
}): Promise<IncidentActionOutcome> {
  if (input.plan.action === "no_action")
    return { action: "no_action", attention: null, status: "applied", reason: null, successorDispatchId: null };
  if (input.plan.action === "needs_attention")
    return {
      action: "needs_attention",
      attention: input.plan.attention,
      status: "applied",
      reason: input.plan.rationale,
      successorDispatchId: null,
    };
  if (!input.binding)
    return {
      action: "needs_attention",
      attention: "guard",
      status: "applied",
      reason: `needs_attention: the source dispatch ${input.dispatchId} has no persisted action binding for ${input.plan.action}. Next: ${redispatchCommand(input.taskId, null)}`,
      successorDispatchId: null,
    };
  try {
    const binding = await withOnlineRuntimeSession(input.binding, input.keycloakSession),
      receipt = await input.cell.spawnRuntime(input.plan.payload, binding),
      successorDispatchId = typeof receipt.dispatchId === "string" ? receipt.dispatchId : null;
    if (!successorDispatchId) throw new Error("the spawn receipt names no successor dispatch.");
    return {
      action: input.plan.action,
      attention: null,
      status: "applied",
      reason: null,
      successorDispatchId,
    };
  } catch (error) {
    const launchFailure = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    return {
      action: "needs_attention",
      attention: "guard",
      status: "applied",
      reason: `needs_attention: launch failed: ${launchFailure} (automatic ${input.plan.action} for dispatch ${input.dispatchId}). Next: ${redispatchCommand(input.taskId, null)}`,
      successorDispatchId: null,
    };
  }
}

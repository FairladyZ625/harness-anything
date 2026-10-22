import path from "node:path";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonTaskRuntimeContextResult } from "./protocol/daemon-protocol-runtime-context.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell-types.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import {
  continuationContext,
  currentWorktreeHead,
  type RuntimeContinuationSeed,
} from "./runtime-continuation-context.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import type { DecisionActionRecord } from "./decision-annotations.ts";

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

export interface IncidentDecisionFields {
  readonly toolCallCount: number | null;
  readonly headStatus: "unchanged" | "changed" | "unavailable" | "no-previous-run";
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
  readonly currentHead: string | null;
  readonly roundsUsed: number;
  readonly reworkBudget: { readonly used: number; readonly limit: number; readonly source: "task" | "repository" };
}

/** Assemble the daemon-measured incident fields from the same reads runtime preparation uses.
 * Continuation seed and worktree HEAD come from task_3fedf360's single construction; nothing here
 * re-derives them from prose. */
export async function incidentDecisionFields(input: {
  readonly rootDir: string;
  readonly runtimeContext: DaemonTaskRuntimeContextResult;
  readonly dispatchCount: number;
  readonly toolCallCount: number | null;
  readonly effectiveBudget: { readonly value: number; readonly source: "task" | "repository" };
  readonly used: number;
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
    roundsUsed: input.dispatchCount,
    reworkBudget: {
      used: input.used,
      limit: input.effectiveBudget.value,
      source: input.effectiveBudget.source,
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
  readonly budgetRemaining: number;
}

export type IncidentActionPlan =
  | { readonly action: "resume"; readonly payload: JsonObject }
  | { readonly action: "rerun"; readonly payload: JsonObject }
  | { readonly action: "needs_attention"; readonly rationale: string }
  | { readonly action: "no_action" };

/** The daemon-side eligibility gate: the provider only chooses; admissibility is decided here and
 * every doubt escalates instead of launching (fail-closed, never a silent rerun). */
export function planIncidentAction(input: {
  readonly selected: string;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly evidence: IncidentActionEvidence;
}): IncidentActionPlan {
  const escalate = (reason: string): IncidentActionPlan => ({
    action: "needs_attention",
    rationale: `question: Decisions API could not safely apply "${input.selected}" for dispatch ${input.dispatchId}: ${reason}`,
  });
  if (!(incidentDispositionOptions as readonly string[]).includes(input.selected))
    return escalate("the selected option id is not declared by the incident disposition contract.");
  const automaticGuards = (): string | null =>
    input.evidence.submitted
      ? "the task already has an accepted submission."
      : input.evidence.successorActive
        ? "another dispatch for this task is already running."
        : input.evidence.leaseOccupied
          ? "the task lease is occupied."
          : input.evidence.budgetRemaining <= 0
            ? "the automatic disposition budget is exhausted."
            : null;
  if (input.selected === "needs_attention")
    return { action: "needs_attention", rationale: awaitRationale(input.taskId, input.dispatchId) };
  if (input.selected === "no_action") {
    if (input.evidence.submitted || input.evidence.successorActive) return { action: "no_action" };
    return escalate("no canonical submission or active successor backs doing nothing.");
  }
  if (input.selected === "switch_declared_next")
    return escalate("a worker-stop incident is not a provider fault, so the declared fallback ladder stays closed.");
  const guard = automaticGuards();
  if (guard) return escalate(guard);
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
  readonly status: "applied" | "failed";
  readonly reason: string | null;
  readonly successorDispatchId: string | null;
}

/** Execute one disposition through the existing single entry points: spawn admission for
 * resume/rerun, the relation write for the owner escalation. A failed launch escalates to the
 * owner instead of retrying; an escalation that also fails leaves an honest failed receipt. */
export async function executeIncidentAction(input: {
  readonly cell: RepoCell;
  readonly plan: IncidentActionPlan;
  readonly binding: RepoCellBinding | null;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly ownerId: string | null;
}): Promise<IncidentActionOutcome> {
  if (input.plan.action === "no_action")
    return { action: "no_action", status: "applied", reason: null, successorDispatchId: null };
  if (!input.binding || !input.ownerId)
    return {
      action: input.plan.action,
      status: "failed",
      reason: !input.binding
        ? "the source dispatch has no persisted action binding."
        : "the task has no owner principal to await.",
      successorDispatchId: null,
    };
  if (input.plan.action === "needs_attention")
    return relateOwnerAwait(input.cell, input.taskId, input.ownerId, input.binding, input.plan.rationale);
  try {
    const receipt = await input.cell.spawnRuntime(input.plan.payload, input.binding),
      successorDispatchId = typeof receipt.dispatchId === "string" ? receipt.dispatchId : null;
    if (!successorDispatchId) throw new Error("the spawn receipt names no successor dispatch.");
    return { action: input.plan.action, status: "applied", reason: null, successorDispatchId };
  } catch (error) {
    const launchFailure = (error instanceof Error ? error.message : String(error)).slice(0, 512),
      escalation = await relateOwnerAwait(
        input.cell,
        input.taskId,
        input.ownerId,
        input.binding,
        `question: the incident action for dispatch ${input.dispatchId} could not launch: ${launchFailure}`,
      );
    return {
      ...escalation,
      reason: `launch failed: ${launchFailure}`,
      successorDispatchId: null,
    };
  }
}

async function relateOwnerAwait(
  cell: RepoCell,
  taskId: string,
  ownerId: string,
  binding: RepoCellBinding,
  rationale: string,
): Promise<IncidentActionOutcome> {
  try {
    const receipt = (await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `task/${taskId}`,
        targetRef: `person/${ownerId}`,
        relationType: "awaits",
        direction: "directed",
        rationale,
        expectedVersion: 0,
      },
      binding,
    )) as { readonly outcome?: string };
    // `pending` stays durable-but-invisible and can still be replayed by the owner; only an
    // accepted write counts as the escalation the incident decision owes the task.
    if (receipt.outcome !== "applied" && receipt.outcome !== "pending")
      return {
        action: "needs_attention",
        status: "failed",
        reason: `owner await write settled as ${receipt.outcome ?? "unknown"}.`,
        successorDispatchId: null,
      };
    return { action: "needs_attention", status: "applied", reason: null, successorDispatchId: null };
  } catch (error) {
    return {
      action: "needs_attention",
      status: "failed",
      reason: `owner await write failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 512)}`,
      successorDispatchId: null,
    };
  }
}

import { decisionStates, type DecisionState } from "./decision-event.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type { PackageDisposition } from "./package-disposition.ts";
import type { BlockingAssessmentState } from "./task-blocking.ts";

export type WorkspaceDecisionGroupId = "proposed" | "in_effect" | "rejected" | "deferred" | "retired";

export interface WorkspaceSummaryTask {
  readonly coordinationStatus: DomainStatus | "unknown";
  readonly packageDisposition: PackageDisposition;
}

export interface WorkspaceTaskStatusInput {
  readonly status: DomainStatus;
  readonly blockingState: BlockingAssessmentState;
}

export interface WorkspaceSummaryDecision {
  readonly decisionId: string;
  readonly state: DecisionState;
}

export interface WorkspaceTaskCounts {
  readonly total: number;
  readonly byStatus: Readonly<Record<DomainStatus | "unknown", number>>;
}

export interface WorkspaceTaskSummary extends WorkspaceTaskCounts {
  readonly includingArchived: WorkspaceTaskCounts;
}

export interface WorkspaceDecisionGroup {
  readonly id: WorkspaceDecisionGroupId;
  readonly states: readonly DecisionState[];
  readonly count: number;
  readonly decisionIds: readonly string[];
}

export interface WorkspaceDecisionSummary {
  readonly total: number;
  readonly inboxCount: number;
  readonly byState: Readonly<Record<DecisionState, number>>;
  readonly groups: readonly WorkspaceDecisionGroup[];
}

export interface WorkspaceSummary {
  readonly tasks: WorkspaceTaskSummary;
  readonly decisions: WorkspaceDecisionSummary;
}

/**
 * Canonical workspace census consumed by daemon projections. The default task
 * census matches the board's default rows: active packages excluding cancelled
 * tasks. The optional archived/cancelled board view consumes the all-row census.
 * Both classify the already-derived coordinationStatus rather than reconstructing
 * status semantics from canonical task fields.
 * Decision groups preserve every registered decision state exactly once; proposed
 * therefore means only "awaits judgment", and retired includes both ways a
 * decision can leave standing use.
 */
export function summarizeWorkspace(
  tasks: readonly WorkspaceSummaryTask[],
  decisions: readonly WorkspaceSummaryDecision[]
): WorkspaceSummary {
  const includingArchived = countTasks(tasks);
  const boardTasks = tasks.filter((task) => task.packageDisposition === "active" && task.coordinationStatus !== "cancelled");
  const boardCounts = countTasks(boardTasks);

  const groups: Array<{ id: WorkspaceDecisionGroupId; states: DecisionState[]; decisionIds: string[] }> = [
    { id: "proposed", states: ["proposed"], decisionIds: [] },
    { id: "in_effect", states: ["in_effect"], decisionIds: [] },
    { id: "rejected", states: ["rejected"], decisionIds: [] },
    { id: "deferred", states: ["deferred"], decisionIds: [] },
    { id: "retired", states: ["superseded", "outcome_retired"], decisionIds: [] }
  ];
  const groupByState = new Map(groups.flatMap((group) => group.states.map((state) => [state, group] as const)));
  if (groupByState.size !== decisionStates.length) throw new Error("Workspace decision groups must cover every decision state exactly once.");
  const byState: Record<DecisionState, number> = { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0 };
  for (const decision of decisions) {
    byState[decision.state] += 1;
    groupByState.get(decision.state)!.decisionIds.push(decision.decisionId);
  }
  const publishedGroups = groups.map((group) => ({ ...group, count: group.decisionIds.length }));

  return {
    tasks: { ...boardCounts, includingArchived },
    decisions: {
      total: decisions.length,
      inboxCount: publishedGroups[0]!.count,
      byState,
      groups: publishedGroups
    }
  };
}

function countTasks(tasks: readonly WorkspaceSummaryTask[]): WorkspaceTaskCounts {
  const byStatus: Record<DomainStatus | "unknown", number> = {
    planned: 0,
    active: 0,
    blocked: 0,
    in_review: 0,
    done: 0,
    cancelled: 0,
    unknown: 0
  };
  for (const task of tasks) byStatus[task.coordinationStatus] += 1;
  return { total: tasks.length, byStatus };
}

export function workspaceTaskStatus(task: WorkspaceTaskStatusInput): DomainStatus {
  return task.blockingState === "blocked" && (task.status === "planned" || task.status === "active")
    ? "blocked"
    : task.status;
}

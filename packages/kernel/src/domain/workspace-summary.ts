import { decisionStates, type DecisionState } from "./decision-event.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type { PackageDisposition } from "./package-disposition.ts";
import type { BlockingAssessmentState } from "./task-blocking.ts";

export type WorkspaceDecisionGroupId = "proposed" | "in_effect" | "rejected" | "deferred" | "retired";

export interface WorkspaceSummaryTask {
  readonly coordinationStatus: DomainStatus | "unknown";
  readonly packageDisposition: PackageDisposition;
  readonly updatedAt: string;
}

export interface WorkspaceTaskStatusInput {
  readonly status: DomainStatus;
  readonly blockingState: BlockingAssessmentState;
}

export interface WorkspaceSummaryDecision {
  readonly decisionId: string;
  readonly state: DecisionState;
}

export interface WorkspaceTaskSummary {
  readonly lastChangedAt: string | null;
  readonly total: number;
  readonly byStatus: Readonly<Record<DomainStatus | "unknown", number>>;
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
 * Canonical workspace census consumed by daemon projections. The task census
 * counts exactly the rows the board draws by default — active packages excluding
 * cancelled tasks — so the overview and the board cannot disagree about how many
 * tasks are in a status. It classifies the already-derived coordinationStatus
 * rather than reconstructing status semantics from canonical task fields.
 * Decision groups preserve every registered decision state exactly once; proposed
 * therefore means only "awaits judgment", and retired includes both ways a
 * decision can leave standing use.
 */
export function summarizeWorkspace(
  tasks: readonly WorkspaceSummaryTask[],
  decisions: readonly WorkspaceSummaryDecision[],
): WorkspaceSummary {
  const activePackageTasks = emptyWorkspaceTaskCounts();
  let lastChangedAt: string | null = null;
  for (const task of tasks) {
    if (task.packageDisposition !== "active") continue;
    activePackageTasks[task.coordinationStatus] += 1;
    if (lastChangedAt === null || task.updatedAt > lastChangedAt) lastChangedAt = task.updatedAt;
  }
  return summarizeWorkspaceCensus(activePackageTasks, decisions, lastChangedAt);
}

/** The same census from active-package task counts by coordinationStatus, for a projection
 * that counts tasks in SQL instead of materializing each one. */
export function summarizeWorkspaceCensus(
  activePackageTasks: Readonly<Record<DomainStatus | "unknown", number>>,
  decisions: readonly WorkspaceSummaryDecision[],
  lastChangedAt: string | null,
): WorkspaceSummary {
  const groups: Array<{ id: WorkspaceDecisionGroupId; states: DecisionState[]; decisionIds: string[] }> = [
    { id: "proposed", states: ["proposed"], decisionIds: [] },
    { id: "in_effect", states: ["in_effect"], decisionIds: [] },
    { id: "rejected", states: ["rejected"], decisionIds: [] },
    { id: "deferred", states: ["deferred"], decisionIds: [] },
    { id: "retired", states: ["superseded", "outcome_retired"], decisionIds: [] },
  ];
  const groupByState = new Map(groups.flatMap((group) => group.states.map((state) => [state, group] as const)));
  if (groupByState.size !== decisionStates.length)
    throw new Error("Workspace decision groups must cover every decision state exactly once.");
  const byState: Record<DecisionState, number> = {
    proposed: 0,
    in_effect: 0,
    rejected: 0,
    deferred: 0,
    superseded: 0,
    outcome_retired: 0,
  };
  for (const decision of decisions) {
    byState[decision.state] += 1;
    groupByState.get(decision.state)!.decisionIds.push(decision.decisionId);
  }
  const publishedGroups = groups.map((group) => ({ ...group, count: group.decisionIds.length }));

  return {
    tasks: { ...boardTaskSummary(activePackageTasks), lastChangedAt },
    decisions: {
      total: decisions.length,
      inboxCount: publishedGroups[0]!.count,
      byState,
      groups: publishedGroups,
    },
  };
}

export function emptyWorkspaceTaskCounts(): Record<DomainStatus | "unknown", number> {
  return { planned: 0, active: 0, submitted: 0, blocked: 0, in_review: 0, done: 0, cancelled: 0, unknown: 0 };
}

function boardTaskSummary(
  activePackageTasks: Readonly<Record<DomainStatus | "unknown", number>>,
): Omit<WorkspaceTaskSummary, "lastChangedAt"> {
  const byStatus = { ...activePackageTasks, cancelled: 0 };
  return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
}

export function workspaceTaskStatus(task: WorkspaceTaskStatusInput): DomainStatus {
  return task.blockingState === "blocked" && (task.status === "planned" || task.status === "active")
    ? "blocked"
    : task.status;
}

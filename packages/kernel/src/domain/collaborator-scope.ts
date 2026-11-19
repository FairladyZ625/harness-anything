import type { TaskAttribution } from "./canonical-event-summary.ts";

export interface CollaboratorScope {
  readonly scopePersonId?: string;
  readonly filterPersonId?: string;
  readonly filterNodeId?: string;
}

export interface CollaboratorAttribution {
  readonly personId: string | null;
  readonly nodeId: string | null;
}

/** A selected member's lens takes precedence over a view's person filter. Node filters intersect it. */
export function scopedPersonId(scope: CollaboratorScope): string | undefined {
  return scope.scopePersonId ?? scope.filterPersonId;
}

export function matchesCollaboratorScope(
  scope: CollaboratorScope,
  origins: readonly CollaboratorAttribution[],
): boolean {
  const personId = scopedPersonId(scope);
  return (
    (personId === undefined && scope.filterNodeId === undefined) ||
    origins.some(
      (origin) =>
        (personId === undefined || personId === origin.personId) &&
        (scope.filterNodeId === undefined || scope.filterNodeId === origin.nodeId),
    )
  );
}

function taskOrigin(task: Partial<TaskAttribution>): CollaboratorAttribution {
  return { personId: task.createdByPersonId ?? null, nodeId: task.originNodeId ?? null };
}

function taskOperator(task: Partial<TaskAttribution>): CollaboratorAttribution {
  return { personId: task.activeOrLatestPersonId ?? null, nodeId: task.activeOrLatestNodeId ?? null };
}

export function taskMatchesCollaboratorScope(scope: CollaboratorScope, task: Partial<TaskAttribution>): boolean {
  return matchesCollaboratorScope(scope, [taskOrigin(task), taskOperator(task)]);
}

/** Participation preserves visibility. Execution and its timestamp belong to the current operator. */
export function taskMatchesCollaboratorActivity(
  scope: CollaboratorScope,
  task: Partial<TaskAttribution> & { readonly status: string },
): boolean {
  return task.status !== "active" || matchesCollaboratorScope(scope, [taskOperator(task)]);
}

export function collaboratorTaskActivityAt(
  scope: CollaboratorScope,
  task: Partial<TaskAttribution> & { readonly updatedAt: string },
): string | null {
  if (matchesCollaboratorScope(scope, [taskOperator(task)])) return task.activeOrLatestActivityAt ?? task.updatedAt;
  if (matchesCollaboratorScope(scope, [taskOrigin(task)])) return task.originActivityAt ?? task.updatedAt;
  return null;
}

export function effectiveRepositoryMode<Mode extends "local" | "center" | "edge">(
  mode: Mode,
  distinctMemberCount: number,
  attachedNodes: readonly { readonly kind: string }[],
): Mode | "center" {
  return mode === "local" && (distinctMemberCount >= 2 || attachedNodes.some(({ kind }) => kind === "edge"))
    ? "center"
    : mode;
}

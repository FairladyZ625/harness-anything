export type TaskWriteCommandClass = "repo-write" | "arbiter";

export interface TaskWriteCliRoutePolicy {
  readonly actionKind: string;
  readonly leaseRequired: boolean;
  readonly commandClass: TaskWriteCommandClass;
}

export const taskWriteCliRoutePolicies = [
  { actionKind: "task-create", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-start", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-submit", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-review-execution", leaseRequired: false, commandClass: "arbiter" },
  { actionKind: "task-complete", leaseRequired: false, commandClass: "arbiter" },
] as const satisfies ReadonlyArray<TaskWriteCliRoutePolicy>;

export function taskWriteCliRoutePolicy(actionKind: string): TaskWriteCliRoutePolicy | undefined {
  return taskWriteCliRoutePolicies.find((policy) => policy.actionKind === actionKind);
}

export type TaskWriteCommandClass = "repo-write" | "arbiter";

export interface TaskWriteApiRoutePolicy {
  readonly id: string;
  readonly method: "POST";
  readonly path: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly errorSchemaId: string;
  readonly service: "LocalControllerService";
  readonly serviceMethod: "setTaskStatus" | "reviewTask" | "appendTaskProgress";
  readonly auth: "local-session-token";
  readonly guiBridgeMethod: "setTaskStatus" | "reviewTask" | "appendTaskProgress";
  readonly leaseRequired: true;
  readonly commandClass: TaskWriteCommandClass;
}

export interface TaskWriteCliRoutePolicy {
  readonly actionKind: string;
  readonly leaseRequired: boolean;
  readonly commandClass: TaskWriteCommandClass;
}

export const taskWriteApiRoutePolicies = [
  {
    id: "tasks.status.set",
    method: "POST",
    path: "/api/tasks/:taskId/status",
    inputSchemaId: "application.set-task-status-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "setTaskStatus",
    auth: "local-session-token",
    guiBridgeMethod: "setTaskStatus",
    leaseRequired: true,
    commandClass: "arbiter"
  },
  {
    id: "tasks.review",
    method: "POST",
    path: "/api/tasks/:taskId/review",
    inputSchemaId: "application.task-id-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "reviewTask",
    auth: "local-session-token",
    guiBridgeMethod: "reviewTask",
    leaseRequired: true,
    commandClass: "arbiter"
  },
  {
    id: "tasks.progress.append",
    method: "POST",
    path: "/api/tasks/:taskId/progress",
    inputSchemaId: "application.append-task-progress-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "appendTaskProgress",
    auth: "local-session-token",
    guiBridgeMethod: "appendTaskProgress",
    leaseRequired: true,
    commandClass: "repo-write"
  }
] as const satisfies ReadonlyArray<TaskWriteApiRoutePolicy>;

export const taskWriteCliRoutePolicies = [
  { actionKind: "new-task", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "status-set", leaseRequired: true, commandClass: "arbiter" },
  { actionKind: "progress-append", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-amend", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-contract-migrate", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-archive", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-claim", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-code-doc-reconcile", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-complete", leaseRequired: true, commandClass: "arbiter" },
  { actionKind: "task-delete", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-relate", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-release", leaseRequired: false, commandClass: "repo-write" },
  { actionKind: "task-reopen", leaseRequired: true, commandClass: "repo-write" },
  { actionKind: "task-review", leaseRequired: true, commandClass: "arbiter" },
  { actionKind: "task-supersede", leaseRequired: true, commandClass: "repo-write" }
] as const satisfies ReadonlyArray<TaskWriteCliRoutePolicy>;

export function taskWriteCliRoutePolicy(actionKind: string): TaskWriteCliRoutePolicy | undefined {
  return taskWriteCliRoutePolicies.find((policy) => policy.actionKind === actionKind);
}

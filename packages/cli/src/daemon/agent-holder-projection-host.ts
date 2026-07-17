import {
  makeAgentHolderProjectionService,
  makeRuntimeEventAppendPromise,
  makeRuntimeEventLedgerService,
  makeTaskHolderService,
  type AgentRuntimeControlService,
  type TaskHolderService,
  type TaskHolderServiceOptions
} from "../../../application/src/index.ts";
import {
  queryExecutions,
  queryTaskProjection,
  type HarnessLayoutOverrides
} from "../../../kernel/src/index.ts";
import { makeLocalAgentRuntimeControllerOptions } from "./agent-runtime-control-host.ts";
import { makeDaemonQueuedOperationalWriteCoordinator } from "./queued-write-coordinator.ts";

export function makeLocalAgentHolderServices(
  rootDir: string,
  layoutOverrides: HarnessLayoutOverrides | undefined,
  runtime: Parameters<typeof makeDaemonQueuedOperationalWriteCoordinator>[0]
) {
  const appendRuntimeEvent = makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({
    rootInput: { rootDir, layoutOverrides },
    coordinator: makeDaemonQueuedOperationalWriteCoordinator(runtime, "runtime-event-protocol", {
      scope: "operational",
      kind: "system",
      id: "daemon-runtime"
    })
  }));
  const appendLeaseEvent: NonNullable<TaskHolderServiceOptions["appendLeaseEvent"]> = appendRuntimeEvent;
  const taskHolderService = makeTaskHolderService({ rootInput: { rootDir, layoutOverrides }, appendLeaseEvent });
  const agentRuntimeControllerOptions = makeLocalAgentRuntimeControllerOptions(rootDir);
  return {
    appendRuntimeEvent,
    taskHolderService,
    agentRuntimeControllerOptions,
    agentHolderProjection: makeLocalAgentHolderProjection(
      rootDir,
      layoutOverrides,
      taskHolderService,
      agentRuntimeControllerOptions.agentRuntimeControl
    )
  };
}

export function makeLocalAgentHolderProjection(
  rootDir: string,
  layoutOverrides: HarnessLayoutOverrides | undefined,
  taskHolders: TaskHolderService,
  runtimeControl: AgentRuntimeControlService
) {
  return makeAgentHolderProjectionService({
    listTaskIds: () => queryTaskProjection({ rootDir, layoutOverrides, filters: {} }).rows.map((task) => task.taskId),
    listExecutions: () => queryExecutions({ rootDir, layoutOverrides }),
    taskHolders,
    runtimeControl
  });
}

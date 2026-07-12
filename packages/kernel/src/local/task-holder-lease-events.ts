import type { ActorAxes } from "../schemas/actor-attribution.ts";
import type { RuntimeLeaseEvent } from "../schemas/runtime-event.ts";
import type { ExecutionLeaseRecord, TaskHolderPrincipal } from "./task-holder-state.ts";

export interface ExecutionLeaseRuntimeEvent {
  readonly kind: "lease";
  readonly actor: ActorAxes;
  readonly session: {
    readonly sessionId: string;
    readonly runtime: "unknown";
    readonly taskId: string;
    readonly executionId: string;
  };
  readonly lease: RuntimeLeaseEvent;
}

export type ExecutionLeaseEventSink = (event: ExecutionLeaseRuntimeEvent) => Promise<void>;

export function executionLeaseRuntimeEvent(
  record: ExecutionLeaseRecord,
  action: RuntimeLeaseEvent["action"],
  phase: RuntimeLeaseEvent["phase"],
  options: {
    readonly releasedAt?: string | null;
    readonly previousHolder?: TaskHolderPrincipal | null;
  } = {}
): ExecutionLeaseRuntimeEvent {
  return {
    kind: "lease",
    actor: actorAxes(record.holder),
    session: {
      sessionId: `lease-${record.executionId}`,
      runtime: "unknown",
      taskId: record.taskId,
      executionId: record.executionId
    },
    lease: {
      action,
      taskId: record.taskId,
      executionId: record.executionId,
      phase,
      acquiredVia: record.acquiredVia,
      acquiredAt: record.acquiredAt,
      leaseExpiresAt: record.leaseExpiresAt,
      releasedAt: options.releasedAt ?? record.releasedAt,
      updatedAt: record.updatedAt,
      version: record.version,
      previousHolder: options.previousHolder ? actorAxes(options.previousHolder) : null
    }
  };
}

export async function emitExecutionLeaseEvents(
  sink: ExecutionLeaseEventSink | undefined,
  events: ReadonlyArray<ExecutionLeaseRuntimeEvent>
): Promise<void> {
  if (!sink) return;
  for (const event of events) await sink(event);
}

function actorAxes(holder: TaskHolderPrincipal): ActorAxes {
  return {
    principal: { kind: "person", personId: holder.principal.personId },
    executor: holder.executor
  };
}

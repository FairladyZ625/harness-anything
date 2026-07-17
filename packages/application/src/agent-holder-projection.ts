import type {
  ExecutionProjectionRow,
  LocalControllerFailure,
  TaskHolderService,
  TaskHolderSnapshot
} from "./index.ts";
import type {
  AgentRuntimeControlService,
  AgentRuntimeSessionStatus
} from "./agent-runtime-control.ts";
import { isRecord } from "./record.ts";

export interface AgentHolderProjectionQuery {
  readonly taskId?: string;
}

export interface AgentHolderRuntimeProjection {
  readonly runtimeSessionId: string;
  readonly kindId: string;
  readonly process: "alive" | "exited" | "unknown";
  readonly attachable: boolean;
  readonly association: "client-asserted";
}

export interface AgentHolderProjectionRow {
  readonly taskId: string;
  readonly executionId: string | null;
  readonly executionState: string | "unknown";
  readonly principalPersonId: string | null;
  readonly executorAgentId: string | null;
  readonly identityMatch: "matched" | "mismatched" | "unknown";
  readonly lease: {
    readonly state: "active" | "expired" | "missing";
    readonly expiresAt: string | null;
    readonly orphan: boolean;
  };
  readonly runtimes: ReadonlyArray<AgentHolderRuntimeProjection>;
  readonly sources: {
    readonly lease: boolean;
    readonly execution: boolean;
    readonly runtime: boolean;
  };
  readonly completeness: "complete" | "partial";
}

export interface AgentHolderProjectionSuccess {
  readonly ok: true;
  readonly schema: "agent-holder-projection/v1";
  readonly rebuildable: true;
  readonly rows: ReadonlyArray<AgentHolderProjectionRow>;
}
export type AgentHolderProjectionResult = AgentHolderProjectionSuccess | LocalControllerFailure;

export interface AgentHolderProjectionService {
  readonly query: (input?: AgentHolderProjectionQuery) => Promise<AgentHolderProjectionSuccess>;
}

export interface AgentHolderProjectionServiceOptions {
  readonly listTaskIds: () => ReadonlyArray<string>;
  readonly listExecutions: () => ReadonlyArray<ExecutionProjectionRow>;
  readonly taskHolders: TaskHolderService;
  readonly runtimeControl: AgentRuntimeControlService;
}

export function makeAgentHolderProjectionService(
  options: AgentHolderProjectionServiceOptions
): AgentHolderProjectionService {
  return {
    query: async (input = {}) => {
      const executions = options.listExecutions().filter((execution) => execution.state === "active");
      const runtimeResult = await options.runtimeControl.status();
      const sessions = runtimeResult.ok ? runtimeResult.sessions : [];
      const taskIds = new Set(options.listTaskIds());
      for (const execution of executions) taskIds.add(execution.taskId);
      for (const session of sessions) {
        if (session.clientBinding?.taskId) taskIds.add(session.clientBinding.taskId);
      }
      for (const lease of await options.taskHolders.executionLeases()) taskIds.add(lease.taskId);
      if (input.taskId) taskIds.add(input.taskId);

      const holders = await Promise.all([...taskIds].sort().map((taskId) => options.taskHolders.holder({ taskId })));
      return projectAgentHolders({
        holders,
        executions,
        sessions,
        ...(input.taskId ? { taskId: input.taskId } : {})
      });
    }
  };
}

export function projectAgentHolders(input: {
  readonly holders: ReadonlyArray<TaskHolderSnapshot>;
  readonly executions: ReadonlyArray<ExecutionProjectionRow>;
  readonly sessions: ReadonlyArray<AgentRuntimeSessionStatus>;
  readonly taskId?: string;
}): AgentHolderProjectionSuccess {
  const holderByTask = new Map(input.holders.map((holder) => [holder.taskId, holder]));
  const keys = new Map<string, { readonly taskId: string; readonly executionId: string | null }>();
  const addKey = (taskId: string, executionId: string | null) => {
    if (!input.taskId || input.taskId === taskId) keys.set(`${taskId}\0${executionId ?? ""}`, { taskId, executionId });
  };

  for (const holder of input.holders) {
    if (!holder.holder) continue;
    const executionId = holder.holder.schema === "task-holder/v2"
      ? holder.holder.executionId
      : selectExecution(input.executions, holder.taskId, null)?.executionId ?? null;
    addKey(holder.taskId, executionId);
  }
  for (const execution of input.executions) addKey(execution.taskId, execution.executionId);
  for (const session of input.sessions) {
    const binding = session.clientBinding;
    if (binding?.taskId) addKey(binding.taskId, binding.executionId ?? null);
  }
  if (input.taskId && ![...keys.values()].some((key) => key.taskId === input.taskId)) addKey(input.taskId, null);

  const rows = [...keys.values()].map((key) => {
    const holder = holderByTask.get(key.taskId);
    const execution = selectExecution(input.executions, key.taskId, key.executionId);
    const executionId = key.executionId ?? execution?.executionId ?? null;
    const runtimes = input.sessions
      .filter((session) => runtimeMatches(session, key.taskId, executionId))
      .sort((left, right) => left.runtimeSessionId.localeCompare(right.runtimeSessionId))
      .map(projectRuntime);
    const leaseIdentity = holder?.holder?.holder;
    const executionIdentity = executionActor(execution);
    const principalPersonId = leaseIdentity?.principal.personId ?? executionIdentity.principalPersonId;
    const executorAgentId = leaseIdentity?.executor?.id ?? executionIdentity.executorAgentId;
    const hasLease = Boolean(holder?.holder);
    const leaseExpired = hasLease && (!holder?.effectiveHolder || Boolean(holder?.orphan));
    const sources = { lease: hasLease, execution: Boolean(execution), runtime: runtimes.length > 0 };
    return {
      taskId: key.taskId,
      executionId,
      executionState: execution?.state ?? "unknown",
      principalPersonId,
      executorAgentId,
      identityMatch: identityMatch(leaseIdentity, executionIdentity),
      lease: {
        state: hasLease ? (leaseExpired ? "expired" : "active") : "missing",
        expiresAt: holder?.leaseExpiresAt ?? null,
        orphan: holder?.orphan ?? false
      },
      runtimes,
      sources,
      completeness: sources.lease && sources.execution && sources.runtime ? "complete" : "partial"
    } satisfies AgentHolderProjectionRow;
  }).sort((left, right) => left.taskId.localeCompare(right.taskId) || (left.executionId ?? "").localeCompare(right.executionId ?? ""));

  return { ok: true, schema: "agent-holder-projection/v1", rebuildable: true, rows };
}

function selectExecution(
  executions: ReadonlyArray<ExecutionProjectionRow>,
  taskId: string,
  executionId: string | null
): ExecutionProjectionRow | undefined {
  const candidates = executions.filter((execution) => execution.taskId === taskId);
  if (executionId) return candidates.find((execution) => execution.executionId === executionId);
  return [...candidates].sort((left, right) => right.claimedAt.localeCompare(left.claimedAt) || right.executionId.localeCompare(left.executionId))[0];
}

function runtimeMatches(session: AgentRuntimeSessionStatus, taskId: string, executionId: string | null): boolean {
  const binding = session.clientBinding;
  if (!binding) return false;
  if (binding.executionId && executionId) return binding.executionId === executionId;
  return binding.taskId === taskId && !binding.executionId;
}

function projectRuntime(session: AgentRuntimeSessionStatus): AgentHolderRuntimeProjection {
  return {
    runtimeSessionId: session.runtimeSessionId,
    kindId: session.kindId,
    process: session.process.state,
    attachable: session.attachable,
    association: "client-asserted"
  };
}

function executionActor(execution: ExecutionProjectionRow | undefined): {
  readonly principalPersonId: string | null;
  readonly executorAgentId: string | null;
} {
  if (!execution || !isRecord(execution.primaryActor)) return { principalPersonId: null, executorAgentId: null };
  const principal = isRecord(execution.primaryActor.principal) ? execution.primaryActor.principal : undefined;
  const executor = isRecord(execution.primaryActor.executor) ? execution.primaryActor.executor : undefined;
  return {
    principalPersonId: typeof principal?.personId === "string" ? principal.personId : null,
    executorAgentId: typeof executor?.id === "string" ? executor.id : null
  };
}

function identityMatch(
  leaseIdentity: TaskHolderSnapshot["effectiveHolder"] | undefined,
  executionIdentity: ReturnType<typeof executionActor>
): AgentHolderProjectionRow["identityMatch"] {
  if (!leaseIdentity || !executionIdentity.principalPersonId) return "unknown";
  return leaseIdentity.principal.personId === executionIdentity.principalPersonId &&
    (leaseIdentity.executor?.id ?? null) === executionIdentity.executorAgentId
    ? "matched"
    : "mismatched";
}

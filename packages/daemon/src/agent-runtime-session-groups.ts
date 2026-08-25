import { runtimeSessionIsRunning, runtimeSessionSemanticState, type RuntimeSession } from "../../kernel/src/index.ts";
import type {
  AgentRuntimeSessionGroupBy,
  AgentRuntimeSessionGroupDto,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionGroupStatus,
} from "./agent-runtime-contract.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";

export interface AgentRuntimeSessionGroupsQuery {
  readonly groupBy: AgentRuntimeSessionGroupBy;
  readonly since: string;
  readonly tokens: readonly string[];
  readonly limit: number;
}

export function buildAgentRuntimeSessionGroups(input: {
  readonly sessions: readonly RuntimeSession[];
  readonly dispatches: readonly TaskDispatchRow[];
  readonly dispatchStartedAt: ReadonlyMap<string, string>;
  readonly taskLabels: ReadonlyMap<string, string>;
  readonly entityLabel: (kind: "agent" | "squad", id: string) => string | null;
  readonly query: AgentRuntimeSessionGroupsQuery;
  readonly cut: {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeSessionGroupsResult {
  const dispatchBySession = latestDispatches(input.dispatches),
    members = input.sessions.flatMap((session) =>
      membersForSession(
        session,
        dispatchBySession.get(session.runtimeSessionId) ?? null,
        input.dispatchStartedAt.get(session.runtimeSessionId) ?? session.lastObservedAt,
        input,
      ),
    ),
    filtered = members.filter((member) => input.query.tokens.every((token) => member.searchable.includes(token))),
    accumulators = new Map<string, GroupAccumulator>();
  for (const member of filtered) addMember(accumulators, member);
  const allGroups = [...accumulators.values()].map(finishGroup).sort(compareGroups),
    matchingSessions = new Set(filtered.map((member) => member.session.runtimeSessionId)),
    selected = allGroups.slice(0, input.query.limit);
  return {
    ok: true,
    status: input.cut.status,
    groups: selected,
    totals: { groups: allGroups.length, sessions: matchingSessions.size },
    truncated: selected.length < allGroups.length,
    watermark: input.cut.watermark,
    sourceRevision: input.cut.sourceRevision,
  };
}

type GroupIdentity = Pick<AgentRuntimeSessionGroupDto, "key" | "kind" | "label"> &
  Partial<Pick<AgentRuntimeSessionGroupDto, "taskId" | "squadId" | "agentId" | "day">>;
type GroupMember = {
  readonly identity: GroupIdentity;
  readonly session: RuntimeSession;
  readonly dispatch: TaskDispatchRow | null;
  readonly status: AgentRuntimeSessionGroupStatus;
  readonly startedAt: string;
  readonly agentName: string | null;
  readonly searchable: string;
};
type GroupAccumulator = {
  readonly identity: GroupIdentity;
  readonly members: Map<string, GroupMember>;
  readonly rounds: Map<string, GroupMember>;
};

function membersForSession(
  session: RuntimeSession,
  dispatch: TaskDispatchRow | null,
  fallbackStartedAt: string,
  input: Parameters<typeof buildAgentRuntimeSessionGroups>[0],
): readonly GroupMember[] {
  const startedAt = dispatch?.startedAt ?? fallbackStartedAt,
    status = sessionGroupStatus(session, dispatch),
    agentName =
      dispatch?.agentName ??
      (dispatch?.agentId ? (input.entityLabel("agent", dispatch.agentId) ?? dispatch.agentId) : null),
    taskSearch = session.taskBindings.flatMap(({ taskId }) => [taskId, input.taskLabels.get(taskId) ?? taskId]),
    commonSearch = [
      session.runtimeSessionId,
      session.instanceId,
      dispatch?.dispatchId,
      dispatch?.agentId,
      agentName,
      dispatch?.squadId,
      status,
      ...taskSearch,
    ];
  if (input.query.groupBy === "task") {
    if (session.taskBindings.length === 0)
      return [member(unattributed(), session, null, status, startedAt, agentName, commonSearch)];
    const taskIds = [...new Set(session.taskBindings.map(({ taskId }) => taskId))];
    return taskIds.map((taskId) => {
      const taskDispatch = dispatch?.taskId === taskId ? dispatch : null;
      return member(
        { key: taskId, kind: "task", label: input.taskLabels.get(taskId) ?? taskId, taskId },
        session,
        taskDispatch,
        taskDispatch ? status : runtimeSessionSemanticState(session),
        taskDispatch?.startedAt ?? fallbackStartedAt,
        agentName,
        [...commonSearch, taskId, input.taskLabels.get(taskId)],
      );
    });
  }
  if (input.query.groupBy === "squad") {
    const squadId = dispatch?.squadId;
    return [
      member(
        squadId
          ? {
              key: squadId,
              kind: "squad",
              label: input.entityLabel("squad", squadId) ?? squadId,
              squadId,
            }
          : unattributed(),
        session,
        dispatch,
        status,
        startedAt,
        agentName,
        commonSearch,
      ),
    ];
  }
  if (input.query.groupBy === "agent") {
    const agentId = dispatch?.agentId;
    return [
      member(
        agentId
          ? {
              key: agentId,
              kind: "agent",
              label: agentName ?? input.entityLabel("agent", agentId) ?? agentId,
              agentId,
            }
          : { key: `instance:${session.instanceId}`, kind: "agent", label: `Direct (${session.instanceId})` },
        session,
        dispatch,
        status,
        startedAt,
        agentName,
        commonSearch,
      ),
    ];
  }
  const day = startedAt.slice(0, 10);
  return [
    member({ key: day, kind: "day", label: day, day }, session, dispatch, status, startedAt, agentName, commonSearch),
  ];
}

function member(
  identity: GroupIdentity,
  session: RuntimeSession,
  dispatch: TaskDispatchRow | null,
  status: AgentRuntimeSessionGroupStatus,
  startedAt: string,
  agentName: string | null,
  searchable: readonly unknown[],
): GroupMember {
  return {
    identity,
    session,
    dispatch,
    status,
    startedAt,
    agentName,
    searchable: searchable
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase(),
  };
}

function unattributed(): GroupIdentity {
  return { key: "unattributed", kind: "unattributed", label: "Unattributed" };
}

function addMember(groups: Map<string, GroupAccumulator>, member: GroupMember): void {
  const known = groups.get(member.identity.key) ?? {
    identity: member.identity,
    members: new Map<string, GroupMember>(),
    rounds: new Map<string, GroupMember>(),
  };
  const previous = known.members.get(member.session.runtimeSessionId);
  if (!previous || compareMembers(member, previous) < 0) known.members.set(member.session.runtimeSessionId, member);
  if (member.dispatch !== null) known.rounds.set(member.dispatch.dispatchId, member);
  groups.set(member.identity.key, known);
}

function finishGroup(group: GroupAccumulator): AgentRuntimeSessionGroupDto {
  const members = [...group.members.values()],
    rounds = [...group.rounds.values()].sort(compareMembers),
    latest = rounds[0] ?? members.sort(compareMembers)[0] ?? null,
    latestActivityAt = members.reduce(
      (value, member) => (member.session.lastObservedAt > value ? member.session.lastObservedAt : value),
      "1970-01-01T00:00:00.000Z",
    );
  return {
    ...group.identity,
    latestStatus: latest?.status ?? "unknown",
    latestActivityAt,
    runningCount: members.filter((member) => runtimeSessionIsRunning(member.session)).length,
    sessionCount: members.length,
    roundCount: rounds.length,
    latestRound:
      latest === null
        ? null
        : {
            runtimeSessionId: latest.session.runtimeSessionId,
            dispatchId: latest.dispatch?.dispatchId ?? null,
            agentName: latest.agentName,
            instanceId: latest.session.instanceId,
            status: latest.status,
            startedAt: latest.startedAt,
          },
  };
}

function latestDispatches(rows: readonly TaskDispatchRow[]): ReadonlyMap<string, TaskDispatchRow> {
  const result = new Map<string, TaskDispatchRow>();
  for (const row of rows) {
    const known = result.get(row.runtimeSessionId);
    if (!known || row.startedAt > known.startedAt) result.set(row.runtimeSessionId, row);
  }
  return result;
}

function sessionGroupStatus(session: RuntimeSession, dispatch: TaskDispatchRow | null): AgentRuntimeSessionGroupStatus {
  return dispatch?.status ?? runtimeSessionSemanticState(session);
}

function compareMembers(left: GroupMember, right: GroupMember): number {
  return (
    right.startedAt.localeCompare(left.startedAt) ||
    left.session.runtimeSessionId.localeCompare(right.session.runtimeSessionId)
  );
}

function compareGroups(left: AgentRuntimeSessionGroupDto, right: AgentRuntimeSessionGroupDto): number {
  const unattributedOrder = Number(left.kind === "unattributed") - Number(right.kind === "unattributed"),
    runningOrder = Number(right.runningCount > 0) - Number(left.runningCount > 0);
  return (
    unattributedOrder ||
    runningOrder ||
    right.latestActivityAt.localeCompare(left.latestActivityAt) ||
    left.key.localeCompare(right.key)
  );
}

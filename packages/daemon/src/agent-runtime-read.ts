import {
  publicRuntimeSession,
  publicRuntimeInstallation,
  runtimeSessionMissingOutcomeEvidence,
  dispatchLifecycleSummary,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type CanonicalEventStore,
  type RuntimeInstallation,
  type RuntimeSession,
  type TaskProjection,
} from "@harness-anything/kernel";
import type { AgentRuntimeAttemptChainDto } from "./runtime-attempt-contract.ts";
import {
  agentRuntimeSessionGroupStatusWords,
  coded,
  type AgentRuntimeEventsResult,
  type AgentRuntimeInstallationDto,
  type AgentRuntimeOverviewResult,
  type AgentRuntimeSessionDto,
  type AgentRuntimeSessionGroupsResult,
  type AgentRuntimeSessionGroupStatus,
  type AgentRuntimeSessionResult,
} from "./agent-runtime-contract.ts";
import {
  buildAgentRuntimeSessionGroups,
  latestDispatchStartedAt,
  latestEntityNames,
  runtimeTaskLabels,
} from "./agent-runtime-session-groups.ts";
import { runtimeKindForInstallation } from "./runtime-inventory.ts";
import { isRuntimeKindId } from "./runtime-inventory.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import { readRuntimeSessionContextOccupancy } from "./context-occupancy.ts";
import { runtimeSessionSettlement } from "./runtime-settlement.ts";
import { candidateSample, resolveUniquePrefix } from "./unique-id-prefix.ts";

export function makeAgentRuntimeReadModel(input: {
  readonly readDispatch?: (taskId: string, dispatchId: string) => { readonly runtimeSessionId: string } | null;
  readonly readDispatches?: (input: {
    readonly sessions: readonly RuntimeSession[];
    readonly events: readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[];
    readonly shallow?: boolean;
  }) => readonly TaskDispatchRow[];
  readonly readAttemptChain?: (runtimeSessionId: string) => AgentRuntimeAttemptChainDto | undefined;
  readonly projection: TaskProjection;
  readonly store: Pick<CanonicalEventStore, "readContentBlob">;
  /** Harness root holding dispatch streams; without it no session reports context occupancy. */
  readonly rootDir?: string;
  /** Explicit exact-count requests scan the remaining set; ordinary pages use P+1 lookahead. */
  readonly includeRemainingCount?: boolean;
  readonly now?: () => string;
}) {
  const installationDto = (raw: RuntimeInstallation): AgentRuntimeInstallationDto => {
    const installation = publicRuntimeInstallation(raw);
    return {
      installationId: installation.installationId,
      kindId: isRuntimeKindId(installation.kindId) ? installation.kindId : runtimeKindForInstallation(raw).kindId,
      protocolFamily: installation.protocolFamily,
      version: installation.version,
      attachCapability: installation.effectiveCapabilities.includes("attach") ? "supported" : "unsupported",
      lastObservedAt: installation.lastObservedAt,
    };
  };
  // Detail-only reads opt into the expensive joins: the attempt chain and the context-fill
  // probe each cost their own read, and list reads repeat per member.
  const sessionDto = (
    session: RuntimeSession,
    installation: RuntimeInstallation | null | undefined,
    definition: { readonly snapshot: AgentDefinitionSnapshot | null; readonly persisted: boolean },
    detail: { readonly attemptChain?: boolean; readonly context?: boolean },
    _dispatch: Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null,
  ): AgentRuntimeSessionDto => {
    const observedSession = publicRuntimeSession(session),
      lifecycle = dispatchLifecycleSummary(
        input.projection.readDispatchLifecycle({ by: "session", runtimeSessionId: session.runtimeSessionId }),
      ),
      providerUnreachable = lifecycle.policy?.canSteer ? (session.providerUnreachable ?? null) : null,
      outcome = input.projection
        .readRuntimeSessionEventsByType(session.runtimeSessionId, ["runtime_session_outcome_observed"])
        .findLast(
          (event): event is Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> =>
            event.schema === "agent-runtime-event/v1" && event.type === "runtime_session_outcome_observed",
        ),
      metrics = outcome?.payload.runtimeMetrics,
      occupancy =
        detail.context === true && input.rootDir !== undefined
          ? readRuntimeSessionContextOccupancy(input.projection, input.rootDir, session.runtimeSessionId)
          : null,
      attemptChain = detail.attemptChain === true ? input.readAttemptChain?.(session.runtimeSessionId) : undefined,
      installationError = installation
        ? null
        : {
            code: "runtime_installation_not_found" as const,
            hint: `Runtime installation ${session.installationId} was not found.`,
          };
    return {
      runtimeSessionId: session.runtimeSessionId,
      providerSessionId: session.providerSessionId,
      instanceId: session.instanceId,
      installationId: session.installationId,
      kindId: installation
        ? runtimeKindForInstallation(installation).kindId
        : historicalRuntimeKindId(session, definition.snapshot),
      ...(installationError ? { installationState: "missing" as const, installationError } : {}),
      ...(metrics ? { metrics: { ...metrics, compacted: null } } : {}),
      ...(occupancy ? { context: occupancy } : {}),
      definitionSnapshotRef: session.definitionSnapshotRef,
      definitionSnapshot: definition.snapshot,
      definitionSnapshotPersisted: definition.persisted,
      liveness: observedSession.liveness,
      lifecycle,
      // Previous-version display word; removed 2026-12-07. All current consumers use lifecycle.
      semanticState:
        lifecycle.displayStatus === "unknown" ||
        lifecycle.displayStatus === "blocked" ||
        lifecycle.displayStatus === "lost"
          ? "unavailable"
          : lifecycle.displayStatus,
      attachCapability: "unsupported",
      streamCursor: null,
      associations: session.taskBindings.map((binding) => {
        const lease = input.projection.currentLease(binding.taskId),
          actor = lease?.actor;
        return {
          taskId: binding.taskId,
          executionId: binding.executionId,
          holder: actor ? { personId: actor.principal.personId, executorId: actor.executor?.id ?? null } : null,
          lease: lease ? { phase: lease.phase, expiresAt: lease.expiresAt } : null,
        };
      }),
      ...(attemptChain ? { attemptChain } : {}),
      activity: {
        lastObservedAt: observedSession.lastObservedAt,
        outcome: observedSession.outcome,
        exitCode: observedSession.exitCode,
        resultRef: observedSession.resultRef,
        missingEvidence: runtimeSessionMissingOutcomeEvidence(observedSession),
        ...(observedSession.reasonCode ? { reasonCode: observedSession.reasonCode } : {}),
        ...(observedSession.cancelledBy ? { cancelledBy: observedSession.cancelledBy } : {}),
        ...(providerUnreachable === null ? {} : { providerUnreachable }),
      },
    };
  };
  const definitionFor = (
    dispatch: Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null | undefined,
  ): { readonly snapshot: AgentDefinitionSnapshot | null; readonly persisted: boolean } => ({
    snapshot: dispatch?.payload.definitionSnapshot ?? null,
    persisted: dispatch !== null && dispatch !== undefined,
  });
  // Git-style short-id resolution for `ha runtime status <id>`: an exact id reads directly; a
  // unique prefix reads that session; ambiguity lists the candidates instead of guessing.
  const readRuntimeSessionById = (runtimeSessionId: string | null): RuntimeSession | null => {
    if (runtimeSessionId === null) return null;
    const exact = input.projection.readRuntimeSession(runtimeSessionId);
    if (exact !== null) return exact;
    // CLI status accepts the dispatch id printed by `ha task dispatches` as well. A full id is an
    // indexed lookup; only a genuine short-id prefix scans that prefix's bounded id range.
    if (runtimeSessionId.startsWith("dispatch")) {
      const exactDispatch = input.projection.readRuntimeDispatchById(runtimeSessionId)?.event;
      if (exactDispatch) return input.projection.readRuntimeSession(exactDispatch.payload.runtimeSessionId);
      const rows = input.projection.readRuntimeDispatchByDispatchIdPrefix(runtimeSessionId, 100),
        match = resolveUniquePrefix(
          runtimeSessionId,
          rows.map(({ event }) => event.payload.dispatchId),
        );
      if (match.matched) {
        const dispatch = rows.find(({ event }) => event.payload.dispatchId === match.id)!.event;
        return input.projection.readRuntimeSession(dispatch.payload.runtimeSessionId);
      }
      if (match.candidates.length > 1)
        throw coded(
          "runtime_session_ambiguous_id",
          `Dispatch id ${runtimeSessionId} is ambiguous (${candidateSample(match.candidates)}). Use a longer prefix or the full id.`,
        );
    }
    // Primary-key order makes every prefix match adjacent to the prefix, so one keyset page is
    // enough to tell a unique short id from an ambiguous one. The page limit bounds the read;
    // the full session history is never materialized for a status lookup.
    const candidates = input.projection
      .readRuntimeSessionPage({ limit: 8, afterRuntimeSessionId: runtimeSessionId })
      .rows.map(({ runtimeSessionId: candidate }) => candidate)
      .filter((candidate) => candidate.startsWith(runtimeSessionId));
    if (candidates.length === 1) return input.projection.readRuntimeSession(candidates[0]!);
    if (candidates.length > 1)
      throw coded(
        "runtime_session_ambiguous_id",
        `Runtime session id ${runtimeSessionId} is a prefix of at least ${String(candidates.length)} sessions ` +
          `(${candidateSample(candidates)}). Use a longer prefix or the full id.`,
      );
    return null;
  };
  return {
    overview: (payload: Readonly<Record<string, unknown>>): AgentRuntimeOverviewResult => {
      const query = overviewQuery(payload),
        active = query.limit === null && query.taskId === null ? activeLifecycleSessions(input.projection) : null,
        cut = active ?? input.projection.readCut();
      const paged =
        query.limit === null
          ? null
          : input.projection.readRuntimeSessionPage({
              ...(query.taskId === null ? {} : { taskId: query.taskId }),
              limit: query.limit,
              includeRemainingCount: input.includeRemainingCount === true,
              ...(query.afterRuntimeSessionId === null ? {} : { afterRuntimeSessionId: query.afterRuntimeSessionId }),
            });
      const sessions =
        paged?.rows ??
        (query.taskId
          ? input.projection.readRuntimeSessionsForTask(query.taskId)
          : // The unscoped, unpaged overview is the `ha runtime status` default: list what is
            // still running, not every session ever. Scoped reads keep full task history;
            // explicit paging stays the deliberate history lane.
            active!.sessions);
      const installationIds = new Set(sessions.map(({ installationId }) => installationId));
      const installations = input.projection.readRuntimeInstallations();
      const installationsById = new Map(
        installations.map((installation) => [installation.installationId, installation]),
      );
      // One indexed lookup per returned session, never a walk over every dispatch ever recorded:
      // the full-history read parsed the whole set on every overview request (F-28FB7113).
      const dispatchEventFor = (session: RuntimeSession) =>
        input.projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
      return {
        ok: true,
        status: cut.status,
        installations: installations
          .filter((installation) => !query.taskId || installationIds.has(installation.installationId))
          .map(installationDto),
        instances: [],
        sessions: sessions.map((session) => {
          const dispatch = dispatchEventFor(session) ?? null;
          return sessionDto(
            session,
            installationsById.get(session.installationId),
            definitionFor(dispatch),
            {},
            dispatch,
          );
        }),
        ...(paged === null
          ? {}
          : {
              page: {
                limit: query.limit!,
                cursor: query.cursor,
                nextCursor:
                  paged.nextRuntimeSessionId === null ? null : runtimeSessionCursor(paged.nextRuntimeSessionId),
                remainingCount: paged.remainingCount,
              },
            }),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
    sessionGroups: (payload: Readonly<Record<string, unknown>>): AgentRuntimeSessionGroupsResult => {
      const query = sessionGroupsQuery(payload),
        active = query.unsettledOnly ? activeLifecycleSessions(input.projection) : null,
        cut = active ?? input.projection.readCut();
      const sessions =
          active?.sessions ??
          input.projection
            // The home aggregate asks for the current in-flight set: PG serves it from a
            // write-maintained current-set table so settled history (and its dead index entries)
            // never enters the read.
            .readRuntimeSessions({
              activitySince: query.since,
            }),
        // In-flight aggregation reads one newest dispatch per live session, never the session's
        // dispatch history. The full page (not unsettledOnly) still reads the history it renders.
        windowedDispatchEvents = query.unsettledOnly
          ? sessions.flatMap((session) => {
              const latest = input.projection.readLatestRuntimeDispatchBySession(session.runtimeSessionId);
              return latest === null ? [] : [latest];
            })
          : sessions.flatMap((session) =>
              input.projection.readRuntimeDispatchEventsBySession(session.runtimeSessionId),
            ),
        dispatchStartedAt = latestDispatchStartedAt(windowedDispatchEvents),
        // The in-flight aggregation needs the same grouping fields (reviewTarget, agent/squad)
        // as the full page; a shallow row keeps those bounded and drops the task-snapshot,
        // document and delivered/blocked derivations that made this read follow history.
        dispatches =
          input.readDispatches?.({
            sessions,
            events: windowedDispatchEvents,
            ...(query.unsettledOnly ? { shallow: true } : {}),
          }) ?? [],
        taskIds = [
          ...new Set([
            ...sessions.flatMap((session) => session.taskBindings.map(({ taskId }) => taskId)),
            ...dispatches.flatMap((dispatch) => (dispatch.taskId ? [dispatch.taskId] : [])),
          ]),
        ],
        taskLabels = runtimeTaskLabels(input.projection, taskIds),
        // One entity listing per kind, not one getEntity per member: each getEntity opened its
        // own withDatabase, so a 400-member read paid 400 SQLite opens for two small tables.
        entityNames = new Map<string, ReadonlyMap<string, string>>();
      const entityLabel = (kind: "agent" | "squad", id: string): string | null => {
        if (cut.status !== "ready") return null;
        let names = entityNames.get(kind);
        if (names === undefined) {
          names = latestEntityNames(input.projection.listEntities(kind));
          entityNames.set(kind, names);
        }
        return names.get(id) ?? null;
      };
      return buildAgentRuntimeSessionGroups({
        sessions,
        dispatches,
        dispatchEvents: windowedDispatchEvents,
        dispatchStartedAt,
        taskLabels,
        entityLabel,
        query,
        cut,
      });
    },
    session: (payload: Readonly<Record<string, unknown>>): AgentRuntimeSessionResult => {
      const cut = input.projection.readCut(),
        target = runtimeSessionTarget(payload),
        runtimeSessionIdValue =
          target.runtimeSessionId ?? input.readDispatch?.(target.taskId!, target.dispatchId!)?.runtimeSessionId ?? null;
      const session = readRuntimeSessionById(runtimeSessionIdValue);
      if (!session)
        throw coded(
          "runtime_session_not_found",
          target.runtimeSessionId === null
            ? `Runtime dispatch ${target.dispatchId} for task ${target.taskId} has no projected session.`
            : `Runtime session ${runtimeSessionIdValue} was not found.`,
        );
      const dispatch = input.projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef),
        dto = sessionDto(
          session,
          input.projection.readRuntimeInstallation(session.installationId),
          definitionFor(dispatch),
          { attemptChain: true, context: true },
          dispatch,
        ),
        result = resultFor(session);
      return {
        ok: true,
        status: cut.status,
        session: dto,
        result,
        settlement: runtimeSessionSettlement(
          input.projection.readDispatchLifecycle({ by: "session", runtimeSessionId: session.runtimeSessionId }),
          dto,
          result?.text ?? null,
        ),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
    events: (payload: Readonly<Record<string, unknown>>): AgentRuntimeEventsResult => {
      const runtimeSessionIdValue = requiredRuntimeReadField(payload, "runtimeSessionId"),
        after = lifecycleCursor(requiredRuntimeReadField(payload, "afterCursor")),
        source = input.projection.readCut().watermark;
      if (after > source)
        throw coded("invalid_cursor", `Lifecycle cursor lifecycle:${after} is ahead of lifecycle:${source}.`);
      const matching = input.projection.readRuntimeSessionEvents(runtimeSessionIdValue, after, 65),
        selected = matching.slice(0, 64),
        done = selected.length === matching.length,
        end = done ? source : selected.at(-1)!.workspaceRevision;
      return {
        ok: true,
        runtimeSessionId: runtimeSessionIdValue,
        events: selected.map((event) => ({
          cursor: `lifecycle:${event.workspaceRevision}`,
          runtimeSessionId: runtimeSessionIdValue,
          type: event.type,
          occurredAt: event.occurredAt,
        })),
        cursor: `lifecycle:${end}`,
        sourceCursor: `lifecycle:${source}`,
        done,
      };
    },
  };
  function resultFor(session: RuntimeSession): AgentRuntimeSessionResult["result"] {
    if (session.resultRef === null) return null;
    const match = /^artifact:runtime-result\/sha256\/([0-9a-f]{64})$/u.exec(session.resultRef);
    if (!match) throw coded("runtime_result_ref_invalid", `Runtime result reference ${session.resultRef} is invalid.`);
    const bytes = input.store.readContentBlob(match[1]!);
    if (!bytes) throw coded("content_not_ready", `Runtime result ${session.resultRef} is unavailable.`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw coded("runtime_result_invalid", `Runtime result ${session.resultRef} is not UTF-8 text.`);
    }
    return { ref: session.resultRef, text };
  }
}

function historicalRuntimeKindId(
  session: RuntimeSession,
  definition: AgentDefinitionSnapshot | null,
): AgentRuntimeSessionDto["kindId"] {
  const kindId = definition?.kindId ?? session.kindId;
  if (isRuntimeKindId(kindId)) return kindId;
  throw coded("invalid_result", `Runtime session ${session.runtimeSessionId} has an unsupported runtime kind.`);
}

function sessionGroupsQuery(payload: Readonly<Record<string, unknown>>): {
  readonly groupBy: "task" | "squad" | "agent" | "day";
  readonly since: string;
  readonly tokens: readonly string[];
  readonly agentId: string | null;
  readonly squadId: string | null;
  readonly status: readonly AgentRuntimeSessionGroupStatus[];
  readonly sessionIds: readonly string[];
  /** Read only sessions whose canonical outcome is still unset; aggregate "in flight" readers. */
  readonly unsettledOnly: boolean;
  readonly limit: number;
} {
  const keys = Object.keys(payload),
    groupBy = payload.groupBy,
    since = payload.since,
    query = payload.query,
    agentId = payload.agentId,
    squadId = payload.squadId,
    status = payload.status,
    sessionIds = payload.sessionIds,
    unsettledOnly = payload.unsettledOnly,
    limit = payload.limit;
  if (
    keys.some(
      (key) =>
        !["groupBy", "since", "query", "agentId", "squadId", "status", "sessionIds", "unsettledOnly", "limit"].includes(
          key,
        ),
    ) ||
    (groupBy !== undefined && !["task", "squad", "agent", "day"].includes(String(groupBy))) ||
    (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) ||
    (query !== undefined && typeof query !== "string") ||
    (agentId !== undefined && (typeof agentId !== "string" || !agentId)) ||
    (squadId !== undefined && (typeof squadId !== "string" || !squadId)) ||
    (status !== undefined && !isSessionGroupStatusSelection(status)) ||
    (sessionIds !== undefined &&
      (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== "string" || !id))) ||
    (unsettledOnly !== undefined && typeof unsettledOnly !== "boolean") ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1_000))
  )
    throw coded(
      "invalid_request",
      "Agent runtime session groups accept groupBy, ISO since, text query, exact agent/squad ids, " +
        "unsettledOnly, status among " +
        `${agentRuntimeSessionGroupStatusWords.join(", ")}, and limit 1..1000.`,
    );
  return {
    groupBy: groupBy === "squad" || groupBy === "agent" || groupBy === "day" ? groupBy : "task",
    since: typeof since === "string" ? new Date(since).toISOString() : "1970-01-01T00:00:00.000Z",
    tokens: typeof query === "string" ? query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean) : [],
    agentId: typeof agentId === "string" ? agentId : null,
    squadId: typeof squadId === "string" ? squadId : null,
    status: status === undefined ? [] : (status as readonly AgentRuntimeSessionGroupStatus[]),
    sessionIds: sessionIds === undefined ? [] : [...new Set(sessionIds as readonly string[])],
    unsettledOnly: unsettledOnly === true,
    limit: typeof limit === "number" ? limit : 200,
  };
}

/**
 * A status selection is a non-empty array of the group status words. An empty array is rejected
 * rather than read as "no filter": the caller that sends one meant to narrow and would otherwise
 * be handed every session back without being told why.
 */
function isSessionGroupStatusSelection(value: unknown): boolean {
  const words: readonly string[] = agentRuntimeSessionGroupStatusWords;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => typeof entry === "string" && words.includes(entry));
}

function overviewQuery(payload: Readonly<Record<string, unknown>>): {
  readonly taskId: string | null;
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly afterRuntimeSessionId: string | null;
} {
  const keys = Object.keys(payload);
  if (
    keys.some((key) => !["taskId", "limit", "cursor"].includes(key)) ||
    (payload.taskId !== undefined && (typeof payload.taskId !== "string" || !payload.taskId)) ||
    (payload.limit !== undefined &&
      (!Number.isInteger(payload.limit) || (payload.limit as number) < 1 || (payload.limit as number) > 64)) ||
    (payload.cursor !== undefined && (typeof payload.cursor !== "string" || !payload.cursor)) ||
    (payload.cursor !== undefined && payload.limit === undefined)
  ) {
    throw coded(
      "invalid_request",
      "Agent runtime overview accepts optional taskId and a limit/cursor page of at most 64 sessions.",
    );
  }
  const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
  return {
    taskId: typeof payload.taskId === "string" ? payload.taskId : null,
    limit: typeof payload.limit === "number" ? payload.limit : null,
    cursor,
    afterRuntimeSessionId: cursor === null ? null : runtimeSessionIdFromCursor(cursor),
  };
}
function runtimeSessionCursor(runtimeSessionId: string): string {
  return `runtime-session:${encodeURIComponent(runtimeSessionId)}`;
}
function runtimeSessionIdFromCursor(cursor: string): string {
  const match = /^runtime-session:(.+)$/u.exec(cursor);
  if (!match) throw coded("invalid_cursor", `Invalid runtime session cursor: ${cursor}.`);
  try {
    const runtimeSessionId = decodeURIComponent(match[1]!);
    if (!runtimeSessionId) throw new Error("empty");
    return runtimeSessionId;
  } catch {
    throw coded("invalid_cursor", `Invalid runtime session cursor: ${cursor}.`);
  }
}
function requiredRuntimeReadField(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) throw coded("invalid_request", `Agent runtime ${field} is required.`);
  return value;
}
function runtimeSessionTarget(payload: Readonly<Record<string, unknown>>): {
  readonly runtimeSessionId: string | null;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
} {
  const keys = Object.keys(payload);
  if (keys.some((key) => !["runtimeSessionId", "taskId", "dispatchId"].includes(key)))
    throw coded("invalid_request", "Agent runtime session reads accept runtimeSessionId or taskId plus dispatchId.");
  const runtimeSessionId = payload.runtimeSessionId,
    taskId = payload.taskId,
    dispatchId = payload.dispatchId;
  if (runtimeSessionId !== undefined && (typeof runtimeSessionId !== "string" || !runtimeSessionId))
    throw coded("invalid_request", "Agent runtime runtimeSessionId must be non-empty when supplied.");
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId))
    throw coded("invalid_request", "Agent runtime taskId must be non-empty when supplied.");
  if (dispatchId !== undefined && (typeof dispatchId !== "string" || !dispatchId))
    throw coded("invalid_request", "Agent runtime dispatchId must be non-empty when supplied.");
  if (runtimeSessionId === undefined && (taskId === undefined || dispatchId === undefined))
    throw coded("invalid_request", "Agent runtime session reads require runtimeSessionId or taskId plus dispatchId.");
  if (runtimeSessionId !== undefined && (taskId !== undefined || dispatchId !== undefined))
    throw coded(
      "invalid_request",
      "Agent runtime session reads cannot mix runtimeSessionId with taskId or dispatchId.",
    );
  return {
    runtimeSessionId: typeof runtimeSessionId === "string" ? runtimeSessionId : null,
    taskId: typeof taskId === "string" ? taskId : null,
    dispatchId: typeof dispatchId === "string" ? dispatchId : null,
  };
}
function lifecycleCursor(value: string): number {
  const match = /^lifecycle:(\d+)$/u.exec(value),
    revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision)) throw coded("invalid_cursor", `Invalid lifecycle cursor: ${value}.`);
  return revision;
}

/** Active groups are an indexed current set, including backoff and ruling waits. */
function activeLifecycleSessions(projection: TaskProjection) {
  const sessions: RuntimeSession[] = [];
  let cursor: string | undefined;
  for (;;) {
    const read = projection.readDispatchLifecycle({
      by: "active",
      limit: DISPATCH_LIFECYCLE_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (read.status === "pending") return { ...read, sessions: [] };
    for (const row of read.rows) {
      const session = projection.readRuntimeSession(row.attempt.runtimeSessionId);
      if (session !== null) sessions.push(session);
    }
    if (read.nextCursor === null)
      return { status: read.status, watermark: read.watermark, sourceRevision: read.sourceRevision, sessions };
    if (cursor !== undefined && read.nextCursor <= cursor)
      throw coded("invalid_cursor", "Lifecycle active cursor did not advance.");
    cursor = read.nextCursor;
  }
}

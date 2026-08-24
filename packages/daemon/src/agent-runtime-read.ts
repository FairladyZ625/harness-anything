import {
  runtimeSessionSemanticState,
  type AgentDefinitionSnapshot,
  type CanonicalEventStore,
  type RuntimeInstallation,
  type RuntimeSession,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import {
  coded,
  type AgentRuntimeEventsResult,
  type AgentRuntimeInstallationDto,
  type AgentRuntimeOverviewResult,
  type AgentRuntimeSessionDto,
  type AgentRuntimeSessionResult,
} from "./agent-runtime-contract.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { runtimeKindForInstallation } from "./runtime-inventory.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";

export function makeAgentRuntimeReadModel(input: {
  readonly readDispatch?: (
    taskId: string,
    dispatchId: string,
  ) => { readonly runtimeSessionId: string } | null;
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly stream: AgentRuntimeStreamHub;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
}) {
  const synchronize = () => input.projection.readTaskStatuses([]);
  const installationDto = (installation: RuntimeInstallation): AgentRuntimeInstallationDto => ({
    installationId: installation.installationId,
    kindId: runtimeKindForInstallation(installation).kindId,
    protocolFamily: installation.protocolFamily,
    version: installation.version,
    attachCapability: installation.effectiveCapabilities.includes("attach") ? "supported" : "unsupported",
    lastObservedAt: installation.lastObservedAt,
  });
  const sessionDto = (
    session: RuntimeSession,
    installation: RuntimeInstallation | null | undefined,
    definitionSnapshot: AgentDefinitionSnapshot,
  ): AgentRuntimeSessionDto => {
    if (!installation) {
      throw coded("runtime_installation_not_found", `Runtime installation ${session.installationId} was not found.`);
    }
    return {
      runtimeSessionId: session.runtimeSessionId,
      providerSessionId: session.providerSessionId,
      instanceId: session.instanceId,
      installationId: session.installationId,
      kindId: runtimeKindForInstallation(installation).kindId,
      definitionSnapshotRef: session.definitionSnapshotRef,
      definitionSnapshot,
      liveness: session.liveness,
      semanticState: runtimeSessionSemanticState(session),
      attachCapability:
        session.attachable && installation.effectiveCapabilities.includes("attach") ? "supported" : "unsupported",
      streamCursor: input.stream.latestCursor(session.runtimeSessionId),
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
      activity: {
        lastObservedAt: session.lastObservedAt,
        outcome: session.outcome,
        exitCode: session.exitCode,
        resultRef: session.resultRef,
      },
    };
  };
  const definitionFor = (session: RuntimeSession): AgentDefinitionSnapshot => {
    const dispatch = input.projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
    if (!dispatch) {
      throw coded(
        "runtime_definition_snapshot_not_found",
        `Runtime definition snapshot ${session.definitionSnapshotRef} was not found.`,
      );
    }
    return dispatch.payload.definitionSnapshot;
  };
  return {
    overview: (payload: Readonly<Record<string, unknown>>): AgentRuntimeOverviewResult => {
      const query = overviewQuery(payload),
        cut = synchronize();
      const paged =
        query.limit === null
          ? null
          : input.projection.readRuntimeSessionPage({
              ...(query.taskId === null ? {} : { taskId: query.taskId }),
              limit: query.limit,
              ...(query.afterRuntimeSessionId === null ? {} : { afterRuntimeSessionId: query.afterRuntimeSessionId }),
            });
      const sessions =
        paged?.rows ??
        (query.taskId
          ? input.projection.readRuntimeSessionsForTask(query.taskId)
          : input.projection.readRuntimeSessions());
      const installationIds = new Set(sessions.map(({ installationId }) => installationId));
      const installations = input.projection.readRuntimeInstallations();
      return {
        ok: true,
        status: cut.status,
        installations: installations
          .filter((installation) => !query.taskId || installationIds.has(installation.installationId))
          .map(installationDto),
        instances: query.taskId ? [] : [...(input.runtimeInstances?.() ?? [])],
        sessions: sessions.map((session) =>
          sessionDto(
            session,
            installations.find(({ installationId }) => installationId === session.installationId),
            definitionFor(session),
          ),
        ),
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
    session: (payload: Readonly<Record<string, unknown>>): AgentRuntimeSessionResult => {
      const cut = synchronize(),
        target = runtimeSessionTarget(payload),
        runtimeSessionIdValue = target.runtimeSessionId ??
          input.readDispatch?.(target.taskId!, target.dispatchId!)?.runtimeSessionId ??
          null;
      const session =
        runtimeSessionIdValue === null ? null : input.projection.readRuntimeSession(runtimeSessionIdValue);
      if (!session)
        throw coded(
          "runtime_session_not_found",
          target.runtimeSessionId === null
            ? `Runtime dispatch ${target.dispatchId} for task ${target.taskId} has no projected session.`
            : `Runtime session ${runtimeSessionIdValue} was not found.`,
        );
      return {
        ok: true,
        status: cut.status,
        session: sessionDto(
          session,
          input.projection.readRuntimeInstallation(session.installationId),
          definitionFor(session),
        ),
        result: resultFor(session),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
    events: (payload: Readonly<Record<string, unknown>>): AgentRuntimeEventsResult => {
      const runtimeSessionIdValue = requiredRuntimeReadField(payload, "runtimeSessionId"),
        after = lifecycleCursor(requiredRuntimeReadField(payload, "afterCursor")),
        source = input.store.readHead()?.revision ?? 0;
      if (after > source)
        throw coded("invalid_cursor", `Lifecycle cursor lifecycle:${after} is ahead of lifecycle:${source}.`);
      synchronize();
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

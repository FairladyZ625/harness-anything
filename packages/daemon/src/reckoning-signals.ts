import type { CanonicalEventStore, CanonicalEventV1, RuntimeSession, TaskProjection } from "@harness-anything/kernel";

const DAY_MS = 86_400_000,
  SHORT_LIVED_DECISION_MS = 7 * DAY_MS;

export interface ReckoningSignal {
  readonly kind: "abnormal-session" | "corrected-fact" | "short-lived-decision" | "rework";
  readonly key: string;
  readonly occurrences: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ReckoningResult {
  readonly schema: "reckoning-signals/v1";
  readonly generatedAt: string;
  readonly since: string;
  readonly signals: readonly ReckoningSignal[];
}

export function readReckoningSignals(
  store: Pick<CanonicalEventStore, "queryEvents">,
  projection: Pick<TaskProjection, "readRuntimeSessions">,
  generatedAt: string,
  windowHours = 24,
): ReckoningResult {
  const until = Date.parse(generatedAt),
    since = until - windowHours * 3_600_000,
    // A superseded decision is short-lived when accepted up to seven days earlier, so the read reaches that far back.
    oldest = since - SHORT_LIVED_DECISION_MS;
  if (!store.queryEvents) throw new Error("reckoning requires indexed event queries");
  const query = store.queryEvents,
    range = (type: string, after: number) =>
      query({
        type,
        after: new Date(after).toISOString(),
        before: new Date(until).toISOString(),
        limit: Number.MAX_SAFE_INTEGER,
      }),
    // ledgerSignals reads exactly these types; accepts reach back so a superseded decision's lifetime is known.
    events = [
      ...range("fact_recorded", since),
      ...range("decision_superseded", since),
      ...range("decision_retired", since),
      ...range("decision_accepted", oldest),
    ];
  events.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
  return collectReckoningSignals({ events, sessions: projection.readRuntimeSessions(), since, until });
}

export function collectReckoningSignals(input: {
  readonly events: readonly CanonicalEventV1[];
  readonly sessions: readonly RuntimeSession[];
  readonly since: number;
  readonly until: number;
}): ReckoningResult {
  const generatedAt = new Date(input.until).toISOString(),
    sinceIso = new Date(input.since).toISOString(),
    sessions = input.sessions.filter((session) => {
      const observedAt = Date.parse(session.lastObservedAt);
      return observedAt >= input.since && observedAt <= input.until;
    });
  return {
    schema: "reckoning-signals/v1",
    generatedAt,
    since: sinceIso,
    signals: [...runtimeSignals(sessions), ...ledgerSignals(input.events, input.since, input.until)],
  };
}

function runtimeSignals(sessions: readonly RuntimeSession[]): ReckoningSignal[] {
  const abnormal = new Map<string, string[]>(),
    attempts = new Map<string, RuntimeSession[]>();
  for (const session of sessions) {
    if (session.outcome && session.outcome !== "succeeded" && !principalCancelled(session)) {
      const key = `runtime:${session.instanceId}:${session.outcome}`;
      abnormal.set(key, [...(abnormal.get(key) ?? []), session.runtimeSessionId]);
    }
    for (const binding of session.taskBindings) {
      const key = `${binding.taskId}:${binding.executionId}:${session.instanceId}`;
      attempts.set(key, [...(attempts.get(key) ?? []), session]);
    }
  }
  const abnormalSignals = [...abnormal].map(([key, runtimeSessionIds]) => ({
      kind: "abnormal-session" as const,
      key,
      occurrences: runtimeSessionIds.length,
      evidence: { runtimeSessionIds },
    })),
    reworkSignals = [...attempts].flatMap(([key, values]) => {
      const repeated = values.filter(
        (session) => session.outcome && session.outcome !== "succeeded" && !principalCancelled(session),
      );
      if (repeated.length < 2) return [];
      return [
        {
          kind: "rework" as const,
          key: `execution:${key}`,
          occurrences: repeated.length,
          evidence: { runtimeSessionIds: repeated.map((session) => session.runtimeSessionId) },
        },
      ];
    });
  return [...abnormalSignals, ...reworkSignals];
}

function principalCancelled(session: RuntimeSession): boolean {
  return session.outcome === "cancelled" && session.cancelledBy?.principal !== undefined;
}

function ledgerSignals(events: readonly CanonicalEventV1[], since: number, until: number): ReckoningSignal[] {
  const accepted = new Map<string, string>(),
    signals: ReckoningSignal[] = [];
  for (const event of events) {
    const occurredAt = Date.parse(event.occurredAt),
      entity = "entity" in event ? event.entity : undefined,
      entityId = entity && "id" in entity ? String(entity.id) : undefined;
    if (event.type === "decision_accepted" && entityId) accepted.set(entityId, event.occurredAt);
    if (occurredAt < since || occurredAt > until) continue;
    if (event.type === "fact_recorded") {
      const supersedes = event.payload.supersedes?.factRef;
      if (typeof supersedes === "string")
        signals.push({
          kind: "corrected-fact",
          key: supersedes,
          occurrences: 1,
          evidence: {
            supersededFactRef: supersedes,
            replacingFactId: entityId,
            workspaceRevision: event.workspaceRevision,
          },
        });
    }
    if ((event.type === "decision_superseded" || event.type === "decision_retired") && entityId) {
      const acceptedAt = accepted.get(entityId),
        lifetime = acceptedAt === undefined ? Number.NaN : occurredAt - Date.parse(acceptedAt);
      if (lifetime >= 0 && lifetime < SHORT_LIVED_DECISION_MS)
        signals.push({
          kind: "short-lived-decision",
          key: `decision:${entityId}`,
          occurrences: 1,
          evidence: { decisionId: entityId, lifetimeHours: Math.round(lifetime / 3_600_000) },
        });
    }
  }
  return signals;
}

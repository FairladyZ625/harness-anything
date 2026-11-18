import type { PersistedCanonicalEventV1 } from "./doc-sync.contract.ts";
import { squadRunSubjectEntityIdentity } from "./squad-run.ts";
import { daemonProtocolFleetPolicy } from "./cli-operational-policy.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import { writeSourceNodeId } from "./write-source.ts";

export type CanonicalEventSummary = Readonly<Record<string, unknown>> & {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId?: string;
  readonly factId?: string;
  readonly decisionId?: string;
  readonly actor?: {
    readonly executor?: { readonly id: string };
    readonly principal?: { readonly personId: string };
  };
  readonly payload: Readonly<Record<string, unknown>>;
};

export const SUMMARY_TEXT_LIMIT = 280;

/** The list-row projection of a canonical event. Large event-specific payloads never cross the RPC boundary. */
export function canonicalEventSummary(event: PersistedCanonicalEventV1): CanonicalEventSummary {
  const source = event as unknown as Readonly<Record<string, unknown>>,
    payload = recordOf(source.payload),
    subjectIdentity = squadRunSubjectEntityIdentity(payload?.subject),
    actor = recordOf(source.actor),
    executor = recordOf(actor?.executor),
    witness = recordOf(payload?.witness),
    review = recordOf(payload?.review),
    documentClaims = Array.isArray(payload?.documentClaims)
      ? payload.documentClaims.flatMap((claim) => {
          const path = textOf(recordOf(claim)?.path);
          return path === undefined ? [] : [{ path }];
        })
      : undefined;
  return {
    eventId: String(source.eventId),
    schema: String(source.schema),
    type: String(source.type),
    occurredAt: String(source.occurredAt),
    workspaceRevision: Number(source.workspaceRevision),
    ...optionalText("taskId", source.taskId),
    ...optionalText("factId", source.factId),
    ...optionalText("decisionId", source.decisionId),
    ...(executor && textOf(executor.id) ? { actor: { executor: { id: textOf(executor.id)! } } } : {}),
    payload: compact({
      taskId: textOf(payload?.taskId) ?? subjectIdentity.taskId,
      statement: clippedText(payload?.statement),
      text: clippedText(payload?.text),
      title: clippedText(payload?.title),
      runtimeSessionId: textOf(payload?.runtimeSessionId),
      instanceId: textOf(payload?.instanceId),
      entityKind: textOf(payload?.entityKind),
      entityId: textOf(payload?.entityId),
      witness:
        witness === undefined ? undefined : compact({ gateId: textOf(witness.gateId), result: textOf(witness.result) }),
      review: review === undefined ? undefined : compact({ verdict: textOf(review.verdict) }),
      documentClaims,
    }),
  };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clippedText(value: unknown): string | undefined {
  const text = textOf(value);
  return text === undefined ? undefined : text.slice(0, SUMMARY_TEXT_LIMIT);
}

function optionalText<Key extends "taskId" | "factId" | "decisionId">(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const text = textOf(value);
  return text === undefined ? {} : ({ [key]: text } as Partial<Record<Key, string>>);
}

function compact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Fleet's bounded event header: time/type/title/executor only. It deliberately excludes
 * documentClaims and other large event-specific payloads so a fixed event page cannot be charged
 * for one historical event's full body.
 */
export function canonicalEventFleetSummary(event: PersistedCanonicalEventV1): CanonicalEventSummary {
  const source = event as unknown as Readonly<Record<string, unknown>>,
    payload = recordOf(source.payload),
    actor = recordOf(source.actor),
    executor = recordOf(actor?.executor),
    taskId = textOf(source.taskId) ?? textOf(payload?.taskId),
    executorId = textOf(executor?.id),
    personId = textOf(recordOf(actor?.principal)?.personId);
  return {
    eventId: String(source.eventId ?? ""),
    schema: String(source.schema ?? ""),
    type: String(source.type ?? ""),
    occurredAt: String(source.occurredAt ?? ""),
    workspaceRevision: Number(source.workspaceRevision),
    ...(taskId ? { taskId } : {}),
    source: source.source,
    actor: {
      ...(executorId ? { executor: { id: executorId } } : {}),
      ...(personId ? { principal: { personId } } : {}),
    },
    payload: {
      ...(taskId ? { taskId } : {}),
      ...(textOf(payload?.title) ? { title: clipped(payload?.title) } : {}),
      ...(textOf(payload?.statement) ? { statement: clipped(payload?.statement) } : {}),
      ...(textOf(payload?.text) ? { text: clipped(payload?.text) } : {}),
    },
  };
}
function clipped(value: unknown): string {
  const text = textOf(value) ?? "";
  return text.length <= SUMMARY_TEXT_LIMIT ? text : `${text.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`;
}

export const {
  tasks: FLEET_RECENT_TASK_LIMIT,
  dispatches: FLEET_RECENT_DISPATCH_LIMIT,
  events: FLEET_RECENT_EVENT_LIMIT,
} = daemonProtocolFleetPolicy.defaultValue.fleet.nodeActivityRows;

export interface TaskAttribution {
  readonly createdByPersonId: string | null;
  readonly activeOrLatestPersonId: string | null;
  readonly originNodeId: string | null;
  readonly activeOrLatestNodeId: string | null;
}

export function taskAttribution(
  snapshot: TaskLifecycleSnapshot,
  originNodeId: string | null,
  latestNodeId: string | null,
  latestPersonId: string | null,
): TaskAttribution {
  const createdByPersonId = snapshot.task?.createdBy.principal.personId ?? null;
  return {
    createdByPersonId,
    originNodeId,
    activeOrLatestPersonId: snapshot.lease?.actor.principal.personId ?? latestPersonId ?? createdByPersonId,
    activeOrLatestNodeId: writeSourceNodeId(snapshot.lease?.source) ?? latestNodeId ?? originNodeId,
  };
}

export interface FleetRecentTask {
  readonly taskId: string;
  readonly title: string | null;
  readonly coordinationStatus: string;
  readonly personId: string | null;
  readonly updatedAt: string;
}

export interface FleetRecentDispatch {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly agentId: string | null;
  readonly agentLabel: string | null;
  readonly personId: string | null;
  readonly status: string;
  readonly startedAt: string;
}

/** Source and principal are provenance. The projected node is populated for known runtime sources. */
export interface FleetEventSummary {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly personId: string | null;
  readonly source?: unknown;
  readonly nodeId: string | null;
}

export interface FleetNodeActivity {
  readonly nodeId: string;
  readonly recentTasks: readonly FleetRecentTask[];
  readonly recentDispatches: readonly FleetRecentDispatch[];
  readonly recentEvents: readonly FleetEventSummary[];
}

/** Turn a projected fleet header into the node activity wire fields. */
export function fleetEventSummary(event: Readonly<Record<string, unknown>>): FleetEventSummary {
  const payload = event.payload as Readonly<Record<string, unknown>> | undefined,
    actor = event.actor as { readonly principal?: { readonly personId?: string } } | undefined,
    title = payload?.title ?? payload?.statement ?? payload?.text;
  return {
    eventId: String(event.eventId),
    type: String(event.type),
    occurredAt: String(event.occurredAt),
    workspaceRevision: Number(event.workspaceRevision),
    taskId: typeof event.taskId === "string" ? event.taskId : null,
    title: typeof title === "string" ? title : null,
    personId: actor?.principal?.personId ?? null,
    source: event.source,
    nodeId: typeof event.nodeId === "string" ? event.nodeId : null,
  };
}

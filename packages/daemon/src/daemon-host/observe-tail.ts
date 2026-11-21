import type { FleetNodeActivity } from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import path from "node:path";
import type { DaemonRepoMode, TaskProjection } from "@harness-anything/kernel";
import { daemonConnLogFileStem } from "./conn-log.ts";
import { daemonLifecycleLogPath } from "./lifecycle-log.ts";
import { dispatchStreamPath } from "./dispatch-stream.ts";
import {
  readJsonlTail,
  sameCursor,
  singleJsonlFile,
  snapshotJsonlFiles,
  type JsonlTailFile,
} from "./observe-jsonl-tail.ts";
import { daemonRequestLogPath } from "./request-log.ts";
import { readCollaboratorCadence } from "@harness-anything/application/internal/queries/collaborator-reads.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { DAEMON_OBSERVE_TAIL_SCHEMA } from "./protocol/daemon-protocol-schema-ids.ts";
import {
  type ObserveTailCursor,
  type ObserveTailPayload,
  type ObserveTailResult,
} from "./protocol/daemon-protocol-results.ts";

export { DAEMON_OBSERVE_TAIL_SCHEMA };
export type { ObserveTailCursor, ObserveTailPayload, ObserveTailResult };

const pageSize = 64;

type EventTailPayload = Extract<ObserveTailPayload, { readonly kind: "events" }> & {
  /** Host-only, after the overview's lease read has admitted the viewer. */
  readonly fleetNodeIds?: readonly string[];
};

export async function readObserveTail(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode;
  readonly projection: TaskProjection;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly payload: unknown;
}): Promise<ObserveTailResult> {
  // The payload was judged at the RPC entry (validateObserveTailPayload via validateDaemonRpcCall);
  // every production caller reaches this reader through that boundary.
  const payload = input.payload as ObserveTailPayload,
    base = {
      schema: DAEMON_OBSERVE_TAIL_SCHEMA.id,
      ok: true as const,
      repoId: input.repoId,
      mode: input.mode,
      kind: payload.kind,
      direction: payload.direction,
    };
  if (payload.kind === "events") {
    return buildObserveEventTail(input, payload, { ...base, kind: "events" });
  }
  if (payload.kind === "dispatch") {
    const page = await readJsonlTail(
      payload.kind,
      payload.direction,
      payload.cursor,
      () => singleJsonlFile(dispatchStreamPath(input.rootDir, payload.dispatchId)),
      selectDispatchReplayRecord,
    );
    return { ...base, ...page };
  }
  if (payload.kind === "repo-log" && input.mode === "remote-center")
    return {
      ...base,
      status: "unavailable",
      items: [],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: false,
      unavailable: { reason: "center-request-log-not-wired", centerRevision: null },
    };
  const page = await readJsonlTail(
    payload.kind,
    payload.direction,
    payload.cursor,
    payload.kind === "repo-log"
      ? () => repoLogFiles(input.rootDir)
      : payload.kind === "lifecycle"
        ? () => lifecycleLogFiles(input.userRoot, input.daemonId)
        : () => daemonLogFiles(input.userRoot, input.daemonId),
  );
  return { ...base, ...page };
}

/** Synchronous event-tail facet so a query-only SQLite transaction cannot escape its session. */
export function readObserveEventTail(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode;
  readonly projection: TaskProjection;
  readonly payload: unknown;
}): ObserveTailResult {
  const payload = input.payload as EventTailPayload;
  return buildObserveEventTail(input, payload, {
    schema: DAEMON_OBSERVE_TAIL_SCHEMA.id,
    ok: true,
    repoId: input.repoId,
    mode: input.mode,
    kind: payload.kind,
    direction: payload.direction,
  });
}

function buildObserveEventTail(
  input: {
    readonly repoId: string;
    readonly rootDir: string;
    readonly mode: DaemonRepoMode;
    readonly projection: TaskProjection;
  },
  payload: EventTailPayload,
  base: {
    readonly schema: typeof DAEMON_OBSERVE_TAIL_SCHEMA.id;
    readonly ok: true;
    readonly repoId: string;
    readonly mode: DaemonRepoMode;
    readonly kind: "events";
    readonly direction: ObserveTailPayload["direction"];
  },
): ObserveTailResult {
  return { ...base, ...readEventTail(input.projection, payload) };
}

function readEventTail(projection: TaskProjection, payload: EventTailPayload): EventTailPage {
  if (payload.scopePersonId !== undefined || payload.filterNodeId !== undefined)
    return readScopedEventTail(projection, payload);
  const requested = payload.cursor?.revision,
    maxRevisionSpan = storageReadPolicy.defaultValue.pageSizes.standard;
  if (payload.direction === "follow") {
    const after = requested!,
      scanBefore = after + maxRevisionSpan + 1,
      page = projection.readEventSummaries(after, pageSize + 1, payload.fields, scanBefore, "asc");
    if (after > page.sourceRevision)
      throw observeError(
        "invalid_cursor",
        `Canonical event cursor ${after} is ahead of source revision ${page.sourceRevision}.`,
      );
    const selected = page.events.slice(0, pageSize),
      exhaustedWindow = page.events.length <= pageSize,
      coveredUpper = Math.min(page.watermark, scanBefore - 1),
      // Storage proved no more visible rows exist in (after, coveredUpper], so advance the
      // cursor across bounded filtered intervals without scanning unbounded tail history in one call.
      revision = exhaustedWindow ? Math.max(after, coveredUpper) : selected.at(-1)!.workspaceRevision,
      liveCursor = { kind: "events" as const, revision },
      sourceCursor = { kind: "events" as const, revision: page.sourceRevision };
    return {
      status: page.status,
      items: selected,
      historyCursor: null,
      liveCursor,
      sourceCursor,
      done: page.status === "ready" && exhaustedWindow && sameCursor(liveCursor, sourceCursor),
    };
  }

  const probe = projection.readCut(),
    before = requested ?? probe.watermark + 1;
  if (before > probe.sourceRevision + 1)
    throw observeError(
      "invalid_cursor",
      `Canonical event cursor ${before} is ahead of source revision ${probe.sourceRevision}.`,
    );
  const effectiveUpper = Math.min(probe.watermark + 1, Math.max(0, before)),
    scanAfter = Math.max(0, effectiveUpper - 1 - maxRevisionSpan),
    page = projection.readEventSummaries(
      scanAfter,
      pageSize + 1,
      payload.fleetNodeIds === undefined ? payload.fields : { fleetNodeIds: payload.fleetNodeIds },
      effectiveUpper,
      "desc",
    ),
    hasMoreInWindow = page.events.length > pageSize,
    hasEarlierRevisions = scanAfter > 0,
    hasMore = hasMoreInWindow || hasEarlierRevisions,
    selected = hasMoreInWindow ? page.events.slice(-pageSize) : page.events,
    coveredUpper = Math.min(page.watermark, Math.max(0, effectiveUpper - 1)),
    firstRevision = hasMoreInWindow ? selected[0]!.workspaceRevision : hasEarlierRevisions ? scanAfter + 1 : 0,
    lastRevision =
      requested === undefined
        ? Math.max(selected.at(-1)?.workspaceRevision ?? 0, coveredUpper)
        : (selected.at(-1)?.workspaceRevision ?? coveredUpper);
  return {
    status: page.status,
    items: selected,
    ...(page.fleetActivity === undefined ? {} : { fleetActivity: page.fleetActivity }),
    historyCursor: { kind: "events", revision: firstRevision },
    liveCursor: { kind: "events", revision: lastRevision },
    sourceCursor: { kind: "events", revision: page.sourceRevision },
    done: page.status === "ready" && !hasMore,
  };
}

function readScopedEventTail(projection: TaskProjection, payload: EventTailPayload): EventTailPage {
  const cut = projection.readCut(),
    maxRevisionSpan = storageReadPolicy.defaultValue.pageSizes.standard,
    requested = payload.cursor?.revision;
  if (payload.direction === "follow") {
    const after = requested!;
    if (after > cut.sourceRevision)
      throw observeError(
        "invalid_cursor",
        `Canonical event cursor ${after} is ahead of source revision ${cut.sourceRevision}.`,
      );
    const scanBefore = after + maxRevisionSpan + 1,
      page = readCollaboratorCadence(projection, {
        scopePersonId: payload.scopePersonId,
        filterNodeId: payload.filterNodeId,
        afterRevision: after,
        revisionBound: scanBefore,
        order: "asc",
        limit: pageSize,
      }),
      selected = page.rows.flatMap(({ revision }) => {
        const summary = projection.readEventSummaries(revision - 1, 1).events[0];
        return summary?.workspaceRevision === revision ? [summary] : [];
      }),
      exhaustedWindow = !page.hasMore,
      coveredUpper = Math.min(cut.watermark, scanBefore - 1),
      liveRevision = exhaustedWindow
        ? Math.max(after, coveredUpper)
        : (selected.at(-1)?.workspaceRevision ?? page.rows.at(-1)!.revision),
      liveCursor = { kind: "events" as const, revision: liveRevision },
      sourceCursor = { kind: "events" as const, revision: cut.sourceRevision };
    return {
      status: cut.status,
      items: selected,
      historyCursor: null,
      liveCursor,
      sourceCursor,
      done: cut.status === "ready" && exhaustedWindow && sameCursor(liveCursor, sourceCursor),
    };
  }
  const before = requested ?? cut.watermark + 1;
  if (before > cut.sourceRevision + 1)
    throw observeError(
      "invalid_cursor",
      `Canonical event cursor ${before} is ahead of source revision ${cut.sourceRevision}.`,
    );
  const effectiveUpper = Math.min(cut.watermark + 1, Math.max(0, before)),
    scanAfter = Math.max(0, effectiveUpper - 1 - maxRevisionSpan),
    page = readCollaboratorCadence(projection, {
      scopePersonId: payload.scopePersonId,
      filterNodeId: payload.filterNodeId,
      afterRevision: scanAfter,
      revisionBound: effectiveUpper,
      order: "desc",
      limit: pageSize,
    }),
    selected = page.rows.toReversed().flatMap(({ revision }) => {
      const summary = projection.readEventSummaries(revision - 1, 1).events[0];
      return summary?.workspaceRevision === revision ? [summary] : [];
    }),
    hasMoreInWindow = page.hasMore,
    hasEarlierRevisions = scanAfter > 0,
    hasMore = hasMoreInWindow || hasEarlierRevisions,
    coveredUpper = Math.min(cut.watermark, Math.max(0, effectiveUpper - 1)),
    firstRevision = hasMoreInWindow ? page.rows.at(-1)!.revision : hasEarlierRevisions ? scanAfter + 1 : 0,
    lastRevision =
      requested === undefined
        ? Math.max(selected.at(-1)?.workspaceRevision ?? 0, coveredUpper)
        : (selected.at(-1)?.workspaceRevision ?? coveredUpper);
  return {
    status: cut.status,
    items: selected,
    historyCursor: { kind: "events", revision: firstRevision },
    liveCursor: { kind: "events", revision: lastRevision },
    sourceCursor: { kind: "events", revision: cut.sourceRevision },
    done: cut.status === "ready" && !hasMore,
  };
}

function repoLogFiles(rootDir: string): readonly JsonlTailFile[] {
  const live = daemonRequestLogPath(rootDir),
    dir = path.dirname(live),
    base = path.basename(live),
    pattern = new RegExp(`^${escapeRegExp(base)}(?:\\.(\\d+))?$`, "u");
  return snapshotJsonlFiles(dir, (name) => {
    const match = pattern.exec(name);
    return match ? ["repo", Number(match[1] ?? 0)] : null;
  });
}

/** Retained generations of the daemon's own lifecycle JSONL, newest generation last. */
function lifecycleLogFiles(userRoot: string, daemonId: string): readonly JsonlTailFile[] {
  const live = daemonLifecycleLogPath(userRoot, daemonId),
    dir = path.dirname(live),
    base = path.basename(live),
    pattern = new RegExp(`^${escapeRegExp(base)}(?:\\.(\\d+))?$`, "u");
  return snapshotJsonlFiles(dir, (name) => {
    const match = pattern.exec(name);
    return match ? ["lifecycle", Number(match[1] ?? 0)] : null;
  });
}

function daemonLogFiles(userRoot: string, daemonId: string): readonly JsonlTailFile[] {
  const dir = path.join(userRoot, "logs"),
    stem = daemonConnLogFileStem(daemonId),
    pattern = new RegExp(`^${escapeRegExp(stem)}(\\d{8})\\.jsonl(?:\\.(\\d+))?$`, "u");
  return snapshotJsonlFiles(dir, (name) => {
    const match = pattern.exec(name);
    return match ? [match[1]!, Number(match[2] ?? 0)] : null;
  });
}

function selectDispatchReplayRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  if (record.kind === "provider_event" && isJsonObject(record.event) && usefulProviderEvent(record.event))
    return record;
  if (record.kind === "process_exit") return record;
  return record.kind === "exit_notification" && record.phase === "finished" ? record : null;
}

function usefulProviderEvent(event: Readonly<Record<string, unknown>>): boolean {
  const type = event.type,
    message = isJsonObject(event.message) ? event.message : null,
    content = message && Array.isArray(message.content) ? message.content.filter(isJsonObject) : [],
    payload = isJsonObject(event.payload) ? event.payload : null;
  if (type === "assistant")
    return content.some((item) =>
      ["thinking", "text", "tool_use", "server_tool_use", "web_search_tool_result"].includes(String(item.type)),
    );
  if (type === "user")
    return content.some((item) => ["tool_result", "web_search_tool_result"].includes(String(item.type)));
  if (["result", "turn.started", "turn.completed", "turn.failed"].includes(String(type))) return true;
  if (["item.started", "item.completed", "item.updated"].includes(String(type))) {
    const item = isJsonObject(event.item) ? event.item : null;
    return (
      item !== null &&
      [
        "agent_message",
        "reasoning",
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
        "error",
      ].includes(String(item.type))
    );
  }
  if (type === "model.streaming" && payload)
    return ["reasoning_delta", "text_delta", "tool_call"].includes(String(payload.kind));
  if (type === "tool.updated" && payload) return ["result", "error"].includes(String(payload.kind));
  if (["acp.session", "acp.mode", "acp.model", "acp.result", "acp.error"].includes(String(type))) return true;
  if (type === "acp.update") {
    const update = isJsonObject(event.update) ? event.update : null;
    return (
      update !== null &&
      ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
        String(update.sessionUpdate),
      )
    );
  }
  return ["step_update", "result"].includes(String(event.event));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function observeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

type EventTailPage = { readonly fleetActivity?: readonly FleetNodeActivity[] } & (
  | Pick<
      Extract<ObserveTailResult, { readonly status: ProjectionStatus.ReadSetProjectionCut["status"] }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done"
    >
  | Pick<
      Extract<ObserveTailResult, { readonly status: "gap" }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done" | "gap"
    >
);

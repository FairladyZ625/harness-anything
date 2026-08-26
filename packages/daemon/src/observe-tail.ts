import path from "node:path";
import type { CanonicalEventV1, DaemonRepoMode, TaskProjection } from "../../kernel/src/index.ts";
import { daemonConnLogFileStem } from "./conn-log.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { dispatchStreamPath } from "./dispatch-stream.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import {
  readJsonlTail,
  sameCursor,
  singleJsonlFile,
  snapshotJsonlFiles,
  type JsonlTailFile,
} from "./observe-jsonl-tail.ts";
import { daemonRequestLogPath } from "./request-log.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { DAEMON_OBSERVE_TAIL_SCHEMA } from "./protocol/daemon-protocol-schema-ids.ts";
import {
  validateObserveTailPayload,
  type ObserveTailCursor,
  type ObserveTailPayload,
  type ObserveTailResult,
} from "./protocol/daemon-protocol-gui-types.ts";

export { DAEMON_OBSERVE_TAIL_SCHEMA };
export type { ObserveTailCursor, ObserveTailPayload, ObserveTailResult };

const pageSize = 64;

export async function readObserveTail(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode;
  readonly projection: TaskProjection;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly payload: unknown;
}): Promise<ObserveTailResult> {
  const payload = parseObserveTailPayload(input.payload),
    base = {
      schema: DAEMON_OBSERVE_TAIL_SCHEMA.id,
      ok: true as const,
      repoId: input.repoId,
      mode: input.mode,
      kind: payload.kind,
      direction: payload.direction,
    };
  if (payload.kind === "events") {
    if (input.mode === "remote-edge")
      return {
        ...base,
        status: "unavailable",
        items: [],
        historyCursor: null,
        liveCursor: null,
        sourceCursor: null,
        done: false,
        unavailable: {
          reason: "edge-mirror-has-no-events",
          centerRevision: edgeCenterRevision(input.rootDir, input.repoId),
        },
      };
    return { ...base, ...readEventTail(input.projection, payload) };
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
      : () => daemonLogFiles(input.userRoot, input.daemonId),
  );
  return { ...base, ...page };
}

function readEventTail(
  projection: TaskProjection,
  payload: Extract<ObserveTailPayload, { readonly kind: "events" }>,
): EventTailPage {
  const requested = payload.cursor?.revision;
  if (payload.direction === "follow") {
    const after = requested!,
      page = projection.readCanonicalEvents(after, pageSize + 1);
    if (after > page.sourceRevision)
      throw observeError(
        "invalid_cursor",
        `Canonical event cursor ${after} is ahead of source revision ${page.sourceRevision}.`,
      );
    const selected = page.events.slice(0, pageSize),
      revision = selected.at(-1)?.workspaceRevision ?? after,
      liveCursor = { kind: "events" as const, revision },
      sourceCursor = { kind: "events" as const, revision: page.sourceRevision };
    return {
      status: page.status,
      items: selected,
      historyCursor: null,
      liveCursor,
      sourceCursor,
      done: page.status === "ready" && page.events.length <= pageSize && sameCursor(liveCursor, sourceCursor),
    };
  }

  const probe = projection.readCanonicalEvents(0, 1),
    before = requested ?? probe.watermark + 1;
  if (before > probe.sourceRevision + 1)
    throw observeError(
      "invalid_cursor",
      `Canonical event cursor ${before} is ahead of source revision ${probe.sourceRevision}.`,
    );
  const after = Math.max(0, before - pageSize - 1),
    page = projection.readCanonicalEvents(after, pageSize + 1),
    eligible = page.events.filter((event: CanonicalEventV1) => event.workspaceRevision < before),
    selected = eligible.slice(-pageSize),
    firstRevision = selected.at(0)?.workspaceRevision ?? Math.max(0, before - 1),
    lastRevision = selected.at(-1)?.workspaceRevision ?? Math.min(probe.watermark, Math.max(0, before - 1));
  return {
    status: page.status,
    items: selected,
    historyCursor: { kind: "events", revision: firstRevision },
    liveCursor: { kind: "events", revision: lastRevision },
    sourceCursor: { kind: "events", revision: page.sourceRevision },
    done: page.status === "ready" && (selected.length === 0 || firstRevision <= 1),
  };
}

function parseObserveTailPayload(value: unknown): ObserveTailPayload {
  const errors = validateObserveTailPayload(value);
  if (errors.length) throw observeError("invalid_request", errors.join("; "));
  return value as unknown as ObserveTailPayload;
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
    content = message && Array.isArray(message.content) ? message.content.filter(isJsonObject) : [];
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
  return ["step_update", "result"].includes(String(event.event));
}

function edgeCenterRevision(rootDir: string, repoId: string): number | null {
  const config = readFleetEdgeConfig(rootDir);
  return config?.repoId === repoId ? (locateFleetMirrorView(config.viewRoot, repoId)?.revision ?? null) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function observeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

type EventTailPage =
  | Pick<
      Extract<ObserveTailResult, { readonly status: "ready" | "pending" }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done"
    >
  | Pick<
      Extract<ObserveTailResult, { readonly status: "gap" }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done" | "gap"
    >;

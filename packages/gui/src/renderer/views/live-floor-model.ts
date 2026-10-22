import { consumeKnownError } from "../../api/error-consumption.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import { sessionTranscriptTurns } from "../session-transcript-model.ts";
import type { WorkIndex } from "../model/work-collections.ts";

export interface LiveFloorRow {
  readonly session: AgentRuntimeSessionDto;
  readonly taskId: string | null;
  readonly taskTitle: string;
  readonly workKey: string;
  readonly workTitle: string;
  readonly role: "implementation" | "reviewer" | "rework" | "unknown";
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly activityStatus: "progressing" | "waiting_ci" | "stalled" | "unknown";
  readonly dispatch: TaskDispatchProjectionRow | null;
}

export interface LiveFloorWorkGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly LiveFloorRow[];
}

/** Keep the live-session count anchored to runtime liveness; dispatch rows only enrich each row. */
export function liveFloorRows(input: {
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly works: WorkIndex;
}): readonly LiveFloorRow[] {
  const dispatchBySession = new Map<string, TaskDispatchProjectionRow>();
  for (const dispatch of input.dispatches) {
    const current = dispatchBySession.get(dispatch.runtimeSessionId);
    if (current === undefined || (current.status !== "running" && dispatch.status === "running"))
      dispatchBySession.set(dispatch.runtimeSessionId, dispatch);
  }
  return input.sessions
    .filter((session) => session.liveness === "live")
    .map((session) => {
      const dispatch = dispatchBySession.get(session.runtimeSessionId) ?? null,
        taskId = dispatch?.taskId || session.associations[0]?.taskId || null,
        work = taskId === null ? null : input.works.workOf(taskId);
      return {
        session,
        taskId,
        taskTitle: taskId === null ? "" : (input.taskTitles.get(`task/${taskId}`) ?? ""),
        workKey: work === null ? "loose" : `work:${work.taskId}`,
        workTitle: work?.title ?? "",
        role:
          dispatch?.role === "reviewer"
            ? "reviewer"
            : dispatch !== null && dispatch.attemptIndex > 0
              ? "rework"
              : dispatch?.role === "implementation"
                ? "implementation"
                : "unknown",
        model: session.definitionSnapshot?.model ?? dispatch?.provider.model ?? null,
        startedAt: dispatch?.startedAt ?? null,
        activityStatus: dispatch?.activityStatus ?? "unknown",
        dispatch,
      };
    });
}

export function liveFloorWorkGroups(rows: readonly LiveFloorRow[]): readonly LiveFloorWorkGroup[] {
  const groups = new Map<string, LiveFloorWorkGroup>();
  for (const row of rows) {
    const current = groups.get(row.workKey);
    if (current) groups.set(row.workKey, { ...current, rows: [...current.rows, row] });
    else groups.set(row.workKey, { key: row.workKey, title: row.workTitle, rows: [row] });
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(left.key === "loose") - Number(right.key === "loose") || left.title.localeCompare(right.title),
  );
}

/** The existing transcript parser supplies the same concise tool/text summaries as Sessions. */
export function liveFloorActionSummary(records: readonly Readonly<Record<string, unknown>>[]): string | null {
  const item = sessionTranscriptTurns(records).at(-1)?.items.at(-1);
  if (!item) return null;
  if (item.type === "tool_call")
    return [item.label, item.summary.startsWith("{") || item.summary.startsWith("[") ? "" : item.summary]
      .filter(Boolean)
      .join(" · ");
  return item.summary || null;
}

export function readableModelName(model: string | null): string | null {
  if (model === null) return null;
  let selectedModel = model;
  if (model.startsWith("[")) {
    try {
      const tuple: unknown = JSON.parse(model);
      if (!Array.isArray(tuple) || !tuple.every((entry) => typeof entry === "string")) return null;
      selectedModel = tuple.at(-1) ?? "";
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  }
  const name = selectedModel.split("/").at(-1)?.replace(/[-_]+/gu, " ").trim();
  if (!name) return null;
  return name
    .replace(/\b[a-z]/gu, (letter) => letter.toUpperCase())
    .replace(/\bGpt\b/gu, "GPT")
    .replace(/\bClaude\b/gu, "Claude")
    .replace(/\bO([0-9])/gu, "o$1");
}

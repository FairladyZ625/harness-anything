import { consumeKnownError } from "../../api/error-consumption.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { AgendaAwaitsRow, TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import { sessionTranscriptTurns } from "../session-transcript-model.ts";
import type { WorkIndex } from "../model/work-collections.ts";
import type { TaskRow } from "../model/types.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";

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
        role: liveFloorDispatchRole(dispatch),
        model: session.definitionSnapshot?.model ?? dispatch?.provider.model ?? null,
        startedAt: dispatch?.startedAt ?? null,
        activityStatus: dispatch?.activityStatus ?? "unknown",
        dispatch,
      };
    });
}

/** 派工行角色判定:源 role 优先,再走 attemptIndex(第 2+ 轮即返工);只在 GUI 组装行标签。 */
export function liveFloorDispatchRole(
  dispatch: TaskDispatchProjectionRow | null,
): "implementation" | "reviewer" | "rework" | "unknown" {
  if (dispatch?.role === "reviewer") return "reviewer";
  if (dispatch !== null && dispatch.attemptIndex > 0) return "rework";
  return dispatch?.role === "implementation" ? "implementation" : "unknown";
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

// ============ 刚结束 ============

export type LiveFloorEndedConclusion =
  | "delivered"
  | "review_done"
  | "interrupted"
  | "empty_report"
  | "failed"
  | "cancelled"
  | "unknown";

export interface LiveFloorEndedRow {
  readonly session: AgentRuntimeSessionDto;
  readonly taskId: string | null;
  readonly taskTitle: string;
  readonly role: "implementation" | "reviewer" | "rework" | "unknown";
  readonly endedAt: string | null;
  readonly conclusion: LiveFloorEndedConclusion;
  readonly reportPath: string | null;
}

const ENDED_ROW_LIMIT = 12;

/**
 * 最近退出的会话及其结局。会话侧 activity(outcome/missingEvidence)是终局事实;
 * 派工行补角色与报告路径。空报告(今天 DeepSeek 多次出现)优先于 outcome 措辞:
 * 缺结果证据的「成功」不是交付。
 */
export function liveFloorEndedRows(input: {
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly taskTitles: ReadonlyMap<string, string>;
}): readonly LiveFloorEndedRow[] {
  const dispatchBySession = new Map<string, TaskDispatchProjectionRow>();
  for (const dispatch of input.dispatches)
    if (dispatch.reportPath) dispatchBySession.set(dispatch.runtimeSessionId, dispatch);
  return input.sessions
    .filter((session) => session.liveness === "exited")
    .map((session) => {
      const dispatch = dispatchBySession.get(session.runtimeSessionId) ?? null,
        taskId = dispatch?.taskId || session.associations[0]?.taskId || null,
        role = liveFloorDispatchRole(dispatch),
        { outcome, missingEvidence } = session.activity,
        conclusion: LiveFloorEndedConclusion =
          missingEvidence === "result" || missingEvidence === "exit-code-and-result"
            ? "empty_report"
            : outcome === "succeeded"
              ? role === "reviewer"
                ? "review_done"
                : "delivered"
              : outcome === "failed"
                ? "failed"
                : outcome === "cancelled"
                  ? "cancelled"
                  : outcome === "stopped"
                    ? "interrupted"
                    : "unknown";
      return {
        session,
        taskId,
        taskTitle: taskId === null ? "" : (input.taskTitles.get(`task/${taskId}`) ?? ""),
        role,
        endedAt: session.activity.lastObservedAt,
        conclusion,
        reportPath: dispatch?.reportPath ?? null,
      };
    })
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""))
    .slice(0, ENDED_ROW_LIMIT);
}

// ============ 流水线 ============

export type LiveFloorPipelineKey =
  | "implementing"
  | "rework"
  | "delivered"
  | "reviewing"
  | "awaiting_owner"
  | "merge_ready"
  | "done"
  | "queued"
  | "waiting_upstream";

export interface LiveFloorPipelineGroup {
  readonly key: LiveFloorPipelineKey;
  readonly tasks: readonly TaskRow[];
}

export const LIVE_FLOOR_PIPELINE_ORDER: readonly LiveFloorPipelineKey[] = [
  "implementing",
  "rework",
  "delivered",
  "reviewing",
  "awaiting_owner",
  "merge_ready",
  "done",
  "queued",
  "waiting_upstream",
];

const DONE_RECENCY_MS = 7 * 24 * 60 * 60_000;

/**
 * 在做/最近完成的任务按交付阶段排开。阶段判定是 daemon 单点(`repo.tasks.list` 行上的
 * `deliveryStage`);这里只分桶。off-path 行按它自己的状态词归队:planned→排队、
 * blocked→等上游、done(7 天内)→完成。老 daemon 未投影 deliveryStage 时,active/
 * submitted/in_review 按状态词一一对应(daemon 对这三个状态从不给 null,这里的回退
 * 只覆盖 attach 到旧构建的场景,不是第二套判定)。
 */
export function liveFloorPipelineGroups(
  tasks: readonly TaskRow[],
  nowMs = Date.now(),
): readonly LiveFloorPipelineGroup[] {
  const groups = new Map<LiveFloorPipelineKey, TaskRow[]>();
  const put = (key: LiveFloorPipelineKey, task: TaskRow) => groups.set(key, [...(groups.get(key) ?? []), task]);
  for (const task of tasks) {
    if (task.visibility.noise) continue;
    if (task.deliveryStage) {
      put(task.deliveryStage, task);
      continue;
    }
    const status = task.canonicalStatus ?? task.coordinationStatus;
    if (status === "planned") put("queued", task);
    else if (status === "blocked") put("waiting_upstream", task);
    else if (status === "done") {
      if (nowMs - Date.parse(task.lastKnownAt) <= DONE_RECENCY_MS) put("done", task);
    } else if (status === "active") put("implementing", task);
    else if (status === "submitted") put("delivered", task);
    else if (status === "in_review") put("reviewing", task);
  }
  return LIVE_FLOOR_PIPELINE_ORDER.filter((key) => groups.get(key)?.length).map((key) => ({
    key,
    tasks: groups.get(key)!,
  }));
}

// ============ 等你处理 ============

export type LiveFloorAskKind =
  | "ask"
  | "gate"
  | "gate_override"
  | "consent"
  | "decision"
  | "decision_review"
  | "rework"
  | "adjudicate"
  | "pinned";

export interface LiveFloorAskRow {
  readonly key: string;
  readonly kind: LiveFloorAskKind;
  readonly title: string;
  readonly detail: string | null;
  readonly at: string | null;
  readonly taskId: string | null;
  readonly decisionId: string | null;
  /** ask 原行:答复面板(AwaitsAnswerPanel)需要 relationId 与 revision。 */
  readonly ask: AgendaAwaitsRow | null;
}

/** 只放业主才能做的事:待答提问、受保护面签发/同意、裁决、打回重开、派审、置顶挡路项。 */
export function liveFloorAskLanes(input: {
  readonly agenda: {
    readonly awaitingYou: readonly AgendaAwaitsRow[];
    readonly awaitingDecision: readonly { readonly decisionId: string; readonly title: string }[];
    readonly awaitingDecisionReview: readonly { readonly decisionId: string; readonly title: string }[];
    readonly awaitingRework: readonly { readonly taskId: string; readonly title: string }[];
    readonly awaitingAdjudication: readonly { readonly taskId: string; readonly title: string }[];
    readonly pinnedEntities: readonly { readonly ref: string; readonly title: string }[];
  } | null;
  readonly tasks: readonly TaskRow[];
}): readonly LiveFloorAskRow[] {
  const agenda = input.agenda,
    rows: LiveFloorAskRow[] = [];
  const taskIdOf = (ref: string): string | null => /^task\/(.+)$/u.exec(ref)?.[1] ?? null,
    decisionIdOf = (ref: string): string | null => /^decision\/(.+)$/u.exec(ref)?.[1] ?? null;
  for (const ask of agenda?.awaitingYou ?? [])
    rows.push({
      key: `ask:${ask.relationId}`,
      kind: "ask",
      title: ask.title,
      detail: ask.question,
      at: ask.askedAt,
      taskId: taskIdOf(ask.sourceRef),
      decisionId: decisionIdOf(ask.sourceRef),
      ask,
    });
  // 受保护面批准与完成确认:签发总池同一判据(gates signoff_missing/manual-attest、
  // closeoutBlocker=consent),复用 model/attestation-pool.ts,不建第二套判定。
  const lanes = deriveAttestationLanes(input.tasks);
  for (const gate of lanes.gates)
    rows.push({
      key: `gate:${gate.taskId}:${gate.gateId}`,
      kind: "gate",
      title: gate.taskTitle,
      detail: gate.detail ?? gate.gateId,
      at: null,
      taskId: gate.taskId,
      decisionId: null,
      ask: null,
    });
  for (const gate of lanes.breakGlass)
    rows.push({
      key: `gate-override:${gate.taskId}:${gate.gateId}`,
      kind: "gate_override",
      title: gate.taskTitle,
      detail: gate.detail ?? gate.gateId,
      at: null,
      taskId: gate.taskId,
      decisionId: null,
      ask: null,
    });
  for (const consent of lanes.consents)
    rows.push({
      key: `consent:${consent.taskId}`,
      kind: "consent",
      title: consent.taskTitle,
      detail: null,
      at: null,
      taskId: consent.taskId,
      decisionId: null,
      ask: null,
    });
  for (const decision of agenda?.awaitingDecision ?? [])
    rows.push({
      key: `decision:${decision.decisionId}`,
      kind: "decision",
      title: decision.title,
      detail: null,
      at: null,
      taskId: null,
      decisionId: decision.decisionId,
      ask: null,
    });
  for (const decision of agenda?.awaitingDecisionReview ?? [])
    rows.push({
      key: `decision-review:${decision.decisionId}`,
      kind: "decision_review",
      title: decision.title,
      detail: null,
      at: null,
      taskId: null,
      decisionId: decision.decisionId,
      ask: null,
    });
  for (const task of agenda?.awaitingRework ?? [])
    rows.push({
      key: `rework:${task.taskId}`,
      kind: "rework",
      title: task.title,
      detail: null,
      at: null,
      taskId: task.taskId,
      decisionId: null,
      ask: null,
    });
  for (const execution of agenda?.awaitingAdjudication ?? [])
    rows.push({
      key: `adjudicate:${execution.taskId}`,
      kind: "adjudicate",
      title: execution.title,
      detail: null,
      at: null,
      taskId: execution.taskId,
      decisionId: null,
      ask: null,
    });
  for (const pinned of agenda?.pinnedEntities ?? [])
    rows.push({
      key: `pinned:${pinned.ref}`,
      kind: "pinned",
      title: pinned.title,
      detail: null,
      at: null,
      taskId: taskIdOf(pinned.ref),
      decisionId: decisionIdOf(pinned.ref),
      ask: null,
    });
  return rows;
}

/**
 * 派工行 reportPath 是台账根相对(含包前缀);任务文档读面吃包内相对路径。
 * 有包路径就按前缀剥,没有就从 artifacts/ 起(评审报告的固定落点)。
 */
export function liveFloorReportDocPath(reportPath: string, packagePath: string | null | undefined): string | null {
  if (packagePath && reportPath.startsWith(`${packagePath}/`)) return reportPath.slice(packagePath.length + 1);
  const anchor = reportPath.indexOf("artifacts/");
  return anchor >= 0 ? reportPath.slice(anchor) : null;
}

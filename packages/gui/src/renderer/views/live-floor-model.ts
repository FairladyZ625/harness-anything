import { consumeKnownError } from "../../api/error-consumption.ts";
import type { AgentRuntimeSessionDto, TaskDeliveryStage } from "@harness-anything/daemon/protocol";
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
  readonly channel: LiveFloorChannel;
  readonly model: string | null;
  readonly startedAt: string | null;
  /** daemon 派工行的活动判定;null = 旧 daemon 没有该投影。 */
  readonly activityStatus: "thinking" | "tool" | "waiting" | "silent" | "stalled" | "unknown" | null;
  readonly activityObservedAt: string | null;
  readonly activityIdleMinutes: number | null;
  readonly dispatch: TaskDispatchProjectionRow | null;
}

/** 派工通道:同任务的评审与决策评审两行靠它区分,不靠猜重复。 */
export type LiveFloorChannel = "implementation" | "rework" | "review_task" | "review_decision" | "unknown";

/** Keep the live-session count anchored to runtime liveness; dispatch rows only enrich each row. */
export function liveFloorRows(input: {
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly dispatches: readonly TaskDispatchProjectionRow[];
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
        // 标题与 taskId 同源:派工行带的是这条派工所绑任务的标题,分组也按同一个 taskId 查工作。
        taskTitle: dispatch?.taskTitle ?? "",
        workKey: work === null ? "loose" : `work:${work.taskId}`,
        workTitle: work?.title ?? "",
        channel: liveFloorDispatchChannel(dispatch),
        model: session.definitionSnapshot?.model ?? dispatch?.provider.model ?? null,
        startedAt: dispatch?.startedAt ?? null,
        activityStatus: dispatch?.activityStatus ?? null,
        activityObservedAt: dispatch?.activityObservedAt ?? null,
        activityIdleMinutes: dispatch?.activityIdleMinutes ?? null,
        dispatch,
      };
    });
}

/**
 * 派工通道判定:源 role 优先(评审按 reviewTarget 分「评审交付」与「评审决策」两个通道,
 * 同任务两行因此可分辨),再走 attemptIndex(第 2+ 轮即返工);只在 GUI 组装行标签。
 */
export function liveFloorDispatchChannel(dispatch: TaskDispatchProjectionRow | null): LiveFloorChannel {
  if (dispatch?.role === "reviewer")
    return dispatch.reviewTarget?.kind === "decision" ? "review_decision" : "review_task";
  if (dispatch !== null && dispatch.attemptIndex > 0) return "rework";
  return dispatch?.role === "implementation" ? "implementation" : "unknown";
}

export interface LiveFloorWorkGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly LiveFloorRow[];
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

// ============ 此刻在做什么(人话) ============

export type LiveFloorActionVerb =
  | "run_command"
  | "run_test"
  | "edit_file"
  | "read_file"
  | "search_code"
  | "browse"
  | "plan"
  | "git"
  | "message"
  | "tool";

export interface LiveFloorAction {
  readonly verb: LiveFloorActionVerb;
  /** 人话主体:命令头、文件名、搜索词或一句话的开头;提取不到为 null(只剩动词与悬停原文)。 */
  readonly subject: string | null;
  /** 原始最近一条记录,收进悬停/详情,不上屏。 */
  readonly raw: string;
}

/**
 * 最近一条转录条目 →「正在做什么」的人话形状。动词与主体是展示词汇的封闭词集,
 * 渲染层再翻标签;提取(命令、文件名、搜索词、JSON 噪音丢弃)在这里,可测。
 */
export function liveFloorAction(records: readonly Readonly<Record<string, unknown>>[]): LiveFloorAction | null {
  const item = sessionTranscriptTurns(records).at(-1)?.items.at(-1);
  if (!item) return null;
  const raw = item.summary || item.detail;
  // 终局结果文本也以 type "text" 入列(label 是 "result"),不单列一种动词。
  if (item.type === "text" || item.type === "thinking")
    return { verb: "message", subject: firstSentence(item.summary), raw };
  return { verb: verbOf(item.label), subject: subjectOf(item.label, item.detail), raw };
}

function verbOf(label: string): LiveFloorActionVerb {
  const name = label.toLowerCase();
  if (/(^|[^a-z])git([^a-z]|$)/u.test(name) || name.startsWith("git")) return "git";
  if (/bash|shell|command|exec|terminal|local_shell/u.test(name)) return "run_command";
  if (/test|pytest|vitest|jest/u.test(name)) return "run_test";
  if (/web|fetch|browse|http|url/u.test(name)) return "browse";
  if (/edit|write|create|apply|patch|notebook|file[u _]?change/u.test(name)) return "edit_file";
  if (/^read|^view|^open|^cat|^inspect/u.test(name)) return "read_file";
  if (/grep|glob|search|find|\brg\b|list|\bls\b/u.test(name)) return "search_code";
  if (/todo|plan/u.test(name)) return "plan";
  return "tool";
}

function subjectOf(label: string, detail: string): string | null {
  // 工具入参多为 JSON;取决策性字段(命令/文件/搜索词),其余 JSON 噪音不上屏。
  const parsed = parseJsonObject(detail);
  if (parsed !== null) {
    const command = firstString(parsed, ["command", "cmd", "script"]),
      file = firstString(parsed, ["file_path", "filePath", "path", "filename"]),
      terms = firstString(parsed, ["pattern", "query", "question", "prompt", "url", "search"]);
    const value = command ?? terms ?? null,
      fileValue = file === null ? null : (file.split("/").at(-1) ?? null);
    if (value !== null) return clip(value, 60);
    if (fileValue !== null) return clip(fileValue, 60);
    return null;
  }
  if (detail.startsWith("{") || detail.startsWith("[")) return null;
  const fileLike =
    /^\/.*\/([^/]+)$/u.exec(detail.trim()) ?? /^([-\w.]+\.(ts|tsx|md|json|mjs|js))$/iu.exec(detail.trim());
  if (fileLike) return clip(fileLike[1] ?? "", 60) || null;
  return clip(detail, 60);
}

function firstSentence(value: string): string | null {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return null;
  const sentence = /^([^。!?!?…]{1,80}[。!?!?…]?)/u.exec(compact)?.[1] ?? compact.slice(0, 80);
  return clip(sentence, 80);
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  if (!value.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
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
  | "review_rejected"
  | "interrupted"
  | "empty_report"
  | "failed"
  | "cancelled"
  | "unknown";

export interface LiveFloorEndedRow {
  readonly dispatch: TaskDispatchProjectionRow;
  readonly taskId: string | null;
  readonly taskTitle: string;
  readonly channel: LiveFloorChannel;
  readonly endedAt: string | null;
  readonly conclusion: LiveFloorEndedConclusion;
  readonly reportPath: string | null;
}

const ENDED_ROW_LIMIT = 12;
/** 「刚结束」只看 24h:与 daemon 完成窗口同一口径(业主 2026-10-23),旧尾巴不进首屏。 */
export const LIVE_FLOOR_ENDED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * 最近结束的派工及其结局。读的是派工读面(`repo.task.dispatches`),不是 unpaged 运行时
 * 概览——后者按设计只回在跑会话,exited 永远读不到;派工行自带 outcome/reportPath/通道,
 * 并按 executionId 连到任务快照的评审记录拿「评审打回/通过」结论(会话自身看不见 verdict)。
 * 评审结论(第一手记录)优先于空报告检查,空报告优先于成功措辞:缺结果证据的「成功」不是交付。
 */
export function liveFloorEndedRows(input: {
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly tasks: readonly TaskRow[];
  readonly nowMs?: number;
}): readonly LiveFloorEndedRow[] {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task] as const)),
    nowMs = input.nowMs ?? Date.now();
  return input.dispatches
    .flatMap((dispatch) => {
      if (dispatch.endedAt === null || dispatch.outcome === null) return [];
      if (nowMs - Date.parse(dispatch.endedAt) > LIVE_FLOOR_ENDED_WINDOW_MS) return [];
      const channel = liveFloorDispatchChannel(dispatch),
        task = dispatch.taskId ? taskById.get(dispatch.taskId) : undefined,
        review =
          dispatch.executionId === ""
            ? undefined
            : task?.reviews?.find((entry) => entry.executionId === dispatch.executionId),
        execution =
          dispatch.executionId === ""
            ? undefined
            : task?.executions?.find((entry) => entry.executionId === dispatch.executionId);
      let conclusion: LiveFloorEndedConclusion;
      if (channel === "review_task" || channel === "review_decision") {
        if (review?.verdict === "changes_requested" || execution?.state === "changes_requested")
          conclusion = "review_rejected";
        else if (review?.verdict === "approved") conclusion = "review_done";
        else if (dispatch.outcome === "succeeded") conclusion = "review_done";
        else conclusion = outcomeConclusion(dispatch.outcome);
      } else if (dispatch.outcome === "succeeded" && !dispatch.reportPath) conclusion = "empty_report";
      else conclusion = dispatch.outcome === "succeeded" ? "delivered" : outcomeConclusion(dispatch.outcome);
      return [
        {
          dispatch,
          taskId: dispatch.taskId || null,
          taskTitle: dispatch.taskTitle ?? "",
          channel,
          endedAt: dispatch.endedAt,
          conclusion,
          reportPath: dispatch.reportPath ?? null,
        },
      ];
    })
    .sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""))
    .slice(0, ENDED_ROW_LIMIT);
}

function outcomeConclusion(outcome: TaskDispatchProjectionRow["outcome"]): LiveFloorEndedConclusion {
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "stopped") return "interrupted";
  return "unknown";
}

// ============ 流水线 ============

export type LiveFloorPipelineKey = TaskDeliveryStage | "other";

export interface LiveFloorPipelineGroup {
  readonly key: LiveFloorPipelineKey;
  readonly tasks: readonly TaskRow[];
}

export const LIVE_FLOOR_PIPELINE_ORDER: readonly LiveFloorPipelineKey[] = [
  "queued",
  "implementing",
  "rework",
  "delivered",
  "reviewing",
  "awaiting_owner",
  "merge_ready",
  "done",
  "waiting_upstream",
  "other",
];

/**
 * 在做/最近完成的任务按交付阶段排开。阶段词与判定都在 daemon
 * (`repo.tasks.list` 行上的 `deliveryStage`,词表单源 `taskDeliveryStageWords`);
 * 这里只分桶与排序:已知词按展示序排,daemon 未来新增的词落进可见的「其他」桶,
 * 不被顺序过滤静默吞掉;`other` 兜底因此只可能在 daemon 比 GUI 新时出现。
 * 旧 daemon(未投影该字段,undefined)按行自身状态词一一对应;终态 24h 窗是 daemon
 * 的判定,这里不重算,旧构建因此没有「完成」桶。工作根是容器不是在交付的任务,
 * 不进流水线(在干活的分组里它们本来就在)。
 */
export function liveFloorPipelineGroups(
  tasks: readonly TaskRow[],
  works: Pick<WorkIndex, "isWorkRoot"> = { isWorkRoot: () => false },
): readonly LiveFloorPipelineGroup[] {
  const groups = new Map<LiveFloorPipelineKey, TaskRow[]>();
  const put = (key: LiveFloorPipelineKey, task: TaskRow) => groups.set(key, [...(groups.get(key) ?? []), task]);
  for (const task of tasks) {
    if (task.visibility.noise) continue;
    if (works.isWorkRoot(task.taskId)) continue;
    if (task.deliveryStage !== undefined && task.deliveryStage !== null) {
      put(task.deliveryStage, task);
      continue;
    }
    // null 是 daemon 已判不在流水线(取消、超窗终态),不是缺投影——不落状态词回退。
    if (task.deliveryStage === null) continue;
    const status = task.canonicalStatus ?? task.coordinationStatus;
    if (status === "planned") put("queued", task);
    else if (status === "blocked") put("waiting_upstream", task);
    else if (status === "active") put("implementing", task);
    else if (status === "submitted") put("delivered", task);
    else if (status === "in_review") put("reviewing", task);
  }
  // daemon 比本 GUI 新时,词表外的词统一并入可见的「其他」桶;known 不含的词
  // 不进 LIVE_FLOOR_PIPELINE_ORDER,也就不会被顺序过滤静默吞掉。
  const known = new Set<LiveFloorPipelineKey>(LIVE_FLOOR_PIPELINE_ORDER),
    merged = new Map<LiveFloorPipelineKey, TaskRow[]>();
  for (const [key, list] of groups) {
    const bucket = known.has(key) ? key : "other";
    merged.set(bucket, [...(merged.get(bucket) ?? []), ...list]);
  }
  return LIVE_FLOOR_PIPELINE_ORDER.filter((key) => merged.get(key)?.length).map((key) => ({
    key,
    tasks: merged.get(key)!,
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
  | "legacySubmitted";

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

/** 依据行里需要本地化的小标签(门/CI 计数前缀);由视图注入,模型保持可测。 */
export interface LiveFloorAskLabels {
  readonly gates: string;
  readonly ci: string;
}

/**
 * 只放业主才能做的事:待答提问、受保护面签发/同意、决策评审、历史 submitted 切面的处置。
 * 派审与返工重开由评审循环自动完成(dec_E369B861 CH3),不再是等业主的动作;置顶
 * (`pinnedEntities`)不在这里:置顶是业主自己的书签,不是等业主做的动作;它已经在
 * 总览的「置顶与议程」区与侧栏各有落点,在这里重复一遍只会把首屏挤满(2026-10-23 CEO 验收)。
 */
export function liveFloorAskLanes(input: {
  readonly agenda: {
    readonly awaitingYou: readonly AgendaAwaitsRow[];
    readonly awaitingDecision: readonly { readonly decisionId: string; readonly title: string }[];
    readonly awaitingDecisionReview: readonly { readonly decisionId: string; readonly title: string }[];
    readonly awaitingRework: readonly { readonly taskId: string; readonly title: string }[];
    readonly awaitingAdjudication: readonly {
      readonly taskId: string;
      readonly title: string;
      readonly executionId?: string;
    }[];
  } | null;
  readonly tasks: readonly TaskRow[];
  /** decision ask 的依据:提案原文问题,由视图经 decision 读面取回。 */
  readonly decisionQuestions?: ReadonlyMap<string, string>;
  readonly labels?: LiveFloorAskLabels;
}): readonly LiveFloorAskRow[] {
  const agenda = input.agenda,
    tasks = input.tasks,
    taskById = new Map(tasks.map((task) => [task.taskId, task] as const)),
    decisionQuestions = input.decisionQuestions ?? new Map<string, string>(),
    labels = input.labels ?? { gates: "gates", ci: "CI" },
    rows: LiveFloorAskRow[] = [];
  const taskIdOf = (ref: string): string | null => /^task\/(.+)$/u.exec(ref)?.[1] ?? null,
    decisionIdOf = (ref: string): string | null => /^decision\/(.+)$/u.exec(ref)?.[1] ?? null;
  // 评审依据:该任务最新一条评审记录的结论原文(verdict + reason 是评审亲手写的)。
  const latestReviewReason = (taskId: string | null, executionId?: string): string | null => {
    const task = taskId === null ? undefined : taskById.get(taskId),
      reviews = task?.reviews ?? [];
    const matching = (
      executionId === undefined ? reviews : reviews.filter((review) => review.executionId === executionId)
    )
      .filter((review) => review.verdict !== "dismissed")
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
    return matching[0]?.reason ?? null;
  };
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
  const lanes = deriveAttestationLanes(tasks);
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
  for (const consent of lanes.consents) {
    const task = taskById.get(consent.taskId),
      gates = task?.gates ?? [],
      passed = gates.filter((gate) => gate.ok === true).length,
      failing = gates.find((gate) => gate.ok !== true),
      // 依据:签到哪一步(门 x/y)+ 最近一道没过的门的说明。
      detail =
        gates.length === 0
          ? null
          : [`${labels.gates} ${passed}/${gates.length}`, failing?.detail ?? null].filter(Boolean).join(" · ");
    rows.push({
      key: `consent:${consent.taskId}`,
      kind: "consent",
      title: consent.taskTitle,
      detail,
      at: null,
      taskId: consent.taskId,
      decisionId: null,
      ask: null,
    });
  }
  for (const decision of agenda?.awaitingDecision ?? [])
    rows.push({
      key: `decision:${decision.decisionId}`,
      kind: "decision",
      title: decision.title,
      detail: decisionQuestions.get(decision.decisionId) ?? null,
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
      detail: decisionQuestions.get(decision.decisionId) ?? null,
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
      detail: latestReviewReason(task.taskId),
      at: null,
      taskId: task.taskId,
      decisionId: null,
      ask: null,
    });
  for (const execution of agenda?.awaitingAdjudication ?? []) {
    const task = taskById.get(execution.taskId),
      outputs = task?.executionEvidence?.find((entry) => entry.executionId === execution.executionId)?.outputs ?? [],
      checked = outputs.filter((output) => output.checkerResult !== "unknown"),
      passed = checked.filter((output) => output.checkerResult === "pass").length,
      // 依据:评审结论原文 + CI 收据(过了几项/验了几项)。
      detail = [
        latestReviewReason(execution.taskId, execution.executionId),
        checked.length > 0 ? `${labels.ci} ${passed}/${checked.length}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    rows.push({
      key: `legacySubmitted:${execution.taskId}`,
      kind: "legacySubmitted",
      title: execution.title,
      detail,
      at: null,
      taskId: execution.taskId,
      decisionId: null,
      ask: null,
    });
  }
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

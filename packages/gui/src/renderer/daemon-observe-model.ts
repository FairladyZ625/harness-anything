import type { ObserveTailPayload, ObserveTailRead } from "../api/renderer-dto.ts";

/**
 * G6-B daemon 观察页的纯数据面:`observe.tail` 分页 → 可渲染行流。
 *
 * 契约(v3,权威):items 上限 64/页;累计行流的内存上限只在「贴底追尾」的 follow 增长上
 * 生效(丢最旧端,见 OBSERVE_FOLLOW_ROW_LIMIT),history 方向翻页永不裁剪——用户回看
 * 历史,已加载的行不因继续上翻或 live 追加而丢失,渲染代价由视图层窗口化保证;
 * history/live cursor 由客户端分别持有并原样回传;
 * `unavailable` 携带机器原因(edge 镜像无事件 / center request-log 未接线),
 * `gap` 携带保留缺口原因(cursor 文件不在保留集 / 偏移越界),两者都不冒充空列表。
 * 本模块不做 IO、不碰 React,形状推导全部来自已到货的 page,供视图与 vitest 共用。
 */

export type ObserveTailKind = Exclude<ObserveTailRead["kind"], "dispatch">;
export type ObserveTailCursor = Exclude<ObserveTailRead["historyCursor"], { readonly kind: "dispatch" }>;
export type ObserveTailMode = ObserveTailRead["mode"];

export interface ObserveRefChip {
  /** canonical 实体引用(不带 repo 前缀;由视图按目标仓拼 scope)。 */
  readonly ref: string;
  readonly kind: "task" | "decision" | "fact" | "session" | "provider" | "agent" | "squad";
  readonly label: string;
}

export interface ObserveRow {
  readonly key: string;
  readonly at: string | null;
  readonly revision: number | null;
  readonly type: string;
  readonly text: string;
  /** 完整原始记录(title 提示用),已截断到安全长度。 */
  readonly detail: string;
  readonly refs: readonly ObserveRefChip[];
  /** 日志行的成败位(events 行为 null)。 */
  readonly ok: boolean | null;
  readonly gapMarker: { readonly reason: string; readonly requestedFileId: string } | null;
  readonly searchText: string;
}

export interface ObserveTailSnapshot {
  readonly rows: readonly ObserveRow[];
  readonly historyCursor: ObserveTailCursor;
  readonly liveCursor: ObserveTailCursor;
  readonly status: "idle" | "live" | "unavailable" | "gap" | "error";
  readonly unavailable: { readonly reason: string; readonly centerRevision: number | null } | null;
  readonly gap: { readonly reason: string; readonly requestedFileId: string } | null;
  readonly error: string | null;
  readonly caughtUp: boolean;
  readonly historyDone: boolean;
  readonly mode: ObserveTailMode | null;
  /**
   * 用户视角:贴底追尾("follow")还是回看历史("history")。回看历史期间 follow 增长
   * 也不裁剪(用户在读旧行,任何一端的丢弃都会撕裂阅读);只有贴底追尾时 follow 增长
   * 超过 OBSERVE_FOLLOW_ROW_LIMIT 才丢最旧端。由视图按滚动位置写入(applyObserveViewing)。
   */
  readonly viewing: "follow" | "history";
  /** 本视图生命周期内已接收的记录总数,用于生成稳定的日志行 key。 */
  readonly received: number;
}

const DETAIL_LIMIT = 2_000;

/**
 * 内存上限:只约束「贴底追尾」状态下的 follow 增长(丢最旧端),值远大于旧双侧 500 上限——
 * 渲染代价由视图层窗口化保证(挂 DOM 的行数有界),这里的数值只保证长开 pane 的内存代价,
 * 两者分开。history 翻页永不裁剪;回看历史(viewing: "history")期间 live 追加也不裁剪,
 * 回到贴底后下一次 follow 增长再回到界内。#1855 前的双侧 500 上限会丢弃用户正读着的行,
 * 已废。
 */
export const OBSERVE_FOLLOW_ROW_LIMIT = 5_000;

export function initialObserveTail(): ObserveTailSnapshot {
  return {
    rows: [],
    historyCursor: null,
    liveCursor: null,
    status: "idle",
    unavailable: null,
    gap: null,
    error: null,
    caughtUp: false,
    historyDone: false,
    mode: null,
    viewing: "follow",
    received: 0,
  };
}

/** 视图按滚动位置写入用户视角(贴底追尾 / 回看历史);其余字段原样保留。 */
export function applyObserveViewing(state: ObserveTailSnapshot, viewing: "follow" | "history"): ObserveTailSnapshot {
  return state.viewing === viewing ? state : { ...state, viewing };
}

export function applyObserveTailPage(state: ObserveTailSnapshot, page: ObserveTailRead): ObserveTailSnapshot {
  if (page.status === "unavailable")
    return {
      ...state,
      status: "unavailable",
      unavailable: page.unavailable,
      gap: null,
      error: null,
      caughtUp: false,
      mode: page.mode,
      historyCursor: null,
      liveCursor: null,
    };
  if (page.status === "gap") {
    const marker = gapMarkerRow(page.gap, state.rows.length),
      historyGap = page.direction === "history";
    return {
      ...state,
      // history 方向的缺口标记只插入行头,不裁剪已加载行(回看历史期间任何一端都不丢)。
      rows: historyGap ? [marker, ...state.rows] : [marker],
      status: "gap",
      gap: page.gap,
      unavailable: null,
      error: null,
      caughtUp: false,
      mode: page.mode,
      historyCursor: historyGap ? null : state.historyCursor,
      liveCursor: historyGap ? state.liveCursor : null,
      historyDone: historyGap || state.historyDone,
      received: historyGap ? state.received : 0,
    };
  }
  const fresh =
    page.kind === "events"
      ? page.items.map((item) => observeEventRow(item))
      : page.items.map((item, index) =>
          observeLogRow(item as Readonly<Record<string, unknown>>, state.received + index),
        );
  const pageHistoryCursor = observePaneCursor(page.historyCursor),
    pageLiveCursor = observePaneCursor(page.liveCursor),
    pageSourceCursor = observePaneCursor(page.sourceCursor),
    prepend = page.direction === "history",
    initializing = prepend && state.liveCursor === null,
    appendAfterGap = initializing && state.status === "gap",
    headGrowth = prepend && !appendAfterGap,
    rows = headGrowth
      ? // history 翻页:只往前拼接,永不裁剪(渲染代价由视图窗口化保证)。
        page.kind === "events"
        ? mergeEventRows(state.rows, fresh, true)
        : [...fresh, ...state.rows]
      : // follow 增长:只有贴底追尾时才对 live 累积封顶(丢最旧端);回看历史期间不裁剪。
        capFollowRows(
          page.kind === "events" ? mergeEventRows(state.rows, fresh, false) : [...state.rows, ...fresh],
          state.viewing,
        );
  return {
    ...state,
    rows,
    historyCursor: prepend ? pageHistoryCursor : state.historyCursor,
    liveCursor: prepend ? (initializing ? pageLiveCursor : state.liveCursor) : pageLiveCursor,
    status: "live",
    unavailable: null,
    gap: null,
    error: null,
    caughtUp:
      page.direction === "follow"
        ? page.done
        : initializing && page.status === "ready" && sameCursor(pageLiveCursor, pageSourceCursor),
    historyDone: prepend ? page.done : state.historyDone,
    mode: page.mode,
    received: state.received + fresh.length,
  };
}

export function observePaneCursor(value: ObserveTailRead["historyCursor"]): ObserveTailCursor {
  return value?.kind === "dispatch" ? null : value;
}

export function applyObserveTailError(state: ObserveTailSnapshot, message: string): ObserveTailSnapshot {
  return { ...state, status: "error", error: message, unavailable: null, gap: null, caughtUp: false };
}

/**
 * 组装 `observe.tail` 请求:payload 是按 kind 判别的联合,只有逐 kind 收窄才能让
 * cursor 与 kind 的相关性通过类型检查。cursor 与 kind 不匹配时退化为无 cursor 的 history
 * 请求(正常生命周期里不会发生:每仓每 kind 一个 pane 实例,游标只来自同 kind 的上一页)。
 */
export function observeTailRequest(
  repoId: string,
  kind: ObserveTailKind,
  direction: "history" | "follow",
  cursor: ObserveTailCursor | null,
): { readonly repoId: string } & ObserveTailPayload {
  switch (kind) {
    case "events":
      return direction === "follow" && cursor?.kind === "events"
        ? { repoId, kind, direction, cursor }
        : cursor?.kind === "events"
          ? { repoId, kind, direction: "history", cursor }
          : { repoId, kind, direction: "history" };
    case "repo-log":
      return direction === "follow" && cursor?.kind === "repo-log"
        ? { repoId, kind, direction, cursor }
        : cursor?.kind === "repo-log"
          ? { repoId, kind, direction: "history", cursor }
          : { repoId, kind, direction: "history" };
    case "lifecycle":
      return direction === "follow" && cursor?.kind === "lifecycle"
        ? { repoId, kind, direction, cursor }
        : cursor?.kind === "lifecycle"
          ? { repoId, kind, direction: "history", cursor }
          : { repoId, kind, direction: "history" };
    default:
      return direction === "follow" && cursor?.kind === "daemon-log"
        ? { repoId, kind, direction, cursor }
        : cursor?.kind === "daemon-log"
          ? { repoId, kind, direction: "history", cursor }
          : { repoId, kind, direction: "history" };
  }
}

/** 关键字过滤:大小写不敏感子串,匹配行自身文本与全部实体引用。 */
export function filterObserveRows(rows: readonly ObserveRow[], query: string): readonly ObserveRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) => row.searchText.includes(needle));
}

function mergeEventRows(
  existing: readonly ObserveRow[],
  fresh: readonly ObserveRow[],
  prepend: boolean,
): readonly ObserveRow[] {
  // 事件行以 eventId 为键:ledger 重建后同一 revision 段重放时不重复入列。
  const seen = new Set(existing.map((row) => row.key));
  const unique = fresh.filter((row) => !seen.has(row.key));
  return prepend ? [...unique, ...existing] : [...existing, ...unique];
}

/**
 * 结构比较,不依赖对象键序:cursor 只有 events(revision)与文件游标(fileId+offset)
 * 两种形状,逐判别字段比较即可,避免 `JSON.stringify` 把键序差异误判为游标不同。
 */
function sameCursor(left: ObserveTailCursor, right: ObserveTailCursor): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "events") return right.kind === "events" && left.revision === right.revision;
  return right.kind !== "events" && left.fileId === right.fileId && left.offset === right.offset;
}

/**
 * follow 增长的内存上限:贴底追尾时丢最旧端;回看历史期间不裁剪(不足上限原样返回,
 * 见 OBSERVE_FOLLOW_ROW_LIMIT)。回到贴底后的下一次 follow 增长重新把行数拉回界内。
 */
function capFollowRows(rows: readonly ObserveRow[], viewing: "follow" | "history"): readonly ObserveRow[] {
  if (viewing !== "follow" || rows.length <= OBSERVE_FOLLOW_ROW_LIMIT) return rows;
  return rows.slice(rows.length - OBSERVE_FOLLOW_ROW_LIMIT);
}

function gapMarkerRow(gap: { readonly reason: string; readonly requestedFileId: string }, seq: number): ObserveRow {
  return {
    key: `gap:${seq}:${gap.requestedFileId}`,
    at: null,
    revision: null,
    type: "gap",
    text: "",
    detail: "",
    refs: [],
    ok: null,
    gapMarker: gap,
    searchText: `gap ${gap.reason} ${gap.requestedFileId}`.toLowerCase(),
  };
}

/** canonical 事件 → 行:类型 + 摘要 + 可跳转实体引用(task/decision/fact/session/provider/agent/squad)。 */
export function observeEventRow(event: ObserveTailRead["items"][number]): ObserveRow {
  // 联合里 taskId/decisionId/factId 只存在于部分成员;行提取按字段可选读取,
  // 不对每种事件形状各写一份(新增事件 kind 自动获得同一呈现)。
  const source = event as {
      readonly taskId?: unknown;
      readonly decisionId?: unknown;
      readonly factId?: unknown;
      readonly eventId?: unknown;
      readonly workspaceRevision?: unknown;
      readonly occurredAt?: unknown;
      readonly type?: unknown;
      readonly schema?: unknown;
      readonly payload?: unknown;
    },
    payload = recordOf(source.payload) ?? {},
    taskId = stringOf(source.taskId) ?? stringOf(payload.taskId),
    decisionId = stringOf(source.decisionId),
    factId = stringOf(source.factId),
    type = stringOf(source.type) ?? stringOf(source.schema) ?? "event",
    base = {
      key: stringOf(source.eventId) ?? `${type}:${stringOf(source.workspaceRevision)}`,
      at: stringOf(source.occurredAt),
      revision: integerOf(source.workspaceRevision),
      type,
      text: eventSummary(payload),
      detail: clip(JSON.stringify(event)),
      refs: eventRefs({ payload, taskId, decisionId, factId }),
      ok: null as boolean | null,
      gapMarker: null,
    };
  return { ...base, searchText: searchTextOf(base) };
}

/** 仓库/守护进程日志行(daemon-request-log/v1 · daemon-conn-log/v1 的 JSONL 记录)。 */
export function observeLogRow(record: Readonly<Record<string, unknown>>, seq: number): ObserveRow {
  const method = stringOf(record.method),
    event = stringOf(record.event),
    command = stringOf(record.command),
    outcome = stringOf(record.outcome) ?? stringOf(record.code),
    duration = numberToMs(record.durationMs),
    base = {
      key: `log:${seq}`,
      at: stringOf(record.at),
      revision: null as number | null,
      type: method ?? event ?? stringOf(record.schema) ?? "record",
      text: [command, outcome, duration].filter(Boolean).join(" "),
      detail: clip(JSON.stringify(record)),
      refs: [] as readonly ObserveRefChip[],
      ok: typeof record.ok === "boolean" ? record.ok : null,
      gapMarker: null,
    };
  return { ...base, searchText: searchTextOf(base) };
}

function eventRefs(input: {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly taskId: string | null;
  readonly decisionId: string | null;
  readonly factId: string | null;
}): readonly ObserveRefChip[] {
  const { payload, taskId, decisionId, factId } = input,
    runtimeSessionId = stringOf(payload.runtimeSessionId),
    instanceId = stringOf(payload.instanceId),
    entityKind = stringOf(payload.entityKind),
    entityId = stringOf(payload.entityId),
    chips: ObserveRefChip[] = [];
  if (taskId) chips.push({ ref: `task/${taskId}`, kind: "task", label: taskId });
  if (decisionId) chips.push({ ref: `decision/${decisionId}`, kind: "decision", label: decisionId });
  if (factId) chips.push({ ref: `fact/${factId}`, kind: "fact", label: factId });
  if (runtimeSessionId) chips.push({ ref: `session/${runtimeSessionId}`, kind: "session", label: runtimeSessionId });
  if (instanceId) chips.push({ ref: `provider/${instanceId}`, kind: "provider", label: instanceId });
  if ((entityKind === "agent" || entityKind === "squad") && entityId)
    chips.push({ ref: `${entityKind}/${entityId}`, kind: entityKind, label: entityId });
  return chips;
}

/**
 * 事件单行摘要:标题/陈述/进度文本优先,否则数文档变更,实体事件给 kind,未知形状留空。
 * 摘要渲染在不可点击的文本列里,而 G10 不变量要求实体 ID 只出现在可激活的 chip 中,
 * 因此这里绝不把 payload JSON 原文倒进行文本列;完整记录进 title 悬停(detail)与
 * searchText(关键字过滤仍能命中 payload 内文)。
 */
function eventSummary(payload: Readonly<Record<string, unknown>>): string {
  const direct = firstString(payload.title, payload.statement, payload.text);
  if (direct !== null) return clip(direct, 140);
  const task = recordOf(payload.task),
    title = stringOf(task?.title);
  if (title !== null) return clip(title, 140);
  const changes = payload.changes;
  if (Array.isArray(changes)) return `${changes.length} doc change(s)`;
  return stringOf(payload.entityKind) ?? "";
}

function searchTextOf(row: Omit<ObserveRow, "searchText">): string {
  return [
    row.at ?? "",
    row.revision === null ? "" : `#${row.revision}`,
    row.type,
    row.text,
    ...row.refs.flatMap((chip) => [chip.kind, chip.ref, chip.label]),
    row.detail,
  ]
    .join(" ")
    .toLowerCase();
}

export function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = stringOf(value);
    if (text !== null) return text;
  }
  return null;
}

function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function numberToMs(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}ms` : null;
}

export function clip(value: string, limit = DETAIL_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

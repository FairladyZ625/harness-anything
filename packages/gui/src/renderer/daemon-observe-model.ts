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
  readonly rows: ObserveRowLog;
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
    rows: new ObserveRowLog(),
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
    // history 方向的缺口标记只插入行头,不裁剪已加载行(回看历史期间任何一端都不丢)。
    if (historyGap) state.rows.prepend([marker], false);
    else state.rows.replace([marker]);
    return {
      ...state,
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
    headGrowth = prepend && !appendAfterGap;
  if (headGrowth)
    // history 翻页:只往前拼接,永不裁剪(渲染代价由视图窗口化保证);事件按 key 索引挡重放。
    state.rows.prepend(fresh, page.kind === "events");
  else {
    // follow 增长:只有贴底追尾时才对 live 累积封顶(丢最旧端);回看历史期间不裁剪。
    state.rows.append(fresh, page.kind === "events");
    capFollowRows(state.rows, state.viewing);
  }
  const next: ObserveTailSnapshot = {
    ...state,
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
  // 空页 fast path:无新行、游标与追平位都没动的 follow 页原样返回同一引用,
  // 视图 setSnapshot 拿到同引用不重渲染。行容器本身从不重建(见 ObserveRowLog)。
  return sameObserveTail(state, next) ? state : next;
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

/** 增量查询过滤的续用缓存:视图存进 ref,连同 rows.version 一起作 useMemo 依赖。 */
export interface ObserveFilterCache {
  readonly query: string;
  readonly source: ObserveRowLog;
  readonly version: number;
  readonly mark: ObserveRowMark;
  readonly result: ObserveRowLog;
}

/**
 * 行存储上的关键字过滤,语义同 filterObserveRows,但同一 query 下只对两端新增行做
 * 匹配、结果容器跨快照复用(引用不变):follow 轮询不再每秒全量重扫已加载行。
 * query 变化或行集被裁剪/替换(growth 为 null)时全量重建;空查询直接复用源容器。
 */
export function filterObserveRowsLog(
  source: ObserveRowLog,
  query: string,
  cache: ObserveFilterCache | null,
): ObserveFilterCache {
  const needle = query.trim().toLowerCase();
  if (cache !== null && cache.source === source && cache.query === needle && cache.version === source.version)
    return cache;
  if (needle === "") return { query: needle, source, version: source.version, mark: source.mark(), result: source };
  const prior = cache !== null && cache.source === source && cache.query === needle ? cache : null;
  const growth = prior === null ? null : source.growth(prior.mark);
  if (prior === null || growth === null) {
    const result = new ObserveRowLog(false),
      hits: ObserveRow[] = [];
    for (const row of source) if (row.searchText.includes(needle)) hits.push(row);
    result.append(hits, false);
    return { query: needle, source, version: source.version, mark: source.mark(), result };
  }
  const matched = (rows: readonly ObserveRow[]) => rows.filter((row) => row.searchText.includes(needle));
  if (growth.prepended.length > 0) prior.result.prepend(matched(growth.prepended), false);
  if (growth.appended.length > 0) prior.result.append(matched(growth.appended), false);
  return { query: needle, source, version: source.version, mark: growth.mark, result: prior.result };
}

/** 行存储的两端水位 + 丢行计数,是增量查询过滤判断缓存可否续用的标记。 */
export interface ObserveRowMark {
  readonly head: number;
  readonly tail: number;
  readonly shrinks: number;
}

/**
 * 行存储:head(倒序,承接前插)/ tail(正序,承接追加)两段,前插与追加常数摊还,
 * 按索引读取 O(1)、窗口切片 O(window),不再随累计行数整数组复制。事件去重靠随行
 * 维护的 key 索引(seen),不每页整表重建 Set;贴底封顶丢最旧端时先弹 head、再前移
 * tail 读偏移(摊还清除)。version 随每次行集变更自增、shrinks 只在丢行/整表替换时
 * 自增,供 filterObserveRowsLog 判断「增量续用 / 全量重建」。
 */
export class ObserveRowLog {
  private readonly head: ObserveRow[] = [];
  private tail: ObserveRow[] = [];
  private readonly seen: Set<string> | null;
  private tailStart = 0;
  private shrinkCount = 0;
  private mutationCount = 0;

  /** dedup=false 的实例不做 key 去重(查询过滤的结果容器:key 天然唯一,省一份索引)。 */
  constructor(dedup = true) {
    this.seen = dedup ? new Set<string>() : null;
  }

  get length(): number {
    return this.head.length + this.tail.length - this.tailStart;
  }

  /** 行集变更计数:视图层增量过滤的缓存键之一。 */
  get version(): number {
    return this.mutationCount;
  }

  /**
   * 前插一批行到行头(history 翻页、gap 标记)。dedup 时按 key 挡掉已入列的重放事件,
   * 未见过行保持原有顺序(与旧 mergeEventRows 的 filter 语义一致)。
   */
  prepend(rows: readonly ObserveRow[], dedup: boolean): void {
    if (rows.length === 0) return;
    let grown = false;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (!this.admit(row, dedup)) continue;
      this.head.push(row);
      grown = true;
    }
    if (grown) this.mutationCount += 1;
  }

  /** 追加一批行到行尾(follow 增长);dedup 时按 key 挡掉已入列的重放事件。 */
  append(rows: readonly ObserveRow[], dedup: boolean): void {
    if (rows.length === 0) return;
    let grown = false;
    for (const row of rows) {
      if (!this.admit(row, dedup)) continue;
      this.tail.push(row);
      grown = true;
    }
    if (grown) this.mutationCount += 1;
  }

  /** 贴底封顶丢最旧端:先弹 head(倒序段的末尾就是最旧行),耗尽后前移 tail 读偏移。 */
  dropOldest(count: number): void {
    let remaining = Math.min(count, this.length);
    if (remaining <= 0) return;
    while (remaining > 0 && this.head.length > 0) {
      this.seen?.delete(this.head.pop()!.key);
      remaining -= 1;
    }
    for (let index = 0; index < remaining; index += 1) this.seen?.delete(this.tail[this.tailStart + index]!.key);
    this.tailStart += remaining;
    if (this.tailStart > 0 && this.tailStart * 2 >= this.tail.length) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
    this.shrinkCount += 1;
    this.mutationCount += 1;
  }

  /** 整表替换(follow 方向 gap 重置):只留给定行,key 索引随之重建。 */
  replace(rows: readonly ObserveRow[]): void {
    this.head.length = 0;
    this.tail = [...rows];
    this.tailStart = 0;
    this.seen?.clear();
    for (const row of rows) this.seen?.add(row.key);
    this.shrinkCount += 1;
    this.mutationCount += 1;
  }

  /** 按索引读取(支持负索引,语义同 Array.prototype.at),O(1)。 */
  at(index: number): ObserveRow | undefined {
    const total = this.length,
      slot = index < 0 ? total + index : index;
    if (slot < 0 || slot >= total) return undefined;
    return slot < this.head.length
      ? this.head[this.head.length - 1 - slot]
      : this.tail[this.tailStart + slot - this.head.length];
  }

  /** 窗口切片 [start, end)(支持负索引);代价 O(end - start),与累计行数无关。 */
  slice(start = 0, end = this.length): readonly ObserveRow[] {
    const total = this.length,
      from = Math.max(0, start < 0 ? total + start : start),
      to = Math.min(total, end < 0 ? total + end : end),
      window: ObserveRow[] = [];
    for (let index = from; index < to; index += 1) window.push(this.at(index)!);
    return window;
  }

  /** 逻辑正序迭代,只供全量重建路径(查询词变化/行集收缩)使用。 */
  *[Symbol.iterator](): Iterator<ObserveRow> {
    for (let index = this.head.length - 1; index >= 0; index -= 1) yield this.head[index]!;
    for (let index = this.tailStart; index < this.tail.length; index += 1) yield this.tail[index]!;
  }

  /** 当前两端水位与丢行计数。 */
  mark(): ObserveRowMark {
    return { head: this.head.length, tail: this.tail.length - this.tailStart, shrinks: this.shrinkCount };
  }

  /**
   * 自 mark 以来的两端新增行(各自按逻辑正序)与新 mark。期间丢过行或整表替换过
   * (shrinks 变化)、或水位回落时返回 null:缓存里的行集不再可靠,调用方需全量重建。
   */
  growth(
    mark: ObserveRowMark,
  ): { prepended: readonly ObserveRow[]; appended: readonly ObserveRow[]; mark: ObserveRowMark } | null {
    const current = this.mark();
    if (mark.shrinks !== current.shrinks || mark.head > current.head || mark.tail > current.tail) return null;
    return {
      prepended: this.head.slice(mark.head).reverse(),
      appended: this.tail.slice(this.tailStart + mark.tail),
      mark: current,
    };
  }

  private admit(row: ObserveRow, dedup: boolean): boolean {
    if (this.seen === null) return true;
    if (dedup && this.seen.has(row.key)) return false;
    this.seen.add(row.key);
    return true;
  }
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

/** 空页 fast path:逐字段比较两次快照是否可观察地相同(行容器同引用即行集未变)。 */
function sameObserveTail(a: ObserveTailSnapshot, b: ObserveTailSnapshot): boolean {
  return (
    a.rows === b.rows &&
    a.status === b.status &&
    a.error === b.error &&
    a.caughtUp === b.caughtUp &&
    a.historyDone === b.historyDone &&
    a.mode === b.mode &&
    a.viewing === b.viewing &&
    a.received === b.received &&
    sameCursor(a.historyCursor, b.historyCursor) &&
    sameCursor(a.liveCursor, b.liveCursor) &&
    sameDetail(a.unavailable, b.unavailable) &&
    sameDetail(a.gap, b.gap)
  );
}

function sameDetail<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const left = a as Readonly<Record<string, unknown>>,
    right = b as Readonly<Record<string, unknown>>;
  return Object.keys(left).every((key) => left[key] === right[key]);
}

/**
 * follow 增长的内存上限:贴底追尾时丢最旧端;回看历史期间不裁剪(不足上限不动行集,
 * 见 OBSERVE_FOLLOW_ROW_LIMIT)。回到贴底后的下一次 follow 增长重新把行数拉回界内。
 */
function capFollowRows(rows: ObserveRowLog, viewing: "follow" | "history"): void {
  if (viewing !== "follow") return;
  const excess = rows.length - OBSERVE_FOLLOW_ROW_LIMIT;
  if (excess > 0) rows.dropOldest(excess);
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

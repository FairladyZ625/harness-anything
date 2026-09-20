import { clip, recordOf, stringOf } from "../daemon-observe-model.ts";
import type { SnapshotStatus, TaskRow } from "./types.ts";

/**
 * 研发态势视图(Cadence & Pulse)的纯聚合引擎:把 `observe.tail` kind=events 的
 * canonical 事件窗口与 `repo.tasks.list` 投影行合成「以 task 为叙事单元」的节奏 /
 * 摩擦 / 产出快照。不做 IO、不碰 React,供视图与 vitest 共用。
 *
 * 判定纪律:任务的当前状态与阶段一律读 TaskRow 投影(coordinationStatus / phase),
 * 本模块只做**呈现层分组**——事件 type 词(kernel `taskEventTypes` / `factEventTypes`)
 * 到节奏阶段的映射、以及摩擦信号(门禁失败 witness / 评审打回 verdict / 提交退回 /
 * 任务重开)的计数,不重推任何生命周期判定。GUI 绝不读文件,数据全部来自既有 RPC。
 */

/** 聚合窗口的内存上限:滚动分析窗口,超出丢最旧端(与 OBSERVE_FOLLOW_ROW_LIMIT 同哲学)。 */
export const CADENCE_EVENT_LIMIT = 4_096;
/** 停滞判定:非终态任务距最后一次已知活动超过该毫秒数视为停滞(Stalled)。 */
export const CADENCE_STALLED_AFTER_MS = 24 * 3_600_000;
/** 高摩擦阈值:同一任务摩擦信号总数**超过**该值标记为高摩擦(task_plan 判据:>2)。 */
export const CADENCE_FRICTION_ALERT_THRESHOLD = 2;
/** 模块热度榜单上限。 */
export const CADENCE_MODULE_TOP = 6;
/** 今日新 Fact 的展示条数上限。 */
export const CADENCE_RECENT_FACTS = 5;
/** 展开行微型事件链的条数上限(取最新 N 条,更早的只报截断数)。 */
export const CADENCE_MICRO_EVENTS = 20;
/** 事件摘要(fact statement / progress text)的展示长度上限,与观察页 eventSummary 同口径。 */
const CADENCE_SUMMARY_LIMIT = 140;

/** 节奏阶段:立项 → 编码 → 事实核验 → 门禁验证 → 收口(task_plan 的生命周期叙事)。 */
export type CadenceStageId = "bootstrap" | "wip" | "fact" | "gate" | "complete";

export const CADENCE_STAGE_ORDER: readonly CadenceStageId[] = ["bootstrap", "wip", "fact", "gate", "complete"];

/** 阶段耗时漏斗的区间:相邻阶段首达之间的耗时(立项→编码→Fact→门禁→收口)。 */
export type CadenceSegmentId = "toWip" | "toFact" | "toGate" | "toComplete";

export const CADENCE_SEGMENT_ORDER: readonly CadenceSegmentId[] = ["toWip", "toFact", "toGate", "toComplete"];

/** 事件 type(kernel 词表的呈现层分组;未列出的 type 不参与节奏,仍计入事件数)。 */
const STAGE_BY_EVENT_TYPE: Readonly<Record<string, CadenceStageId>> = {
  task_bootstrapped: "bootstrap",
  task_created: "bootstrap",
  execution_started: "wip",
  lease_renewed: "wip",
  task_progress_appended: "wip",
  execution_annotated: "wip",
  execution_executor_declared: "wip",
  fact_recorded: "fact",
  completion_gate_verified: "gate",
  review_recorded: "gate",
  review_consent_recorded: "gate",
  code_doc_reconciled: "gate",
  code_doc_repointed: "gate",
  execution_submitted: "gate",
  submission_forwarded: "gate",
  submission_returned: "gate",
  task_completed: "complete",
};

/** 摩擦信号四类:门禁失败 / 评审打回 / 提交退回 / 任务重开。 */
export type CadenceFrictionKind = "gateFail" | "reviewChanges" | "returned" | "reopened";

export const CADENCE_FRICTION_KINDS: readonly CadenceFrictionKind[] = [
  "gateFail",
  "reviewChanges",
  "returned",
  "reopened",
];

/** kernel `completion-gate-witness/v1` 的 result 词表。 */
export type CadenceGateResult = "pass" | "fail" | "advisory" | "not_run";
/** kernel `review/v1` 的 verdict 词表。 */
export type CadenceReviewVerdict = "approved" | "changes_requested" | "dismissed";

const GATE_RESULTS: readonly CadenceGateResult[] = ["pass", "fail", "advisory", "not_run"];
const REVIEW_VERDICTS: readonly CadenceReviewVerdict[] = ["approved", "changes_requested", "dismissed"];

/** observe.tail events item 的结构子集(经 cadenceEventOf 收窄;防御性读取,不信任形状)。 */
export interface CadenceFeedEvent {
  readonly key: string;
  readonly type: string;
  readonly at: string | null;
  readonly revision: number | null;
  readonly taskId: string | null;
  readonly factId: string | null;
  readonly decisionId: string | null;
  readonly gateId: string | null;
  readonly gateResult: CadenceGateResult | null;
  readonly reviewVerdict: CadenceReviewVerdict | null;
  /** 事件单行摘要(fact statement / 进度文本 / 标题,截断);供微型事件链原地阅读。 */
  readonly summary: string | null;
}

function gateResultOf(value: unknown): CadenceGateResult | null {
  return GATE_RESULTS.includes(value as CadenceGateResult) ? (value as CadenceGateResult) : null;
}

function reviewVerdictOf(value: unknown): CadenceReviewVerdict | null {
  return REVIEW_VERDICTS.includes(value as CadenceReviewVerdict) ? (value as CadenceReviewVerdict) : null;
}

function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** canonical 事件(observe.tail items 原样)→ 聚合输入;字段缺失显式落 null,不猜。 */
export function cadenceEventOf(item: unknown): CadenceFeedEvent {
  const source = recordOf(item),
    payload = recordOf(source?.payload) ?? {},
    witness = recordOf(payload.witness),
    review = recordOf(payload.review),
    type = stringOf(source?.type) ?? stringOf(source?.schema) ?? "event";
  const fallbackKey = stringOf(source?.workspaceRevision) ?? stringOf(source?.occurredAt) ?? "?";
  const directSummary = stringOf(payload.statement) ?? stringOf(payload.text) ?? stringOf(payload.title);
  return {
    key: stringOf(source?.eventId) ?? `${type}:${fallbackKey}`,
    type,
    at: stringOf(source?.occurredAt),
    revision: integerOf(source?.workspaceRevision),
    taskId: stringOf(source?.taskId) ?? stringOf(payload.taskId),
    factId: stringOf(source?.factId),
    decisionId: stringOf(source?.decisionId),
    gateId: stringOf(witness?.gateId),
    gateResult: gateResultOf(witness?.result),
    reviewVerdict: reviewVerdictOf(review?.verdict),
    summary: directSummary === null ? null : clip(directSummary, CADENCE_SUMMARY_LIMIT),
  };
}

function frictionOf(event: CadenceFeedEvent): CadenceFrictionKind | null {
  if (event.type === "completion_gate_verified" && event.gateResult === "fail") return "gateFail";
  if (event.type === "review_recorded" && event.reviewVerdict === "changes_requested") return "reviewChanges";
  if (event.type === "submission_returned") return "returned";
  if (event.type === "task_reopened") return "reopened";
  return null;
}

/** 窗口合并:去重(eventId)后按 revision/时间升序,超出上限丢最旧端;无新行返回原引用。 */
export function mergeCadenceEvents(
  current: readonly CadenceFeedEvent[],
  added: readonly CadenceFeedEvent[],
): readonly CadenceFeedEvent[] {
  if (added.length === 0) return current;
  const seen = new Set(current.map((event) => event.key)),
    fresh = added.filter((event) => !seen.has(event.key));
  if (fresh.length === 0) return current;
  for (const event of fresh) seen.add(event.key);
  const merged = [...current, ...fresh].sort(compareCadenceEvents);
  return merged.length > CADENCE_EVENT_LIMIT ? merged.slice(merged.length - CADENCE_EVENT_LIMIT) : merged;
}

function compareCadenceEvents(left: CadenceFeedEvent, right: CadenceFeedEvent): number {
  const byRevision = (left.revision ?? -1) - (right.revision ?? -1);
  if (byRevision !== 0 || left.at === right.at) return byRevision;
  return left.at === null ? -1 : right.at === null ? 1 : left.at < right.at ? -1 : 1;
}

/** 节奏音轨里一个任务的一行:事件侧累积 + TaskRow 投影行补全。 */
export interface TaskRhythmEntry {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly module: string | null;
  /** 当前投影 cut 里有没有这一行(事件窗口跨 cut 时可能只见事件不见行)。 */
  readonly known: boolean;
  /** 各阶段首次到达时间;窗口没覆盖到的阶段为 null。 */
  readonly stages: Readonly<Record<CadenceStageId, string | null>>;
  /** 事件侧最后到达的阶段(与 TaskRow.phase 互补:那是 kernel 判定,这是窗口内叙事)。 */
  readonly currentStage: CadenceStageId | null;
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
  readonly eventCount: number;
  readonly frictionTotal: number;
  readonly deliveryMs: number | null;
  readonly stalled: boolean;
  /** 窗口内首事件 → 收口(未收口则到聚合时钟)的历时;无事件为 null。 */
  readonly elapsedMs: number | null;
  /** 阶段耗时漏斗:相邻阶段首达差与瓶颈区间。 */
  readonly timing: CadenceStageTiming;
  /** 微型事件链(该任务窗口内事件,时序,最新 CADENCE_MICRO_EVENTS 条)。 */
  readonly microEvents: readonly CadenceFeedEvent[];
  /** 被截掉的更早事件数(0 = 窗口内全量呈现)。 */
  readonly microTruncated: number;
}

/** 阶段耗时漏斗:区间耗时、可测总耗时与瓶颈区间(占比最大者)。 */
export interface CadenceStageTiming {
  /** 相邻阶段首达差(乱序到达夹到 0);窗口没覆盖端点的区间为 null。 */
  readonly segments: Readonly<Record<CadenceSegmentId, number | null>>;
  /** 可测区间之和(占比的分母);无可测区间为 0。 */
  readonly measuredMs: number;
  /** 耗时最大的区间;无可测区间为 null。 */
  readonly bottleneck: CadenceSegmentId | null;
  /** 瓶颈区间占 measuredMs 的比例(0..1)。 */
  readonly bottleneckShare: number | null;
}

/** 阶段首达 → 漏斗区间:纯推导,无 IO;供展开面板与 vitest 共用。 */
export function deriveStageTiming(stages: Readonly<Record<CadenceStageId, string | null>>): CadenceStageTiming {
  const span = (from: string | null, to: string | null): number | null => {
    if (from === null || to === null) return null;
    const ms = Date.parse(to) - Date.parse(from);
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
  };
  const segments = {
    toWip: span(stages.bootstrap, stages.wip),
    toFact: span(stages.wip, stages.fact),
    toGate: span(stages.fact, stages.gate),
    toComplete: span(stages.gate, stages.complete),
  } as Record<CadenceSegmentId, number | null>;
  const measured = CADENCE_SEGMENT_ORDER.filter((segment) => segments[segment] !== null);
  const measuredMs = measured.reduce((sum, segment) => sum + segments[segment]!, 0);
  const bottleneck =
    measuredMs > 0
      ? measured.reduce((best, segment) => (segments[segment]! > segments[best]! ? segment : best), measured[0]!)
      : null;
  return {
    segments,
    measuredMs,
    bottleneck,
    bottleneckShare: bottleneck === null ? null : segments[bottleneck]! / measuredMs,
  };
}

export interface CadenceFrictionTask {
  readonly taskId: string;
  readonly title: string;
  readonly total: number;
  readonly gateFail: number;
  readonly reviewChanges: number;
  readonly returned: number;
  readonly reopened: number;
  readonly lastSignalAt: string | null;
  readonly high: boolean;
}

export interface CadenceStalledTask {
  readonly taskId: string;
  readonly title: string;
  readonly lastSeenAt: string | null;
}

export interface CadenceFrictionSnapshot {
  readonly byKind: Readonly<Record<CadenceFrictionKind, number>>;
  readonly tasks: readonly CadenceFrictionTask[];
  readonly highFrictionCount: number;
  readonly stalled: readonly CadenceStalledTask[];
}

export interface CadenceFactMark {
  readonly factId: string;
  readonly at: string | null;
}

export interface CadenceModuleHeat {
  readonly module: string;
  readonly tasks: number;
  readonly events: number;
}

export interface CadenceYieldSnapshot {
  readonly factsToday: number;
  readonly recentFacts: readonly CadenceFactMark[];
  readonly decisionsProposed: number;
  readonly decisionsInEffect: number;
  readonly moduleHeat: readonly CadenceModuleHeat[];
}

export interface CadenceHudSnapshot {
  readonly activeTasks: number;
  readonly stalledActive: number;
  readonly avgDeliveryMs: number | null;
  readonly completedToday: number;
  readonly completedInWindow: number;
  /** 等待人类仲裁事项数(repo.agenda.read awaitingDecision);议程未读完时为 null,不冒充。 */
  readonly awaitingHuman: number | null;
}

export interface CadenceSnapshot {
  readonly hud: CadenceHudSnapshot;
  readonly rhythm: readonly TaskRhythmEntry[];
  readonly friction: CadenceFrictionSnapshot;
  readonly yield: CadenceYieldSnapshot;
}

export interface CadenceInput {
  /** 升序事件窗口(mergeCadenceEvents 的输出)。 */
  readonly events: readonly CadenceFeedEvent[];
  /** 当前投影 cut 的任务行。 */
  readonly tasks: readonly TaskRow[];
  /** 决策摘要行(repo.decisions.list projection=summary);只读 state 计数。 */
  readonly decisions: readonly { readonly state: string }[];
  readonly awaitingHuman: number | null;
  readonly now: string;
}

interface TaskAccumulator {
  readonly stages: Map<CadenceStageId, string>;
  currentStage: CadenceStageId | null;
  firstAt: string | null;
  lastAt: string | null;
  count: number;
  readonly friction: Record<CadenceFrictionKind, number>;
  frictionTotal: number;
  lastSignalAt: string | null;
  completedAt: string | null;
  bootstrapAt: string | null;
  /** 该任务的窗口内事件(时序;引用共享,不复制),供微型事件链展开。 */
  readonly events: CadenceFeedEvent[];
}

function isTerminalStatus(status: SnapshotStatus): boolean {
  return status === "done" || status === "cancelled";
}

function sameDay(a: string | null, now: string): boolean {
  return a !== null && a.slice(0, 10) === now.slice(0, 10);
}

function later(current: string | null, next: string | null): string | null {
  if (next === null) return current;
  if (current === null || current < next) return next;
  return current;
}

function nonTerminalRow(row: TaskRow): boolean {
  return !isTerminalStatus(row.coordinationStatus) && row.packageDisposition === "active";
}

export function deriveCadenceSnapshot(input: CadenceInput): CadenceSnapshot {
  const now = input.now,
    rowsById = new Map(input.tasks.map((row) => [row.taskId, row])),
    byTask = new Map<string, TaskAccumulator>(),
    ensure = (taskId: string): TaskAccumulator => {
      const existing = byTask.get(taskId);
      if (existing !== undefined) return existing;
      const created: TaskAccumulator = {
        stages: new Map(),
        currentStage: null,
        firstAt: null,
        lastAt: null,
        count: 0,
        friction: { gateFail: 0, reviewChanges: 0, returned: 0, reopened: 0 },
        frictionTotal: 0,
        lastSignalAt: null,
        completedAt: null,
        bootstrapAt: null,
        events: [],
      };
      byTask.set(taskId, created);
      return created;
    };

  let completedToday = 0,
    factsToday = 0;
  const recentFacts: CadenceFactMark[] = [],
    moduleEvents = new Map<string, { tasks: Set<string>; events: number }>();
  const byKind: Record<CadenceFrictionKind, number> = { gateFail: 0, reviewChanges: 0, returned: 0, reopened: 0 };

  for (const event of input.events) {
    if (event.taskId !== null) {
      const acc = ensure(event.taskId);
      acc.count += 1;
      acc.events.push(event);
      if (event.at !== null && (acc.firstAt === null || event.at < acc.firstAt)) acc.firstAt = event.at;
      acc.lastAt = later(acc.lastAt, event.at);
      const stage = STAGE_BY_EVENT_TYPE[event.type];
      if (stage !== undefined && event.at !== null) {
        if (!acc.stages.has(stage)) acc.stages.set(stage, event.at);
        acc.currentStage = stage;
        if (stage === "bootstrap" && acc.bootstrapAt === null) acc.bootstrapAt = event.at;
        if (stage === "complete") acc.completedAt = later(acc.completedAt, event.at);
      }
      const frictionKind = frictionOf(event);
      if (frictionKind !== null) {
        acc.friction[frictionKind] += 1;
        acc.frictionTotal += 1;
        acc.lastSignalAt = later(acc.lastSignalAt, event.at);
        byKind[frictionKind] += 1;
      }
    }
    if (event.type === "task_completed" && sameDay(event.at, now)) completedToday += 1;
    if (event.type === "fact_recorded" && event.factId !== null) {
      if (sameDay(event.at, now)) factsToday += 1;
      recentFacts.push({ factId: event.factId, at: event.at });
    }
  }

  const rhythm: TaskRhythmEntry[] = [];
  const frictionTasks: CadenceFrictionTask[] = [];
  const stalledTasks: CadenceStalledTask[] = [];
  let activeTasks = 0,
    stalledActive = 0,
    completedInWindow = 0;
  const deliverySamples: number[] = [];
  const stalledCutoffMs = Date.parse(now) - CADENCE_STALLED_AFTER_MS;

  for (const row of input.tasks) {
    if (nonTerminalRow(row)) activeTasks += 1;
  }

  const entryOf = (taskId: string, acc: TaskAccumulator | null): TaskRhythmEntry => {
    const row = rowsById.get(taskId) ?? null,
      known = row !== null,
      status = row?.coordinationStatus ?? "unknown",
      stages = Object.fromEntries(
        CADENCE_STAGE_ORDER.map((stage) => [stage, acc?.stages.get(stage) ?? null]),
      ) as Record<CadenceStageId, string | null>,
      bootstrapAt = acc?.bootstrapAt ?? null,
      completedAt = acc?.completedAt ?? null,
      module = row?.module ?? null,
      deliveryMs =
        bootstrapAt !== null && completedAt !== null && acc !== null
          ? Date.parse(completedAt) - Date.parse(bootstrapAt)
          : null;
    if (completedAt !== null) completedInWindow += 1;
    if (deliveryMs !== null && Number.isFinite(deliveryMs) && deliveryMs >= 0) deliverySamples.push(deliveryMs);
    const lastSeenAt = later(acc?.lastAt ?? null, row?.lastKnownAt ?? null),
      stalled = known && nonTerminalRow(row!) && Date.parse(lastSeenAt ?? "") < stalledCutoffMs;
    if (stalled) {
      stalledActive += 1;
      stalledTasks.push({ taskId, title: row!.title, lastSeenAt });
    }
    if (module !== null && acc !== null && acc.count > 0) {
      const heat = moduleEvents.get(module) ?? { tasks: new Set<string>(), events: 0 };
      heat.tasks.add(taskId);
      heat.events += acc.count;
      moduleEvents.set(module, heat);
    }
    const elapsedRaw =
        acc !== null && acc.firstAt !== null ? Date.parse(acc.completedAt ?? now) - Date.parse(acc.firstAt) : null,
      microTruncated = Math.max(0, (acc?.events.length ?? 0) - CADENCE_MICRO_EVENTS);
    return {
      taskId,
      title: row?.title ?? taskId,
      status,
      module,
      known,
      stages,
      currentStage: acc?.currentStage ?? null,
      firstEventAt: acc?.firstAt ?? null,
      lastEventAt: acc?.lastAt ?? null,
      eventCount: acc?.count ?? 0,
      frictionTotal: acc?.frictionTotal ?? 0,
      deliveryMs,
      stalled,
      elapsedMs: elapsedRaw !== null && Number.isFinite(elapsedRaw) && elapsedRaw >= 0 ? elapsedRaw : null,
      timing: deriveStageTiming(stages),
      microEvents: microTruncated > 0 ? acc!.events.slice(-CADENCE_MICRO_EVENTS) : (acc?.events ?? []),
      microTruncated,
    };
  };

  for (const [taskId, acc] of byTask) {
    rhythm.push(entryOf(taskId, acc));
    if (acc.frictionTotal > 0) {
      const row = rowsById.get(taskId) ?? null;
      frictionTasks.push({
        taskId,
        title: row?.title ?? taskId,
        total: acc.frictionTotal,
        gateFail: acc.friction.gateFail,
        reviewChanges: acc.friction.reviewChanges,
        returned: acc.friction.returned,
        reopened: acc.friction.reopened,
        lastSignalAt: acc.lastSignalAt,
        high: acc.frictionTotal > CADENCE_FRICTION_ALERT_THRESHOLD,
      });
    }
  }
  // 投影里有、窗口内无事件的非终态任务:安静任务(停滞候选),如实呈现无事件。
  for (const row of input.tasks) {
    if (byTask.has(row.taskId) || !nonTerminalRow(row)) continue;
    rhythm.push(entryOf(row.taskId, null));
  }

  const lastActivityOf = (entry: TaskRhythmEntry): string =>
      entry.lastEventAt ?? input.tasks.find((row) => row.taskId === entry.taskId)?.lastKnownAt ?? "",
    avgDeliveryMs =
      deliverySamples.length === 0
        ? null
        : deliverySamples.reduce((sum, sample) => sum + sample, 0) / deliverySamples.length;

  return {
    hud: {
      activeTasks,
      stalledActive,
      avgDeliveryMs,
      completedToday,
      completedInWindow,
      awaitingHuman: input.awaitingHuman,
    },
    rhythm: [...rhythm].sort((left, right) => lastActivityOf(right).localeCompare(lastActivityOf(left))),
    friction: {
      byKind,
      tasks: [...frictionTasks].sort(
        (left, right) => right.total - left.total || (right.lastSignalAt ?? "").localeCompare(left.lastSignalAt ?? ""),
      ),
      highFrictionCount: frictionTasks.filter((task) => task.high).length,
      stalled: stalledTasks,
    },
    yield: {
      factsToday,
      recentFacts: recentFacts.slice(-CADENCE_RECENT_FACTS).reverse(),
      decisionsProposed: input.decisions.filter((decision) => decision.state === "proposed").length,
      decisionsInEffect: input.decisions.filter((decision) => decision.state === "in_effect").length,
      moduleHeat: [...moduleEvents.entries()]
        .map(([module, heat]) => ({ module, tasks: heat.tasks.size, events: heat.events }))
        .sort((left, right) => right.events - left.events || left.module.localeCompare(right.module))
        .slice(0, CADENCE_MODULE_TOP),
    },
  };
}

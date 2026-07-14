/**
 * 三原语统一索引 + 查询解析（gui-b Cmd+K 命令面板）。
 *
 * 关键背景:此前的 FocusSwitcher 只索引 task/decision 且结构性排除 fact,
 * ~143 decision / 数百 task / 上千 fact 的真实量级下「找不到东西」。
 * 本模块把三原语拍平成同一索引,并解析 `d:` / `t:` / `f:` / `decision/<id>`
 * 等前缀语法,让 Cmd+K 面板成为「从名字到实体」的统一入口。
 *
 * 不调 IPC,纯内存派生:tasks/decisions/facts 投影已在 renderer 里。
 */

import type { TaskRow, DecisionRow, FactRef } from "./types";

export type EntityKind = "task" | "decision" | "fact";

export interface EntityHit {
  kind: EntityKind;
  /**
   * navigate 回调认的 ref 形态:task/<id> | decision/<id> | fact/<task>/<anchor>。
   * 跟 ego byId key 不同(task 是裸 id);useEgoCanvas.openFocus 内部经 egoFocusIdOf 归一。
   */
  ref: string;
  /** 原始 id:taskId / decisionId / fact anchor(task/anchor 形态)。 */
  id: string;
  /** 显示主标题。 */
  title: string;
  /** 副标题(state / module / question / task host)。 */
  subtitle: string;
  /** 排序权重:decision > task > fact,承重/活跃度细化。 */
  weight: number;
}

export interface EntityIndexInput {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
}

/**
 * 把三原语投影拍平成统一索引。decision 优先(承重,最高权重),task 次之,
 * fact 最低(fact 是观察,不是工作面焦点候选,但仍需可被搜到)。
 */
export function buildEntityIndex({ tasks, decisions, facts }: EntityIndexInput): EntityHit[] {
  const decisionHits: EntityHit[] = decisions.map((d) => ({
    kind: "decision",
    ref: `decision/${d.decisionId}`,
    id: d.decisionId,
    title: d.title,
    subtitle: `${d.state} · ${d.claims.length} claim`,
    weight:
      1000
      + d.claims.length * 10
      + (d.state === "active" ? 5 : d.state === "proposed" ? 3 : 0),
  }));
  const taskHits: EntityHit[] = tasks.map((t) => ({
    kind: "task",
    ref: `task/${t.taskId}`,
    id: t.taskId,
    title: t.title,
    subtitle: `${t.coordinationStatus} · ${t.module || "—"}`,
    weight: 100,
  }));
  const factHits: EntityHit[] = facts.map((f) => {
    // 与 graph/graphLayoutShared.factRefOf 同形态:fact/<taskId>/<anchor 尾段>。
    // anchor 全文形如 task_x/F-a3f2,只取尾部作 ref;但 subtitle 带 taskId,
    // haystack 因此包含 task_x/F-a3f2 的可搜部分(两种写法都能命中)。
    const tail = f.anchor.split("/").pop() ?? f.anchor;
    return {
      kind: "fact",
      ref: `fact/${f.taskId}/${tail}`,
      id: tail,
      title: f.text,
      subtitle: `${f.taskId} · ${f.category}`,
      weight: 10,
    } satisfies EntityHit;
  });
  return [...decisionHits, ...taskHits, ...factHits].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.title.localeCompare(b.title);
  });
}

export interface ParsedQuery {
  /** null = 不限 kind;非 null = 只匹配该 kind。 */
  kind: EntityKind | null;
  /** 已剥掉前缀的子串,小写。空串 = 不过滤文本。 */
  text: string;
}

/** 短前缀(d:/t:/f:)与显式 ref 前缀(decision/ task/ fact/)都收。 */
const KIND_PREFIXES: Array<{ prefix: string; kind: EntityKind }> = [
  { prefix: "decision:", kind: "decision" },
  { prefix: "dec:", kind: "decision" },
  { prefix: "d:", kind: "decision" },
  { prefix: "decision/", kind: "decision" },
  { prefix: "task:", kind: "task" },
  { prefix: "t:", kind: "task" },
  { prefix: "task/", kind: "task" },
  { prefix: "fact:", kind: "fact" },
  { prefix: "f:", kind: "fact" },
  { prefix: "fact/", kind: "fact" },
];

/** 解析用户输入,分离出 kind 限定与剩余文本。 */
export function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return { kind: null, text: "" };
  for (const { prefix, kind } of KIND_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { kind, text: trimmed.slice(prefix.length).trim() };
    }
  }
  return { kind: null, text: trimmed };
}

/**
 * 用 ParsedQuery 过滤索引。空查询返回原列表(让面板首屏直接展示权重排序的全体 hit,
 * 用户「打开就能看到承重 decision」)。
 *
 * 文本匹配走「空格分词 AND」(跟原 FocusSwitcher 一致,不引入模糊匹配——P2)。
 */
export function searchEntities(hits: readonly EntityHit[], query: string): EntityHit[] {
  const { kind, text } = parseQuery(query);
  if (!text && !kind) return [...hits];
  const terms = text ? text.split(/\s+/u).filter(Boolean) : [];
  return hits.filter((hit) => {
    if (kind && hit.kind !== kind) return false;
    if (terms.length === 0) return true;
    const hay = `${hit.title} ${hit.id} ${hit.subtitle}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/**
 * 取权重最高的前 N 个实体,作为冷启动「Suggested」候选。
 * buildEntityIndex 已按 weight 排序(decision > task > fact),这里只切前 N。
 * 左栏 FocusSwitcher 在 Recent 为空时用它填充首屏,避免 256px 空白;排序口径
 * 与 Cmd+K 面板空查询时一致(同一索引),两个 find 入口「先看到承重 decision」对齐。
 */
export function selectSuggestedHits(hits: readonly EntityHit[], n = 8): EntityHit[] {
  return hits.slice(0, Math.max(0, n));
}

/** UI 分组用:按 kind 分桶,保留 weight 排序。 */
export function groupHitsByKind(hits: readonly EntityHit[]): Record<EntityKind, EntityHit[]> {
  const out: Record<EntityKind, EntityHit[]> = {
    task: [],
    decision: [],
    fact: [],
  };
  for (const hit of hits) out[hit.kind].push(hit);
  return out;
}

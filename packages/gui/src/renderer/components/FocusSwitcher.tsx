import { useMemo, useState } from "react";
import { MagnifyingGlass, Graph } from "@phosphor-icons/react";
import type { DecisionRow, TaskRow } from "../model/types";

/**
 * GraphView 焦点切换器(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性)。
 *
 * 移植原型 .harness/generated/triadic-graph/index.html 的左栏交互:
 *   - 顶部搜索框(标题子串匹配,空格分词 AND);
 *   - 列表按「关系度数」(claim / 边数)降序,承接原型 decs.sort(byDeg);
 *   - 点选 = 换焦点(setFocusId),并显示当前焦点高亮(active);
 *   - decisions 优先(tasks 在它之后,facts 不进列表——锚点而非焦点候选)。
 *
 * 不调后端、不读写 IPC;纯展示组件,焦点变更由父组件 GraphView 走 setFocusId。
 */

interface Props {
  decisions: DecisionRow[];
  tasks: TaskRow[];
  /** 当前焦点节点 id(decision/<id> | task/<id> | fact/...);列表命中即高亮。 */
  focusId: string | null;
  /** 用户点选实体时触发;父组件负责推焦点历史 + 触发布局重算。 */
  onFocus: (nodeId: string) => void;
}

const KIND_LABEL: Record<"decision" | "task", string> = {
  decision: "decision",
  task: "task",
};

const KIND_COLOR: Record<"decision" | "task", string> = {
  decision: "var(--color-accent)",
  task: "var(--color-axis-execution)",
};

interface ListItem {
  kind: "decision" | "task";
  id: string;
  nodeId: string;
  title: string;
  meta: string;
  weight: number;
}

/** 把搜索串切成查询段,空返回 null(表示不过滤)。 */
function splitQueryTerms(query: string): string[] | null {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.split(/\s+/u);
}

function matchesQuery(title: string, id: string, terms: string[] | null): boolean {
  if (!terms) return true;
  const hay = `${title} ${id}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

export function FocusSwitcher({ decisions, tasks, focusId, onFocus }: Props) {
  const [query, setQuery] = useState("");

  const items = useMemo<ListItem[]>(() => {
    const decisionItems: ListItem[] = decisions.map((d) => ({
      kind: "decision",
      id: d.decisionId,
      nodeId: `decision/${d.decisionId}`,
      title: d.title,
      meta: `${d.state} · ${d.claims.length} claim`,
      // claim 数 + 状态权重:active/proposed 优先。
      weight: d.claims.length * 10 + (d.state === "active" ? 5 : d.state === "proposed" ? 3 : 0),
    }));
    const taskItems: ListItem[] = tasks.map((t) => ({
      kind: "task",
      id: t.taskId,
      nodeId: t.taskId,
      title: t.title,
      meta: `${t.coordinationStatus} · ${t.module || "—"}`,
      // task 排在 decision 之后;同 kind 内按 module/title 稳定。
      weight: 0,
    }));
    // decisions 按 weight 降序;tasks 保留输入顺序(已按 module/project 排好)。
    decisionItems.sort((a, b) => b.weight - a.weight);
    return [...decisionItems, ...taskItems];
  }, [decisions, tasks]);

  const terms = splitQueryTerms(query);
  const visible = useMemo(
    () => items.filter((it) => matchesQuery(it.title, it.id, terms)),
    [items, terms],
  );

  const decisionCount = items.filter((it) => it.kind === "decision").length;

  return (
    <aside
      data-testid="focus-switcher"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Graph weight="duotone" className="shrink-0 text-text-muted" />
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          焦点切换
        </span>
        <span className="ml-auto font-mono text-[11px] text-text-faint">
          {decisionCount} 决策 · {items.length - decisionCount} 任务
        </span>
      </div>

      <label className="relative block border-b border-border px-2 py-2">
        <span className="sr-only">搜索焦点实体</span>
        <MagnifyingGlass
          weight="bold"
          className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索决策 / 任务…"
          className="w-full rounded-md border border-border bg-surface-raised py-1.5 pl-7 pr-2 text-[12px] text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-3 py-3 text-[12px] leading-relaxed text-text-faint">
            没有命中的实体。清空搜索看全部。
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {visible.map((it) => {
              const active = it.nodeId === focusId;
              const accent = KIND_COLOR[it.kind];
              return (
                <li key={`${it.kind}/${it.id}`}>
                  <button
                    type="button"
                    onClick={() => onFocus(it.nodeId)}
                    title={it.title}
                    aria-pressed={active}
                    className={`group flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors ${
                      active
                        ? "border-l-accent bg-accent/10 text-text"
                        : "border-l-transparent text-text-muted hover:bg-surface-raised hover:text-text"
                    }`}
                    style={active ? { borderColor: accent } : undefined}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: accent }}
                        aria-hidden="true"
                      />
                      <span
                        className={`font-mono text-[10px] uppercase tracking-wide ${
                          active ? "text-accent" : "text-text-faint"
                        }`}
                      >
                        {KIND_LABEL[it.kind]}
                      </span>
                      <span className="ml-auto truncate font-mono text-[10px] text-text-faint">
                        {it.meta}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-snug">
                      {it.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

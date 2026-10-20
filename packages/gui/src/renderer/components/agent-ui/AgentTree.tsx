import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";
import { compactTokens } from "../../token-format.ts";

/**
 * CEO → Commander → Squad → Worker 血缘调用树(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 /
 * Affect UI AgentTree):节点卡展示身份/模型/实时状态/单点耗时/单点 Token;父分支自动
 * 向上 Rollup 整棵子树的累计成本与耗时;一键折叠已完成分支。
 *
 * 计费纪律(checkpoint):每个节点只上报 own* 自身成本,rollupSubtree 严格按
 * Σ(own) 聚合,多层嵌套(Work→Task→Squad→Worker)不重复计费——父节点值永远等于
 * 子树 own 之和,父节点自身的 own 只算在它那一行。
 *
 * 状态色:running=青蓝 active / awaiting=agent-question 橙(Orca:提问态与执行态
 * 严格分色) / done=绿 / failed=红 / idle=中性灰。纯展示组件,无计时器;实时状态由
 * 调用方响应式数据流驱动。
 */

/** Agent 运行态五级词表:与 Orca 注意力模型同构,颜色语义映射见 ACTIVITY_COLOR。 */
export type AgentActivity = "running" | "awaiting" | "done" | "failed" | "idle";

export interface AgentTreeNode {
  readonly id: string;
  /** 身份:如 CEO / Commander / Squad Alpha / Worker-1。 */
  readonly role: string;
  readonly model?: string;
  readonly status: AgentActivity;
  /** 本节点自身 Token 成本,不含子树;缺省视为 0,不虚构。 */
  readonly ownTokens?: number;
  /** 本节点自身耗时 ms,不含子树。 */
  readonly ownDurationMs?: number;
  readonly children?: readonly AgentTreeNode[];
}

export const ACTIVITY_COLOR: Record<AgentActivity, string> = {
  running: "var(--color-status-active)",
  awaiting: "var(--color-agent-question)",
  done: "var(--color-status-done)",
  failed: "var(--color-danger)",
  idle: "var(--color-text-muted)",
};

/** 状态词表的人话标签:AgentLanes 图例等同词汇表消费方共用,不另抄一份。 */
export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  running: "运行中",
  awaiting: "待拍板",
  done: "完成",
  failed: "失败",
  idle: "空闲",
};

/** 终态:done/failed 之后不再变化,子树全终态即可整枝折叠。 */
const TERMINAL_ACTIVITY: ReadonlySet<AgentActivity> = new Set(["done", "failed"]);

export interface AgentRollup {
  /** 子树 Token 累计(含自身 own,每个节点只计一次)。 */
  readonly tokens: number;
  readonly durationMs: number;
  /** 子树是否全部终态(用于「折叠已完成分支」)。 */
  readonly finished: boolean;
  /** 子树后代节点总数(不含自身)。 */
  readonly descendants: number;
}

/** 子树 Rollup:递归求 own 之和;空子树回退到自身。导出供单测直证不重复计费。 */
export function rollupSubtree(node: AgentTreeNode): AgentRollup {
  let tokens = node.ownTokens ?? 0;
  let durationMs = node.ownDurationMs ?? 0;
  let finished = TERMINAL_ACTIVITY.has(node.status);
  let descendants = 0;
  for (const child of node.children ?? []) {
    const childRollup = rollupSubtree(child);
    tokens += childRollup.tokens;
    durationMs += childRollup.durationMs;
    finished = finished && childRollup.finished;
    descendants += 1 + childRollup.descendants;
  }
  return { tokens, durationMs, finished, descendants };
}

function activityBadge(status: AgentActivity): { readonly color: string; readonly label: string } {
  return { color: ACTIVITY_COLOR[status], label: ACTIVITY_LABEL[status] };
}

export function AgentTree({
  root,
  defaultCollapsedIds,
  testId,
}: {
  readonly root: AgentTreeNode;
  /** 初始折叠的节点 id;此后由组件内部管理。 */
  readonly defaultCollapsedIds?: readonly string[];
  readonly testId?: string;
}) {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set(defaultCollapsedIds ?? []));
  const [activeId, setActiveId] = useState(root.id);

  const toggle = useCallback((id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 一键折叠:所有「有子代且子树已全部终态」的分支收起。 */
  const collapseFinished = useCallback(() => {
    const next = new Set<string>();
    const visit = (node: AgentTreeNode) => {
      for (const child of node.children ?? []) {
        if ((child.children?.length ?? 0) > 0 && rollupSubtree(child).finished) next.add(child.id);
        visit(child);
      }
    };
    visit(root);
    setCollapsedIds(next);
  }, [root]);

  const hasCollapsibleBranch = useMemo(() => {
    let found = false;
    const visit = (node: AgentTreeNode) => {
      for (const child of node.children ?? []) {
        if ((child.children?.length ?? 0) > 0 && rollupSubtree(child).finished) found = true;
        visit(child);
      }
    };
    visit(root);
    return found;
  }, [root]);

  /** ARIA tree 键盘漫游:上下移行、右展开/入子、左折叠/回父、Home/End 首尾。 */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // 折叠按钮等内部交互件的按键走自身默认行为,冒泡到这里会二次切换。
      if (event.target !== event.currentTarget && (event.target as HTMLElement).closest("button") !== null) return;
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-id]"));
      const currentIndex = rows.findIndex((row) => row.dataset.treeId === activeId);
      if (currentIndex < 0) return;
      const focusRow = (index: number) => {
        const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
        if (row !== undefined) {
          setActiveId(row.dataset.treeId!);
          row.focus();
        }
      };
      const nodeById = (id: string): AgentTreeNode | null => {
        let found: AgentTreeNode | null = null;
        const visit = (node: AgentTreeNode) => {
          if (node.id === id) found = node;
          for (const child of node.children ?? []) visit(child);
        };
        visit(root);
        return found;
      };
      const current = nodeById(activeId);
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRow(currentIndex + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRow(currentIndex - 1);
          break;
        case "ArrowRight":
          if (current !== null && (current.children?.length ?? 0) > 0 && collapsedIds.has(current.id)) {
            event.preventDefault();
            toggle(current.id);
          } else {
            event.preventDefault();
            focusRow(currentIndex + 1);
          }
          break;
        case "ArrowLeft":
          if (current !== null && (current.children?.length ?? 0) > 0 && !collapsedIds.has(current.id)) {
            event.preventDefault();
            toggle(current.id);
          } else {
            event.preventDefault();
            focusRow(currentIndex - 1);
          }
          break;
        case "Home":
          event.preventDefault();
          focusRow(0);
          break;
        case "End":
          event.preventDefault();
          focusRow(rows.length - 1);
          break;
        case "Enter":
        case " ":
          if (current !== null && (current.children?.length ?? 0) > 0) {
            event.preventDefault();
            toggle(current.id);
          }
          break;
        default:
          break;
      }
    },
    [activeId, collapsedIds, root, toggle],
  );

  const renderRow = (node: AgentTreeNode, level: number) => {
    const rollup = rollupSubtree(node);
    const hasChildren = (node.children?.length ?? 0) > 0;
    const collapsed = collapsedIds.has(node.id);
    const badge = activityBadge(node.status);
    return (
      <div key={node.id} role="treeitem" aria-expanded={hasChildren ? !collapsed : undefined}>
        <div
          tabIndex={node.id === activeId ? 0 : -1}
          data-tree-id={node.id}
          data-testid={testId !== undefined ? `${testId}-row-${node.id}` : undefined}
          className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 ui-meta"
          style={{ marginLeft: level * 18 }}
          onFocus={() => setActiveId(node.id)}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={collapsed ? `展开 ${node.role}` : `折叠 ${node.role}`}
              data-testid={testId !== undefined ? `${testId}-toggle-${node.id}` : undefined}
              onClick={() => toggle(node.id)}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-text-faint hover:text-text"
            >
              {collapsed ? <CaretRight aria-hidden /> : <CaretDown aria-hidden />}
            </button>
          ) : (
            <span aria-hidden className="inline-block size-5 shrink-0" />
          )}
          <span
            aria-hidden
            className="size-[6px] shrink-0 rounded-full"
            style={{
              background: badge.color,
              boxShadow: `0 0 5px 1px color-mix(in oklch, ${badge.color} 50%, transparent)`,
            }}
          />
          <span className="min-w-0 shrink font-semibold">{node.role}</span>
          <span className="shrink-0 ui-micro text-text-faint">{badge.label}</span>
          {node.model !== undefined && (
            <span className="min-w-0 shrink truncate font-mono ui-micro text-text-muted" title={node.model}>
              {node.model}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono tabular-nums ui-micro text-text-muted">
            {node.ownTokens !== undefined && (
              <span title={`本节点 ${node.ownTokens} Token`}>{compactTokens(node.ownTokens)} tok</span>
            )}
            {node.ownDurationMs !== undefined && <span title="本节点耗时">{formatDuration(node.ownDurationMs)}</span>}
            {hasChildren && (
              <span
                data-tip={`子树累计:own 各计一次,含 ${rollup.descendants} 个后代`}
                className="rounded-xs border border-border px-1 py-px"
                style={{ color: rollup.finished ? "var(--color-text-faint)" : "var(--color-text)" }}
              >
                Σ {compactTokens(rollup.tokens)} tok · {formatDuration(rollup.durationMs)}
                {collapsed ? ` · ${rollup.descendants} 节点` : ""}
              </span>
            )}
          </span>
        </div>
        {hasChildren && !collapsed && (
          <div role="group" className="border-l border-border" style={{ marginLeft: level * 18 + 9 }}>
            {node.children!.map((child) => renderRow(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1">
      {(hasCollapsibleBranch || collapsedIds.size > 0) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid={testId !== undefined ? `${testId}-collapse-finished` : undefined}
            onClick={collapseFinished}
            className="rounded-sm px-1.5 py-0.5 ui-micro text-text-muted hover:bg-surface hover:text-text"
          >
            折叠已完成分支
          </button>
          {collapsedIds.size > 0 && (
            <button
              type="button"
              data-testid={testId !== undefined ? `${testId}-expand-all` : undefined}
              onClick={() => setCollapsedIds(new Set())}
              className="rounded-sm px-1.5 py-0.5 ui-micro text-text-muted hover:bg-surface hover:text-text"
            >
              展开全部
            </button>
          )}
        </div>
      )}
      <div role="tree" aria-label={`${root.role} 血缘树`} onKeyDown={onKeyDown} className="flex min-w-0 flex-col">
        {renderRow(root, 0)}
      </div>
    </div>
  );
}

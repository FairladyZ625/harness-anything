import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";
import { compactTokens } from "../../token-format.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";

/**
 * CEO → Commander → Squad → Worker 血缘调用树(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 /
 * Affect UI AgentTree):节点卡展示身份/模型/实时状态/单点耗时/单点 Token;父分支自动
 * 向上 Rollup 整棵子树的累计成本与耗时;一键折叠已完成分支。
 *
 * 计费纪律(checkpoint):每个节点只上报 own* 自身成本,rollupSubtree 严格按
 * Σ(own) 聚合,多层嵌套(Work→Task→Squad→Worker)不重复计费——父节点值永远等于
 * 子树 own 之和,父节点自身的 own 只算在它那一行。
 *
 * 原语复用(CEO 返工裁定 F2):状态词由 StatusTag(tone+label)渲染,按钮由
 * primitives/Button 渲染,文案经 agentUi.* i18n。treeitem 即焦点行本身(返工
 * 裁定 F6):role/tabIndex/aria-expanded 同节点,子组作为其后代保 ARIA 归属。
 * 纯展示组件,无计时器;实时状态由调用方响应式数据流驱动。
 */

/** Agent 运行态词表:与 Orca 注意力模型同构(终态非成功单列 cancelled,不冒充 done/failed);词面经 ACTIVITY_KEY 进 i18n,非文字表面用 ACTIVITY_COLOR。 */
export type AgentActivity = "running" | "awaiting" | "done" | "failed" | "cancelled" | "idle";

/**
 * 状态的非文字表面配色(泳道块描边/运行点等):awaiting 用 Orca 独立橙(agent-question,
 * 与 wait tone 的琥珀同族但在块面上更醒目)。状态「词」一律走 StatusTag,不经此表。
 */
export const ACTIVITY_COLOR: Record<AgentActivity, string> = {
  running: "var(--color-status-active)",
  awaiting: "var(--color-agent-question)",
  done: "var(--color-status-done)",
  failed: "var(--color-danger)",
  cancelled: "var(--color-status-cancelled)",
  idle: "var(--color-text-muted)",
};

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

/** 终态:done/failed/cancelled 之后不再变化,子树全终态即可整枝折叠。 */
const TERMINAL_ACTIVITY: ReadonlySet<AgentActivity> = new Set(["done", "failed", "cancelled"]);

/** 状态词 → StatusTag tone(CEO 映射:running→active、awaiting→wait、cancelled→cancel,done/failed/idle 同名族)。 */
export const ACTIVITY_TONE: Record<AgentActivity, StatusTone> = {
  running: "active",
  awaiting: "wait",
  done: "done",
  failed: "bad",
  cancelled: "cancel",
  idle: "neutral",
};

/** 状态词的 i18n 键:词面归 agentUi 命名空间,不建平行标签组件。 */
export const ACTIVITY_KEY: Record<AgentActivity, MessageKey> = {
  running: "agentUi.activity.running",
  awaiting: "agentUi.activity.awaiting",
  done: "agentUi.activity.done",
  failed: "agentUi.activity.failed",
  cancelled: "agentUi.activity.cancelled",
  idle: "agentUi.activity.idle",
};

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

export function AgentTree({
  root,
  defaultCollapsedIds,
  onNodeActivate,
  testId,
}: {
  readonly root: AgentTreeNode;
  /** 初始折叠的节点 id;此后由组件内部管理。 */
  readonly defaultCollapsedIds?: readonly string[];
  /**
   * 节点激活(点击行 / Enter):打开对应详情或会话转录的出口。id 是调用方域,激活语义
   * (task→详情、dispatch→会话)由调用方解读;折叠按钮与键盘漫游不受影响。
   */
  readonly onNodeActivate?: (node: AgentTreeNode) => void;
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
          // 激活出口存在时 Enter 是激活(与点击同义);没有出口时保留展开/折叠语义。
          if (onNodeActivate !== undefined) {
            if (current !== null) {
              event.preventDefault();
              onNodeActivate(current);
            }
          } else if (current !== null && (current.children?.length ?? 0) > 0) {
            event.preventDefault();
            toggle(current.id);
          }
          break;
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
    [activeId, collapsedIds, onNodeActivate, root, toggle],
  );

  const renderRow = (node: AgentTreeNode, level: number) => {
    const rollup = rollupSubtree(node);
    const hasChildren = (node.children?.length ?? 0) > 0;
    const collapsed = collapsedIds.has(node.id);
    const rowId = testId !== undefined ? `${testId}-row-${node.id}` : undefined;
    return (
      <div key={node.id} style={{ marginLeft: level * 18 }} className="min-w-0">
        <div
          role="treeitem"
          aria-level={level + 1}
          aria-expanded={hasChildren ? !collapsed : undefined}
          tabIndex={node.id === activeId ? 0 : -1}
          data-tree-id={node.id}
          data-testid={rowId}
          onClick={
            onNodeActivate === undefined
              ? undefined
              : (event) => {
                  // 折叠按钮自带 onClick 并冒泡到行;行激活只认行自身的点击。
                  if ((event.target as HTMLElement).closest("button") !== null) return;
                  onNodeActivate(node);
                }
          }
          className={`flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 ui-meta ${
            onNodeActivate === undefined ? "" : "cursor-pointer hover:bg-surface-raised"
          }`}
          onFocus={() => setActiveId(node.id)}
        >
          {hasChildren ? (
            <Button
              variant="ghost"
              size="sm"
              ariaLabel={t(collapsed ? "agentUi.tree.expand" : "agentUi.tree.collapse", { role: node.role })}
              testId={testId !== undefined ? `${testId}-toggle-${node.id}` : undefined}
              onClick={() => toggle(node.id)}
            >
              {collapsed ? <CaretRight aria-hidden /> : <CaretDown aria-hidden />}
            </Button>
          ) : (
            <span aria-hidden className="inline-block size-5 shrink-0" />
          )}
          <span className="min-w-0 shrink font-semibold">{node.role}</span>
          <StatusTag
            tone={ACTIVITY_TONE[node.status]}
            label={t(ACTIVITY_KEY[node.status])}
            testId={testId !== undefined ? `${testId}-status-${node.id}` : undefined}
          />
          {node.model !== undefined && (
            <span className="min-w-0 shrink truncate font-mono ui-micro text-text-muted" title={node.model}>
              {node.model}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono tabular-nums ui-micro text-text-muted">
            {node.ownTokens !== undefined && (
              <span title={t("agentUi.tree.ownTokensTip", { tokens: node.ownTokens })}>
                {compactTokens(node.ownTokens)} {t("agentUi.tree.tokenUnit")}
              </span>
            )}
            {node.ownDurationMs !== undefined && (
              <span title={t("agentUi.tree.ownDurationTip")}>{formatDuration(node.ownDurationMs)}</span>
            )}
            {hasChildren && (
              <span
                data-tip={t("agentUi.tree.rollupTip", { count: rollup.descendants })}
                className="rounded-xs border border-border px-1 py-px"
                style={{ color: rollup.finished ? "var(--color-text-faint)" : "var(--color-text)" }}
              >
                Σ {compactTokens(rollup.tokens)} {t("agentUi.tree.tokenUnit")} · {formatDuration(rollup.durationMs)}
                {collapsed ? ` · ${t("agentUi.tree.nodeCount", { count: rollup.descendants })}` : ""}
              </span>
            )}
          </span>
        </div>
        {hasChildren && !collapsed && (
          <div role="group" className="ml-2.5 flex min-w-0 flex-col border-l border-border">
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
          <Button
            variant="ghost"
            size="sm"
            testId={testId !== undefined ? `${testId}-collapse-finished` : undefined}
            onClick={collapseFinished}
          >
            {t("agentUi.tree.collapseFinished")}
          </Button>
          {collapsedIds.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              testId={testId !== undefined ? `${testId}-expand-all` : undefined}
              onClick={() => setCollapsedIds(new Set())}
            >
              {t("agentUi.tree.expandAll")}
            </Button>
          )}
        </div>
      )}
      <div
        role="tree"
        aria-label={t("agentUi.tree.treeLabel", { role: root.role })}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-col"
      >
        {renderRow(root, 0)}
      </div>
    </div>
  );
}

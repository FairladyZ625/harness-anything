import { Graph } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";

/**
 * 「在关系图中查看」统一入口(task_89d324b5)。
 *
 * 关系图的节点空间是五种实体 kind(task/decision/fact/agent/schedule),每种的详情页
 * 右上角都从这里取按钮 —— 一个实现按实体 ref 参数化,不在各详情页复制按钮代码。
 * 跳转走 App 的 focusEntityInGraph(ref)(与 Decision 详情页原有按钮同一条路:
 * 落 graph 视图 + focusedEntityRef,EntityWorkspace 收到焦点即切聚光灯)。
 * 回调缺省时按钮不渲染(与 Decision 原有按钮的缺省语义一致)。
 */
export function ViewInGraphButton({
  entityRef,
  onFocusGraph,
  className,
  testId = "view-in-graph-button",
}: {
  /** 图键空间实体引用:`task/<id>`、`decision/<id>`、`fact/<anchor>`、`agent/<id>`、`schedule/<id>`。 */
  readonly entityRef: string;
  /** 跳转并聚焦该实体;缺省不渲染。 */
  readonly onFocusGraph?: (ref: string) => void;
  readonly className?: string;
  readonly testId?: string;
}) {
  if (!onFocusGraph) return null;
  return (
    <button
      type="button"
      data-testid={testId}
      title={entityRef}
      onClick={() => onFocusGraph(entityRef)}
      className={
        className ??
        [
          "flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 font-mono ui-micro",
          "text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text",
        ].join(" ")
      }
    >
      <Graph weight="bold" className="ui-micro" />
      {t("components.viewInGraph.view")}
    </button>
  );
}

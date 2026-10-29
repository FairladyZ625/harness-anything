import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import { EgoNeighborhood, defaultNeighborhoodFilters, type EgoNeighborhoodFilters } from "./EgoNeighborhood";
import type { EgoHopBudget } from "./egoCanvas";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";
import { parseEndpoint } from "./endpoint";
import type { GraphFocusNodeIds } from "./focusSet";
import { FocusHistoryBar } from "../components/FocusHistoryBar";
import { FocusSwitcher } from "../components/FocusSwitcher";
import type { PaletteEntry } from "../components/CommandPalette";
import { EMPTY_HISTORY, canBack, canForward, focusHistoryReducer } from "../navigation/focusHistory";

/**
 * Relation Graph 画布宿主(dec_17A863CC CH3):页面级画布外壳只有这一份。
 *
 * 全局关系图页与工作页 Graph 页签渲染同一个组件,差别只有注入:
 *   - 数据与 scope:整份三元投影 / daemon `repo.work.topology.read` 预设的 work scope;
 *   - `overlay`:全局页的领地画布(ego 画布此时不渲染但保持挂载);
 *   - `panelSlot`:画布左上角的面板 —— 全局页塞筛选面板,工作页塞拓扑状态层。同一块
 *     画布上的不同图层,不是第二张画布。
 *
 * 画布本体、节点卡片、边抽屉、展开与跳数仍在 `EgoNeighborhood`(单一实现);焦点历史
 * (reducer + 前后退 + 面包屑)收在这里,两个宿主不再各持一份。
 */
/** 缺省筛选:模块级单例 —— 每次 render 新建一份会让画布每个 pass 都重排。 */
const DEFAULT_FILTERS = defaultNeighborhoodFilters();

export interface RelationCanvasStats {
  readonly nodes: number;
  readonly edges: number;
  readonly focusLabel: string | null;
}

/** 画布可渲染的数据面:全局页给整份投影,工作页给 daemon 拓扑裁出的行与边。 */
export interface RelationCanvasGraph {
  readonly tasks: ReadonlyArray<TaskRow>;
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly facts: ReadonlyArray<FactRef>;
  readonly relations: ReadonlyArray<RelationEdge>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly agents?: ReadonlyArray<AgentNodeRow>;
  readonly schedules?: ReadonlyArray<ScheduleNodeRow>;
  readonly governed?: ReadonlyArray<GovernedEntityRow>;
}

/** 左栏(最近访问 + 统一实体搜索);工作范围没有跨实体搜索,不传即可。 */
export interface RelationCanvasRail {
  readonly entries: ReadonlyArray<PaletteEntry>;
  readonly recentRefs?: ReadonlyArray<string>;
  readonly onFocus: (ref: string) => void;
  readonly onOpenPalette: () => void;
  readonly onSearchActiveChange?: (active: boolean) => void;
}

export interface RelationCanvasProps {
  /** 会话归属仓:egoSession 按 repoId 隔离。 */
  readonly repoId: string;
  /** global = 整份关系图;work = daemon 拓扑预设的单个工作范围(渲染标记,供断言与调试)。 */
  readonly scope: "global" | "work";
  readonly graph: RelationCanvasGraph;
  readonly focusRef: string | null;
  /** 换焦点的唯一出口:双击 / 设为焦点 / 左栏命中 / 历史前后退都走它。 */
  readonly onFocusChange: (ref: string | null) => void;
  /** 焦点历史条:领地面不显示(与改造前的全局页一致)。 */
  readonly historyVisible?: boolean;
  readonly rail?: RelationCanvasRail;
  readonly filters?: EgoNeighborhoodFilters;
  readonly focusSet?: GraphFocusNodeIds | null;
  readonly densityFocus?: boolean;
  readonly hops?: EgoHopBudget;
  readonly rememberSession?: boolean;
  /** false = 画布隐藏但保持挂载(宿主切到领地画布时保留累积态)。 */
  readonly active?: boolean;
  readonly cardHeightCap?: number;
  /** 画布容器:领地列数与长内容上限按宿主实测它。 */
  readonly canvasRef?: RefObject<HTMLDivElement | null>;
  /** 与 ego 画布并列的另一种画布(领地);ego 画布此时不渲染。 */
  readonly overlay?: ReactNode;
  /** 画布左上角面板(筛选面板 / 拓扑状态层)。 */
  readonly panelSlot?: ReactNode;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  readonly onLayoutStats?: (stats: RelationCanvasStats) => void;
}

export function RelationCanvas({
  repoId,
  scope,
  graph,
  focusRef,
  onFocusChange,
  historyVisible = true,
  rail,
  filters,
  focusSet = null,
  densityFocus = false,
  hops,
  rememberSession = false,
  active = true,
  cardHeightCap,
  canvasRef,
  overlay,
  panelSlot,
  onNavigateEntity,
  onSetTaskPin,
  onLayoutStats,
}: RelationCanvasProps) {
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const reportStats = useCallback(
    (stats: RelationCanvasStats) => {
      setFocusLabel((current) => (current === stats.focusLabel ? current : stats.focusLabel));
      onLayoutStats?.(stats);
    },
    [onLayoutStats],
  );

  // 焦点历史:push 由焦点变化驱动,back/forward 只移指针,clear 清栈。
  const [hist, dispatch] = useReducer(focusHistoryReducer, EMPTY_HISTORY);
  useEffect(() => {
    if (focusRef) dispatch({ type: "push", ref: focusRef });
  }, [focusRef]);
  const goBack = useCallback(() => {
    dispatch({ type: "back" });
    const prev = hist.stack[hist.index - 1];
    if (prev) onFocusChange(prev);
  }, [hist, onFocusChange]);
  const goForward = useCallback(() => {
    dispatch({ type: "forward" });
    const next = hist.stack[hist.index + 1];
    if (next) onFocusChange(next);
  }, [hist, onFocusChange]);
  const clearFocus = useCallback(() => {
    dispatch({ type: "clear" });
    onFocusChange(null);
    // 画布累积态由 EgoNeighborhood 在 focusRef→null 时自清。
  }, [onFocusChange]);

  // 画布回调必须引用稳定:EgoNeighborhood 的可见节点 memo 依赖它们,每次 render 新建
  // 函数会让布局/统计副作用每 pass 重跑一遍(实测退化成无限 setState)。
  const refocus = useCallback((ref: string) => onFocusChange(ref), [onFocusChange]);

  const breadcrumb = useMemo(() => {
    const parsed = focusRef ? parseEndpoint(focusRef) : null;
    return parsed ? { kindLabel: parsed.entity, title: focusLabel ?? parsed.id, nodeId: parsed.id } : null;
  }, [focusRef, focusLabel]);

  return (
    <div data-testid="relation-canvas" data-scope={scope} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {historyVisible && (
        <FocusHistoryBar
          canBack={canBack(hist)}
          canForward={canForward(hist)}
          breadcrumb={breadcrumb}
          onBack={goBack}
          onForward={goForward}
          onClear={clearFocus}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {rail && (
          <FocusSwitcher
            recentRefs={rail.recentRefs ?? []}
            entries={rail.entries}
            focusRef={focusRef}
            onFocus={rail.onFocus}
            onOpenPalette={rail.onOpenPalette}
            {...(rail.onSearchActiveChange ? { onSearchActiveChange: rail.onSearchActiveChange } : {})}
          />
        )}
        <div ref={canvasRef} className="relative flex min-h-0 min-w-0 flex-1">
          {overlay}
          <EgoNeighborhood
            repoId={repoId}
            rememberSession={rememberSession}
            {...(cardHeightCap === undefined ? {} : { cardHeightCap })}
            focusRef={focusRef}
            tasks={graph.tasks}
            decisions={graph.decisions}
            facts={graph.facts}
            relations={graph.relations}
            factAnchors={graph.factAnchors}
            {...(graph.agents ? { agents: graph.agents } : {})}
            {...(graph.schedules ? { schedules: graph.schedules } : {})}
            {...(graph.governed ? { governed: graph.governed } : {})}
            filters={filters ?? DEFAULT_FILTERS}
            focusSet={focusSet}
            densityFocus={densityFocus}
            {...(hops ? { hops } : {})}
            {...(onNavigateEntity ? { onNavigateEntity } : {})}
            {...(onSetTaskPin ? { onSetTaskPin } : {})}
            onRefocus={refocus}
            onLayoutStats={reportStats}
            {...(panelSlot ? { panelSlot } : {})}
            active={active}
          />
        </div>
      </div>
    </div>
  );
}

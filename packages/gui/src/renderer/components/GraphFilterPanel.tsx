import { useState } from "react";
import { Funnel, SquaresFour, Graph, Bandaids, CaretDown, CaretRight } from "@phosphor-icons/react";
import {
  AXIS_COLOR_VAR,
  AXIS_LABEL,
  AXIS_SUBLABEL,
  AXIS_ORDER,
  type SemanticAxis,
} from "../graph/constants";

export type EntityType = "decision" | "task" | "fact";

export interface AxisFilterState {
  authority: boolean;
  evidence: boolean;
  execution: boolean;
  assoc: boolean;
}

export interface GraphFilters {
  modules: Set<string>;
  types: Set<EntityType>;
  axes: AxisFilterState;
}

interface Props {
  filters: GraphFilters;
  setFilters: (f: GraphFilters | ((prev: GraphFilters) => GraphFilters)) => void;
  availableModules: string[];
}

export function GraphFilterPanel({ filters, setFilters, availableModules }: Props) {
  const toggleModule = (mod: string) => {
    setFilters((prev) => {
      const next = new Set(prev.modules);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return { ...prev, modules: next };
    });
  };

  const toggleType = (t: EntityType) => {
    setFilters((prev) => {
      const next = new Set(prev.types);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return { ...prev, types: next };
    });
  };

  const toggleAxis = (axis: SemanticAxis) => {
    setFilters((prev) => ({
      ...prev,
      axes: { ...prev.axes, [axis]: !prev.axes[axis] },
    }));
  };

  // 默认收起:这个面板是覆盖在画布上的浮层,常驻展开会永久吃掉左上角 ——
  // 聚光灯模式下压住焦点卡片,领地模式下压住第一个领地块。收起态是一颗 pill,
  // 上面标出「已收窄」的筛选数,状态一眼可见,画布还给内容。
  const [open, setOpen] = useState(false);
  const narrowed =
    AXIS_ORDER.filter((a) => !filters.axes[a]).length +
    (3 - filters.types.size) +
    Math.max(0, availableModules.length - filters.modules.size);

  return (
    <div
      className={`flex flex-col rounded-lg border border-border bg-surface shadow-sm pointer-events-auto ${open ? "gap-3 w-[260px]" : ""}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起筛选面板" : "展开筛选面板"}
        className={`flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised rounded-lg ${open ? "border-b border-border rounded-b-none" : ""}`}
      >
        {open ? (
          <CaretDown weight="bold" className="text-text-faint text-[10px]" />
        ) : (
          <CaretRight weight="bold" className="text-text-faint text-[10px]" />
        )}
        <Funnel weight="duotone" className="text-text-muted" />
        <span className="font-mono text-xs font-semibold text-text">Filters</span>
        {!open && narrowed > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px] text-accent-fg">
            {narrowed}
          </span>
        )}
      </button>

      {/* D4:nowheel + max-h + overflow-y-auto。此面板浮在画布上(ReactFlow Panel),滚轮原本会被
          d3-zoom 吞掉缩放画布;加 nowheel 让滚轮滚动面板内容,max-h 防止模块多时撑出视口。*/}
      <div className={`nowheel px-3 pb-3 flex-col gap-4 ${open ? "flex max-h-[60vh] overflow-y-auto" : "hidden"}`}>
        {/* Semantic Axis Filter */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono uppercase tracking-wide">
            <Bandaids weight="bold" />
            <span>语义轴</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {AXIS_ORDER.map((axis) => {
              const active = filters.axes[axis];
              const color = AXIS_COLOR_VAR[axis];
              return (
                <button
                  key={axis}
                  onClick={() => toggleAxis(axis)}
                  title={AXIS_SUBLABEL[axis]}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10.5px] transition-colors ${
                    active
                      ? "bg-surface-raised text-text border border-border"
                      : "bg-surface text-text-faint border border-border/40 opacity-60"
                  }`}
                >
                  <span
                    className="inline-block h-2.5 w-4 rounded-sm shrink-0"
                    style={{
                      backgroundColor: color,
                      opacity: active ? 1 : 0.4,
                    }}
                  />
                  <span className="font-medium">{AXIS_LABEL[axis]}</span>
                  <span className="ml-auto font-mono text-[9px] text-text-faint truncate">
                    {AXIS_SUBLABEL[axis]}
                  </span>
                </button>
              );
            })}
            <div className="text-[9.5px] text-text-faint mt-0.5 leading-snug">
              默认关 assoc(relates),减少噪音;点开切换。
            </div>
          </div>
        </div>

        {/* Module Filter */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono uppercase tracking-wide">
            <SquaresFour weight="bold" />
            <span>Modules</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {availableModules.map((mod) => {
              const active = filters.modules.has(mod);
              return (
                <button
                  key={mod}
                  onClick={() => toggleModule(mod)}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    active
                      ? "bg-accent/10 text-accent border border-accent/30"
                      : "bg-surface-raised text-text-muted border border-border hover:bg-border/50"
                  }`}
                >
                  {mod}
                </button>
              );
            })}
          </div>
        </div>

        {/* Entity Type Filter */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono uppercase tracking-wide">
            <Graph weight="bold" />
            <span>Entity Types</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["decision", "task", "fact"] as const).map((t) => {
              const active = filters.types.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    active
                      ? "bg-stale/10 text-stale border border-stale/30"
                      : "bg-surface-raised text-text-muted border border-border hover:bg-border/50"
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

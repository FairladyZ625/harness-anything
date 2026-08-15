import { useState } from "react";
import {
  Funnel,
  SquaresFour,
  Graph,
  Bandaids,
  CaretDown,
  CaretRight,
  WaveSine,
  GitBranch,
  CircleHalf,
} from "@phosphor-icons/react";
import {
  AXIS_COLOR_VAR,
  axisLabel,
  AXIS_ORDER,
  AXIS_SUBLABEL,
  KIND_LABEL,
  type SemanticAxis,
} from "../graph/constants";
import {
  RELATION_KIND_ORDER,
  kindsByAxis,
  type FlowAnimMode,
} from "../graph/relationVisual";
import {
  TASK_STATUS_FILTER_OPTIONS,
  DECISION_STATE_FILTER_OPTIONS,
  OTHER_STATUS_BUCKET,
  defaultEntityStatusFilter,
  isEntityStatusFilterNarrowed,
  taskStatusOffCount,
  decisionStateOffCount,
  type TaskStatusFilterKey,
  type DecisionStateFilterKey,
  type EntityStatusFilterState,
} from "../graph/entityStatusFilter";
import type { DecisionState, RelationKind, SnapshotStatus } from "../model/types";
import { STATUS_META } from "./badges";
import { t } from "../i18n/index.tsx";

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
  kinds: Set<RelationKind>;
  entityStatus: EntityStatusFilterState;
}

interface Props {
  filters: GraphFilters;
  setFilters: (f: GraphFilters | ((prev: GraphFilters) => GraphFilters)) => void;
  availableModules: string[];
  /**
   * 实体类型筛选段是否可见。单种类领地(task/decision/fact skel)下类型由 skel
   * 子开关独占(隐藏此段,避免一个维度两处控件);聚光灯 / 全域(unified)下保留。
   * 默认 true。
   */
  showEntityTypes?: boolean;
  flowMode: FlowAnimMode;
  onFlowModeChange: (mode: FlowAnimMode) => void;
}

function decisionStateLabel(state: DecisionState | typeof OTHER_STATUS_BUCKET): string {
  if (state === OTHER_STATUS_BUCKET) return t("components.graphFilterPanel.statusOther");
  const map: Record<DecisionState, Parameters<typeof t>[0]> = {
    proposed: "components.badges.pendingDecisionApproval",
    active: "components.badges.takingEffect",
    deferred: "components.badges.suspended",
    rejected: "components.badges.rejected",
    retired: "components.badges.retired",
  };
  const key = map[state];
  return key ? t(key) : state;
}

function taskStatusLabel(status: SnapshotStatus | typeof OTHER_STATUS_BUCKET): string {
  if (status === OTHER_STATUS_BUCKET) return t("components.graphFilterPanel.statusOther");
  return STATUS_META[status]?.label ?? status;
}

const FLOW_MODES: ReadonlyArray<FlowAnimMode> = ["focus", "all", "off"];

export function GraphFilterPanel({
  filters,
  setFilters,
  availableModules,
  showEntityTypes = true,
  flowMode,
  onFlowModeChange,
}: Props) {
  const toggleModule = (mod: string) =>
    setFilters((prev) => {
      const next = new Set(prev.modules);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return { ...prev, modules: next };
    });

  const toggleType = (entityType: EntityType) =>
    setFilters((prev) => {
      const next = new Set(prev.types);
      if (next.has(entityType)) next.delete(entityType);
      else next.add(entityType);
      return { ...prev, types: next };
    });

  const toggleAxis = (axis: SemanticAxis) =>
    setFilters((prev) => ({ ...prev, axes: { ...prev.axes, [axis]: !prev.axes[axis] } }));

  const toggleKind = (kind: RelationKind) =>
    setFilters((prev) => {
      const next = new Set(prev.kinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return { ...prev, kinds: next };
    });

  const setAllKinds = (on: boolean) =>
    setFilters((prev) => ({ ...prev, kinds: on ? new Set(RELATION_KIND_ORDER) : new Set() }));

  const toggleTaskStatus = (key: TaskStatusFilterKey) =>
    setFilters((prev) => {
      const cur = prev.entityStatus ?? defaultEntityStatusFilter();
      const next = new Set(cur.taskStatuses);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, entityStatus: { ...cur, taskStatuses: next } };
    });

  const toggleDecisionState = (key: DecisionStateFilterKey) =>
    setFilters((prev) => {
      const cur = prev.entityStatus ?? defaultEntityStatusFilter();
      const next = new Set(cur.decisionStates);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, entityStatus: { ...cur, decisionStates: next } };
    });

  const setAllTaskStatuses = (on: boolean) =>
    setFilters((prev) => {
      const cur = prev.entityStatus ?? defaultEntityStatusFilter();
      return {
        ...prev,
        entityStatus: {
          ...cur,
          taskStatuses: on
            ? new Set<TaskStatusFilterKey>([...TASK_STATUS_FILTER_OPTIONS, OTHER_STATUS_BUCKET])
            : new Set(),
        },
      };
    });

  const setAllDecisionStates = (on: boolean) =>
    setFilters((prev) => {
      const cur = prev.entityStatus ?? defaultEntityStatusFilter();
      return {
        ...prev,
        entityStatus: {
          ...cur,
          decisionStates: on
            ? new Set<DecisionStateFilterKey>([...DECISION_STATE_FILTER_OPTIONS, OTHER_STATUS_BUCKET])
            : new Set(),
        },
      };
    });

  const [open, setOpen] = useState(false);
  const entityStatus = filters.entityStatus ?? defaultEntityStatusFilter();
  const kindOff = RELATION_KIND_ORDER.length - filters.kinds.size;
  const statusOff =
    Math.max(0, taskStatusOffCount(entityStatus)) +
    Math.max(0, decisionStateOffCount(entityStatus));
  const narrowed =
    AXIS_ORDER.filter((a) => !filters.axes[a]).length +
    (showEntityTypes ? Math.max(0, 3 - filters.types.size) : 0) +
    Math.max(0, availableModules.length - filters.modules.size) +
    Math.max(0, kindOff) +
    statusOff;

  const byAxis = kindsByAxis();
  const cycleFlow = () => {
    const i = FLOW_MODES.indexOf(flowMode);
    onFlowModeChange(FLOW_MODES[(i + 1) % FLOW_MODES.length]!);
  };
  const flowLabel = flowMode === "off" ? t("components.graphFilterPanel.flowOff") : flowMode === "all" ? t("components.graphFilterPanel.flowAll") : t("components.graphFilterPanel.flowFocus");

  return (
    <div
      className={`flex flex-col rounded-lg border border-border bg-surface shadow-sm pointer-events-auto ${
        open ? "gap-3 w-[300px]" : ""
      }`}
    >
      <div className={`flex items-center ${open ? "border-b border-border" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? t("components.graphFilterPanel.collapseFilterPanel") : t("components.graphFilterPanel.expandFilterPanel")}
          className={`flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised ${
            open ? "rounded-t-lg" : "rounded-l-lg"
          }`}
        >
          {open ? (
            <CaretDown weight="bold" className="text-[11px] text-text-faint" />
          ) : (
            <CaretRight weight="bold" className="text-[11px] text-text-faint" />
          )}
          <Funnel weight="duotone" className="text-text-muted" />
          <span className="font-mono text-xs font-semibold text-text">{t("components.graphFilterPanel.filters")}</span>
          {!open && narrowed > 0 && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[11px] text-accent-fg">
              {narrowed}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={cycleFlow}
          title={t("components.graphFilterPanel.flowToggleHint")}
          className={`flex items-center gap-1 border-l border-border px-2.5 py-2 text-[11px] font-mono text-text-muted hover:bg-surface-raised hover:text-text ${
            open ? "rounded-tr-lg" : "rounded-r-lg"
          }`}
        >
          <WaveSine weight="bold" className="text-[12px]" />
          <span>{flowLabel}</span>
        </button>
      </div>

      <div className={`nowheel px-3 pb-3 flex-col gap-4 ${open ? "flex max-h-[60vh] overflow-y-auto" : "hidden"}`}>
        {/* 语义轴 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wide text-text-muted">
            <Bandaids weight="bold" />
            <span>{t("components.graphFilterPanel.semanticAxis")}</span>
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
                      ? "border border-border bg-surface-raised text-text"
                      : "border border-border/40 bg-surface text-text-faint opacity-60"
                  }`}
                >
                  <span
                    className="inline-block h-2.5 w-4 shrink-0 rounded-sm"
                    style={{ backgroundColor: color, opacity: active ? 1 : 0.4 }}
                  />
                  <span className="font-medium">{axisLabel(axis)}</span>
                  <span className="ml-auto truncate font-mono text-[11px] text-text-faint">
                    {AXIS_SUBLABEL[axis]}
                  </span>
                </button>
              );
            })}
            <div className="mt-0.5 text-[9.5px] leading-snug text-text-faint">
              {t("components.graphFilterPanel.assocRelatesTurnedOffByDefaultReduce")}
            </div>
          </div>
        </div>

        {/* 关系类型 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-muted">
            <GitBranch weight="bold" />
            <span>{t("components.graphFilterPanel.relationTypes")}</span>
            <span className="ml-auto flex gap-1 normal-case tracking-normal">
              <button onClick={() => setAllKinds(true)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsAll")}</button>
              <button onClick={() => setAllKinds(false)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsNone")}</button>
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {AXIS_ORDER.map((axis) => {
              const kinds = byAxis[axis];
              if (kinds.length === 0) return null;
              return (
                <div key={axis} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: AXIS_COLOR_VAR[axis] }} />
                    <span className="font-mono text-[11px] uppercase text-text-faint">{axisLabel(axis)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {kinds.map((kind) => {
                      const active = filters.kinds.has(kind);
                      return (
                        <button
                          key={kind}
                          onClick={() => toggleKind(kind)}
                          title={kind}
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                            active
                              ? "border border-border bg-surface-raised text-text"
                              : "border border-border/40 bg-surface text-text-faint opacity-50"
                          }`}
                        >
                          {KIND_LABEL[kind] ?? kind}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 模块 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-muted">
            <SquaresFour weight="bold" />
            <span>{t("components.graphFilterPanel.modules")}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {availableModules.map((mod) => {
              const active = filters.modules.has(mod);
              return (
                <button
                  key={mod}
                  onClick={() => toggleModule(mod)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border border-accent/30 bg-accent/10 text-accent"
                      : "border border-border bg-surface-raised text-text-muted hover:bg-border/50"
                  }`}
                >
                  {mod}
                </button>
              );
            })}
            {availableModules.length === 0 && (
              <span className="text-[11px] text-text-faint">{t("components.graphFilterPanel.modulesEmpty")}</span>
            )}
          </div>
        </div>

        {/* 实体类型:单种类领地下隐藏(skel 独占类型)。 */}
        {showEntityTypes && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-muted">
            <Graph weight="bold" />
            <span>{t("components.graphFilterPanel.entityTypes")}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["decision", "task", "fact"] as const).map((entityType) => {
              const active = filters.types.has(entityType);
              return (
                <button
                  key={entityType}
                  onClick={() => toggleType(entityType)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border border-stale/30 bg-stale/10 text-stale"
                      : "border border-border bg-surface-raised text-text-muted hover:bg-border/50"
                  }`}
                >
                  {entityType.charAt(0).toUpperCase() + entityType.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* 实体状态 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-muted">
            <CircleHalf weight="bold" />
            <span>{t("components.graphFilterPanel.entityStatus")}</span>
            {isEntityStatusFilterNarrowed(entityStatus) && (
              <button
                onClick={() =>
                  setFilters((prev) => ({ ...prev, entityStatus: defaultEntityStatusFilter() }))
                }
                className="ml-auto rounded px-1 py-0.5 text-[11px] normal-case tracking-normal text-text-faint hover:bg-surface-raised hover:text-text"
              >
                {t("components.graphFilterPanel.statusReset")}
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] uppercase text-text-faint">{t("components.graphFilterPanel.taskStatus")}</span>
              <span className="ml-auto flex gap-1 normal-case tracking-normal">
                <button onClick={() => setAllTaskStatuses(true)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsAll")}</button>
                <button onClick={() => setAllTaskStatuses(false)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsNone")}</button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {TASK_STATUS_FILTER_OPTIONS.map((status) => {
                const active = entityStatus.taskStatuses.has(status);
                return (
                  <button
                    key={status}
                    onClick={() => toggleTaskStatus(status)}
                    title={status}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      active
                        ? "border border-border bg-surface-raised text-text"
                        : "border border-border/40 bg-surface text-text-faint opacity-50"
                    }`}
                    style={active && STATUS_META[status] ? { color: STATUS_META[status].color } : undefined}
                  >
                    {taskStatusLabel(status)}
                  </button>
                );
              })}
              <button
                onClick={() => toggleTaskStatus(OTHER_STATUS_BUCKET)}
                title={t("components.graphFilterPanel.statusOtherHint")}
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                  entityStatus.taskStatuses.has(OTHER_STATUS_BUCKET)
                    ? "border border-border bg-surface-raised text-text"
                    : "border border-border/40 bg-surface text-text-faint opacity-50"
                }`}
              >
                {taskStatusLabel(OTHER_STATUS_BUCKET)}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] uppercase text-text-faint">{t("components.graphFilterPanel.decisionState")}</span>
              <span className="ml-auto flex gap-1 normal-case tracking-normal">
                <button onClick={() => setAllDecisionStates(true)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsAll")}</button>
                <button onClick={() => setAllDecisionStates(false)} className="rounded px-1 py-0.5 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text">{t("components.graphFilterPanel.kindsNone")}</button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {DECISION_STATE_FILTER_OPTIONS.map((state) => {
                const active = entityStatus.decisionStates.has(state);
                return (
                  <button
                    key={state}
                    onClick={() => toggleDecisionState(state)}
                    title={state}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      active
                        ? "border border-border bg-surface-raised text-text"
                        : "border border-border/40 bg-surface text-text-faint opacity-50"
                    }`}
                  >
                    {decisionStateLabel(state)}
                  </button>
                );
              })}
              <button
                onClick={() => toggleDecisionState(OTHER_STATUS_BUCKET)}
                title={t("components.graphFilterPanel.statusOtherHint")}
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                  entityStatus.decisionStates.has(OTHER_STATUS_BUCKET)
                    ? "border border-border bg-surface-raised text-text"
                    : "border border-border/40 bg-surface text-text-faint opacity-50"
                }`}
              >
                {decisionStateLabel(OTHER_STATUS_BUCKET)}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

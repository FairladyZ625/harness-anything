import { useId, useState } from "react";
import {
  Funnel,
  Graph,
  Bandaids,
  CaretDown,
  CaretRight,
  WaveSine,
  GitBranch,
  CircleHalf,
  Crosshair,
} from "@phosphor-icons/react";
import {
  AXIS_COLOR_VAR,
  axisLabel,
  AXIS_ORDER,
  AXIS_SUBLABEL,
  KIND_LABEL,
  type SemanticAxis,
} from "../graph/constants";
import { RELATION_KIND_ORDER, kindsByAxis, type FlowAnimMode } from "../graph/relationVisual";
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
import { SegCtl } from "./primitives/SegCtl.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 图节点的实体种类。**没有清单**:取值是 daemon 已注册 kind 读面上的 kind 字符串
 * (内核内建 kind + 当前仓库 vertical 声明的 kind),筛选面板从 props 收下可选项。
 */
export type EntityType = string;

/** 一个可筛选的实体种类:kind 是机器字面量,label 是声明里的显示名。 */
export interface EntityTypeOption {
  readonly kind: EntityType;
  readonly label: string;
}

/** 密度分层:重点模式(默认)只看 pinned/在飞/最近变更 + 一跳邻域,其余折叠。 */
export type GraphDensityMode = "focus" | "all";

export interface AxisFilterState {
  authority: boolean;
  evidence: boolean;
  execution: boolean;
  assoc: boolean;
}

export interface GraphFilters {
  types: Set<EntityType>;
  axes: AxisFilterState;
  kinds: Set<RelationKind>;
  entityStatus: EntityStatusFilterState;
  density: GraphDensityMode;
}

interface Props {
  filters: GraphFilters;
  setFilters: (f: GraphFilters | ((prev: GraphFilters) => GraphFilters)) => void;
  /**
   * 实体类型筛选段是否可见。单种类领地(task/decision/fact skel)下类型由 skel
   * 子开关独占(隐藏此段,避免一个维度两处控件);聚光灯 / 全域(unified)下保留。
   * 默认 true。
   */
  showEntityTypes?: boolean;
  /** 可筛选的实体种类;来源是已注册 kind 读面,面板不持有第二份清单。 */
  entityTypeOptions: readonly EntityTypeOption[];
  /**
   * 密度分层段是否可见。单种类领地下重点集的邻域(decision/fact/agent/schedule)
   * 多半不在场,分层意义小,隐藏;聚光灯 / 全域下保留。默认 true。
   */
  showDensity?: boolean;
  flowMode: FlowAnimMode;
  onFlowModeChange: (mode: FlowAnimMode) => void;
}

function decisionStateLabel(state: DecisionState | typeof OTHER_STATUS_BUCKET): string {
  if (state === OTHER_STATUS_BUCKET) return t("components.graphFilterPanel.statusOther");
  const map: Record<DecisionState, Parameters<typeof t>[0]> = {
    proposed: "components.badges.pendingDecisionApproval",
    in_effect: "components.badges.takingEffect",
    deferred: "components.badges.suspended",
    rejected: "components.badges.rejected",
    superseded: "components.badges.superseded",
    outcome_retired: "components.badges.retired",
    unknown: "components.badges.unknown",
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
  entityTypeOptions,
  showEntityTypes = true,
  showDensity = true,
  flowMode,
  onFlowModeChange,
}: Props) {
  const toggleType = (entityType: EntityType) =>
    setFilters((prev) => {
      const next = new Set(prev.types);
      if (next.has(entityType)) next.delete(entityType);
      else next.add(entityType);
      return { ...prev, types: next };
    });

  const setDensity = (density: GraphDensityMode) => setFilters((prev) => ({ ...prev, density }));

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
  const bodyId = useId();
  // Presentation priority only; selectable kinds still come exclusively from the catalog.
  const commonTypes = entityTypeOptions.filter(({ kind }) => ["task", "decision", "fact"].includes(kind));
  const moreTypes = entityTypeOptions.filter((option) => !commonTypes.includes(option));
  const entityStatus = filters.entityStatus ?? defaultEntityStatusFilter();
  const kindOff = RELATION_KIND_ORDER.length - filters.kinds.size;
  const statusOff = Math.max(0, taskStatusOffCount(entityStatus)) + Math.max(0, decisionStateOffCount(entityStatus));
  const narrowed =
    AXIS_ORDER.filter((a) => !filters.axes[a]).length +
    (showEntityTypes ? Math.max(0, entityTypeOptions.length - filters.types.size) : 0) +
    (showDensity && filters.density === "all" ? 1 : 0) +
    Math.max(0, kindOff) +
    statusOff;

  const byAxis = kindsByAxis();
  const cycleFlow = () => {
    const i = FLOW_MODES.indexOf(flowMode);
    onFlowModeChange(FLOW_MODES[(i + 1) % FLOW_MODES.length]!);
  };
  const flowLabel =
    flowMode === "off"
      ? t("components.graphFilterPanel.flowOff")
      : flowMode === "all"
        ? t("components.graphFilterPanel.flowAll")
        : t("components.graphFilterPanel.flowFocus");

  return (
    <div data-testid="graph-filter-panel" className="relative pointer-events-auto inline-flex flex-col">
      <div className="glass flex items-center rounded-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          title={
            open
              ? t("components.graphFilterPanel.collapseFilterPanel")
              : t("components.graphFilterPanel.expandFilterPanel")
          }
          className={`ui-control flex flex-1 items-center gap-2 px-2 py-1 text-left hover:bg-surface-raised ${
            open ? "rounded-t-sm" : "rounded-l-sm"
          }`}
        >
          {open ? (
            <CaretDown weight="bold" className="ui-micro text-text-faint" />
          ) : (
            <CaretRight weight="bold" className="ui-micro text-text-faint" />
          )}
          <Funnel weight="duotone" className="text-text-muted" />
          <span className="font-mono text-xs font-semibold text-text">{t("components.graphFilterPanel.filters")}</span>
          {narrowed > 0 && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono ui-micro text-accent-fg">{narrowed}</span>
          )}
        </button>
        <button
          type="button"
          onClick={cycleFlow}
          title={t("components.graphFilterPanel.flowToggleHint")}
          className={`ui-control flex items-center gap-1 border-l border-border px-2 py-1 ui-micro font-mono text-text-muted hover:bg-surface-raised hover:text-text ${
            open ? "rounded-tr-sm" : "rounded-r-sm"
          }`}
        >
          <WaveSine weight="bold" className="ui-meta" />
          <span>{flowLabel}</span>
        </button>
      </div>

      <div
        id={bodyId}
        data-testid={bodyId}
        className={`glass nowheel absolute left-0 top-[calc(100%+6px)] z-30 w-[min(22rem,85vw)] rounded-sm p-3 flex-col gap-3 ${open ? "flex bounded-content overflow-y-auto" : "hidden"}`}
      >
        {/* 语义轴 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 ui-micro font-mono uppercase tracking-wide text-text-muted">
            <Bandaids weight="bold" />
            <span>{t("components.graphFilterPanel.semanticAxis")}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {AXIS_ORDER.map((axis) => {
              const active = filters.axes[axis];
              const color = AXIS_COLOR_VAR[axis];
              return (
                <button
                  key={axis}
                  onClick={() => toggleAxis(axis)}
                  aria-pressed={active}
                  title={AXIS_SUBLABEL[axis]}
                  className={`flex items-center gap-2 rounded-xs px-2 py-1.5 text-left ui-micro transition-colors ${
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
                </button>
              );
            })}
          </div>
        </div>

        {/* 关系类型 */}
        <details data-testid="graph-filter-kinds" className="flex flex-col gap-2">
          <summary className="cursor-pointer font-mono ui-micro text-text-muted">
            <GitBranch weight="bold" className="mr-1 inline" />
            <span>{t("components.graphFilterPanel.relationTypes")}</span>
          </summary>
          <span className="ml-auto flex gap-1 normal-case tracking-normal">
            <button
              onClick={() => setAllKinds(true)}
              className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
            >
              {t("components.graphFilterPanel.kindsAll")}
            </button>
            <button
              onClick={() => setAllKinds(false)}
              className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
            >
              {t("components.graphFilterPanel.kindsNone")}
            </button>
          </span>
          <div className="flex flex-col gap-2">
            {AXIS_ORDER.map((axis) => {
              const kinds = byAxis[axis];
              if (kinds.length === 0) return null;
              return (
                <div key={axis} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: AXIS_COLOR_VAR[axis] }}
                    />
                    <span className="font-mono ui-micro uppercase text-text-faint">{axisLabel(axis)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {kinds.map((kind) => {
                      const active = filters.kinds.has(kind);
                      return (
                        <button
                          key={kind}
                          onClick={() => toggleKind(kind)}
                          aria-pressed={active}
                          title={kind}
                          className={`rounded px-1.5 py-0.5 ui-micro font-medium transition-colors ${
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
        </details>

        {/* Common types are first; every other registered kind remains selectable. */}
        {showEntityTypes && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 font-mono ui-micro text-text-muted">
              <Graph weight="bold" />
              <span>{t("components.graphFilterPanel.entityTypes")}</span>
            </div>
            {[commonTypes, moreTypes].map((options, index) => {
              const buttons = (
                <div className="flex flex-wrap gap-1.5">
                  {options.map(({ kind, label }) => (
                    <button
                      key={kind}
                      type="button"
                      data-testid={`graph-filter-entity-type-${kind}`}
                      aria-pressed={filters.types.has(kind)}
                      onClick={() => toggleType(kind)}
                      className={`ui-control rounded-xs border px-2 ui-micro ${filters.types.has(kind) ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-text-muted"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              );
              return index === 0 ? (
                <div key="common">{buttons}</div>
              ) : options.length > 0 ? (
                <details key="more" data-testid="graph-filter-more-types">
                  <summary className="cursor-pointer ui-micro text-text-muted">
                    {t("components.graphFilterPanel.moreEntityTypes", { count: options.length })}
                  </summary>
                  <div className="mt-2">{buttons}</div>
                </details>
              ) : null;
            })}
          </div>
        )}

        {/* 密度分层:重点模式 / 全部 */}
        {showDensity && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 font-mono ui-micro uppercase tracking-wide text-text-muted">
              <Crosshair weight="bold" />
              <span>{t("components.graphFilterPanel.density")}</span>
            </div>
            <SegCtl
              value={filters.density}
              label={t("components.graphFilterPanel.density")}
              options={(["focus", "all"] as const).map((value) => ({
                value,
                testId: `graph-density-${value}`,
                label: t(
                  value === "focus"
                    ? "components.graphFilterPanel.densityFocus"
                    : "components.graphFilterPanel.densityAll",
                ),
                tip: t("components.graphFilterPanel.densityHint"),
              }))}
              onChange={setDensity}
            />
          </div>
        )}

        {/* 实体状态 */}
        <details data-testid="graph-filter-status">
          <summary className="cursor-pointer font-mono ui-micro text-text-muted">
            <CircleHalf weight="bold" className="mr-1 inline" />
            <span>{t("components.graphFilterPanel.entityStatus")}</span>
          </summary>
          {isEntityStatusFilterNarrowed(entityStatus) && (
            <button
              onClick={() => setFilters((prev) => ({ ...prev, entityStatus: defaultEntityStatusFilter() }))}
              className="ml-auto rounded px-1 py-0.5 ui-micro normal-case tracking-normal text-text-faint hover:bg-surface-raised hover:text-text"
            >
              {t("components.graphFilterPanel.statusReset")}
            </button>
          )}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono ui-micro uppercase text-text-faint">
                {t("components.graphFilterPanel.taskStatus")}
              </span>
              <span className="ml-auto flex gap-1 normal-case tracking-normal">
                <button
                  onClick={() => setAllTaskStatuses(true)}
                  className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
                >
                  {t("components.graphFilterPanel.kindsAll")}
                </button>
                <button
                  onClick={() => setAllTaskStatuses(false)}
                  className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
                >
                  {t("components.graphFilterPanel.kindsNone")}
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {TASK_STATUS_FILTER_OPTIONS.map((status) => {
                const active = entityStatus.taskStatuses.has(status);
                return (
                  <button
                    key={status}
                    onClick={() => toggleTaskStatus(status)}
                    aria-pressed={active}
                    title={status}
                    className={`rounded px-1.5 py-0.5 ui-micro font-medium transition-colors ${
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
                className={`rounded px-1.5 py-0.5 ui-micro font-medium transition-colors ${
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
              <span className="font-mono ui-micro uppercase text-text-faint">
                {t("components.graphFilterPanel.decisionState")}
              </span>
              <span className="ml-auto flex gap-1 normal-case tracking-normal">
                <button
                  onClick={() => setAllDecisionStates(true)}
                  className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
                >
                  {t("components.graphFilterPanel.kindsAll")}
                </button>
                <button
                  onClick={() => setAllDecisionStates(false)}
                  className="rounded-xs px-1 py-0.5 ui-micro text-text-faint hover:bg-surface-raised hover:text-text"
                >
                  {t("components.graphFilterPanel.kindsNone")}
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {DECISION_STATE_FILTER_OPTIONS.map((state) => {
                const active = entityStatus.decisionStates.has(state);
                return (
                  <button
                    key={state}
                    onClick={() => toggleDecisionState(state)}
                    aria-pressed={active}
                    title={state}
                    className={`rounded px-1.5 py-0.5 ui-micro font-medium transition-colors ${
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
                className={`rounded px-1.5 py-0.5 ui-micro font-medium transition-colors ${
                  entityStatus.decisionStates.has(OTHER_STATUS_BUCKET)
                    ? "border border-border bg-surface-raised text-text"
                    : "border border-border/40 bg-surface text-text-faint opacity-50"
                }`}
              >
                {decisionStateLabel(OTHER_STATUS_BUCKET)}
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

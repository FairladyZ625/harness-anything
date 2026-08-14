import { useState } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import {
  AXIS_COLOR_VAR,
  AXIS_LABEL,
  FULFILLMENT_COLOR_VAR,
  FULFILLMENT_LABEL,
  KIND_LABEL,
} from "../graph/constants.ts";
import { legendSampleKinds, visualForKind } from "../graph/relationVisual.ts";

/**
 * 关系图图例(REQ-GUI-04 missing 项;移植老版 views/GraphLegend.tsx 词表)。
 *
 * 三行语义:实体着色(task/decision/fact)、关系视觉词表样例(色=语义轴,
 * 线型=kind)、claim 兑现三形态(evidenced/delivered/standing-policy +
 * uncovered)。默认折叠,不抢画布空间;数据全部来自现有投影字段。
 */

const ENTITY_CHIPS: ReadonlyArray<{ color: string; label: string }> = [
  { color: "var(--color-axis-execution)", label: "task" },
  { color: "var(--color-axis-authority)", label: "decision" },
  { color: "var(--color-axis-evidence)", label: "fact" },
];

const FULFILLMENT_ORDER = [
  "evidenced",
  "delivered",
  "standing-policy",
  "unknown",
] as const;

export function GraphLegend({ showFulfillment }: { showFulfillment: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="graph-legend" className="contents">
      <button
        onClick={() => setOpen((value) => !value)}
        title="图例:实体着色 / 语义轴 / 关系线型 / claim 兑现形态"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] text-text-muted hover:bg-surface-raised hover:text-text"
      >
        图例
        {open ? <CaretUp weight="bold" className="text-[10px]" /> : <CaretDown weight="bold" className="text-[10px]" />}
      </button>
      {open && (
        <div data-testid="graph-legend-body" className="flex w-full basis-full flex-col gap-x-4 gap-y-1 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-text-faint">实体</span>
            {ENTITY_CHIPS.map((chip) => (
              <span key={chip.label} className="inline-flex items-center gap-1" data-testid={`graph-legend-entity-${chip.label}`}>
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: chip.color }} />
                {chip.label}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-text-faint">关系</span>
            {legendSampleKinds().map(({ kind, axis }) => {
              const visual = visualForKind(kind);
              return (
                <span key={kind} className="inline-flex items-center gap-1" title={`轴:${AXIS_LABEL[axis]}`}>
                  <svg width="22" height="8" aria-hidden className="shrink-0">
                    <line
                      x1="1"
                      y1="4"
                      x2="21"
                      y2="4"
                      stroke={AXIS_COLOR_VAR[axis]}
                      strokeWidth={visual.strokeWidth}
                      strokeDasharray={visual.dasharray}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="font-mono text-[10px] text-text-muted">{KIND_LABEL[kind] ?? kind}</span>
                </span>
              );
            })}
          </div>
          {showFulfillment && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="graph-legend-fulfillment">
              <span className="text-text-faint">claim 兑现</span>
              {FULFILLMENT_ORDER.map((mode) => (
                <span key={mode} className="inline-flex items-center gap-1" data-testid={`graph-legend-fulfillment-${mode}`}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: FULFILLMENT_COLOR_VAR[mode] }} />
                  {FULFILLMENT_LABEL[mode]}
                </span>
              ))}
              <span className="inline-flex items-center gap-1" data-testid="graph-legend-fulfillment-uncovered">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--color-danger)" }} />
                无证据
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

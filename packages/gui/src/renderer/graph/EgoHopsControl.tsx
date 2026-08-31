import type { EgoHopBudget } from "./egoCanvas";

/**
 * 聚焦跳数步进器(task_b4258de1):「父 ↑ N / 子 ↓ M」各一,0–4。
 *
 * 铺开预算本体在 egoCanvas.bfsShownFromFocus;本组件只改一份数字,画布由
 * useEgoCanvas 在 hops 变化时从当前焦点重铺(不清焦点、不刷新页面)。
 * 放在图谱页工具条一级,不藏菜单。
 */
export const EGO_HOPS_MIN = 0;
export const EGO_HOPS_MAX = 4;

function clampHops(value: number): number {
  return Math.min(EGO_HOPS_MAX, Math.max(EGO_HOPS_MIN, value));
}

export function EgoHopsControl({
  hops,
  onHopsChange,
}: {
  hops: EgoHopBudget;
  onHopsChange: (next: EgoHopBudget) => void;
}) {
  return (
    <span
      data-testid="ego-hops-control"
      className="inline-flex items-center gap-2 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted"
      title="聚焦后向上(父系)/向下(落地)各铺开几跳;改动即从当前焦点重铺,已展开的卡片重置"
    >
      <HopsStepper side="up" label="父 ↑" value={hops.up} onChange={(up) => onHopsChange({ ...hops, up })} />
      <HopsStepper side="down" label="子 ↓" value={hops.down} onChange={(down) => onHopsChange({ ...hops, down })} />
    </span>
  );
}

function HopsStepper({
  side,
  label,
  value,
  onChange,
}: {
  side: "up" | "down";
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const atMin = value <= EGO_HOPS_MIN;
  const atMax = value >= EGO_HOPS_MAX;
  return (
    <span className="inline-flex items-center gap-0.5" data-testid={`ego-hops-${side}`}>
      <span className="px-0.5">{label}</span>
      <button
        type="button"
        data-testid={`ego-hops-${side}-dec`}
        aria-label={`${label} 减一跳`}
        disabled={atMin}
        onClick={() => onChange(clampHops(value - 1))}
        className="rounded px-1 text-[11px] hover:bg-surface disabled:opacity-40"
      >
        −
      </button>
      <span className="w-3 text-center text-text" data-testid={`ego-hops-${side}-value`}>
        {value}
      </span>
      <button
        type="button"
        data-testid={`ego-hops-${side}-inc`}
        aria-label={`${label} 加一跳`}
        disabled={atMax}
        onClick={() => onChange(clampHops(value + 1))}
        className="rounded px-1 text-[11px] hover:bg-surface disabled:opacity-40"
      >
        +
      </button>
    </span>
  );
}

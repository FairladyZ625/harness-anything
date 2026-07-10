import { Flask } from "@phosphor-icons/react";

/**
 * Marks a surface whose remaining catalog/management data is still seeded.
 * Triadic decision/fact/relation views use the real projection and do not render
 * this badge.
 */
export function MockBadge({ label = "MOCK DATA" }: { label?: string }) {
  return (
    <span
      title="此视图仍使用演示数据"
      className="inline-flex shrink-0 items-center gap-1 rounded border border-stale/60 bg-stale/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-stale"
    >
      <Flask weight="fill" className="text-[12px]" />
      {label}
    </span>
  );
}

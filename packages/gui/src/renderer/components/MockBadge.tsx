import { Flask } from "@phosphor-icons/react";

/**
 * Marks a surface whose data is still mock. The decision / fact triadic client
 * API (FG-P1-07) does not exist yet, so decision-inbox, decision-pool, fact and
 * relation-graph views render seeded mock data. This badge keeps that visible so
 * an operator never mistakes it for real ledger state. Remove per-view once the
 * corresponding real client lands.
 */
export function MockBadge({ label = "MOCK DATA" }: { label?: string }) {
  return (
    <span
      title="此视图为演示数据（decision/fact 真实客户端 API 尚未落地）"
      className="inline-flex shrink-0 items-center gap-1 rounded border border-stale/60 bg-stale/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-stale"
    >
      <Flask weight="fill" className="text-[12px]" />
      {label}
    </span>
  );
}

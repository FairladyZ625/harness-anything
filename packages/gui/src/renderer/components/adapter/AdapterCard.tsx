import type { AdapterInfo } from "../../model/types";

export function AdapterCard({
  adapter,
  projectedCount,
  focused,
  onFocus,
}: {
  adapter: AdapterInfo;
  projectedCount: number;
  focused: boolean;
  onFocus: () => void;
}) {
  return (
    <section
      className={`rounded-lg border bg-surface ${focused ? "border-accent" : "border-border"}`}
      onClick={onFocus}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">{adapter.displayName}</h2>
        <span className="rounded border border-border px-1.5 py-px font-mono text-[11px] text-text-muted">
          {adapter.engine}
        </span>
        {adapter.defaultProvider && <span className="rounded bg-accent/15 px-1.5 py-px text-[10px] text-accent">default</span>}
        <span className="ml-auto font-mono text-[11px] text-text-muted">投影内 {projectedCount}</span>
      </div>

      <div className="flex flex-wrap gap-1 border-t border-border px-3 py-2">
        {adapter.capabilities.map((capability) => (
          <span key={capability} className="rounded border border-border px-1.5 py-px font-mono text-[10px] text-text-muted">
            {capability}
          </span>
        ))}
      </div>

      <p className="border-t border-border px-3 py-1.5 text-[11px] text-text-faint">
        registry metadata · {adapter.writable ? "支持写入" : "只读"}
        {adapter.readonly && adapter.writable ? "（读取与写入能力并存）" : ""}
      </p>
    </section>
  );
}

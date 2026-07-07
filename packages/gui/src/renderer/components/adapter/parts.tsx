import { Warning } from "@phosphor-icons/react";
import type { AdapterInfo } from "../../model/types";
import { StatusBadge } from "../badges";

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: connected ? "var(--color-status-done)" : "var(--color-danger)",
        }}
      />
      {connected ? "已连接" : "未连接"}
    </span>
  );
}

export function FreshnessLabel({ freshness }: { freshness: AdapterInfo["freshness"] }) {
  if (freshness === "fresh") return null;
  if (freshness === "stale-but-usable") {
    return (
      <span
        className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-stale"
        style={{ background: "color-mix(in oklch, var(--color-stale) 12%, transparent)" }}
      >
        缓存 stale
      </span>
    );
  }
  return (
    <span
      className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-danger"
      style={{ background: "color-mix(in oklch, var(--color-danger) 12%, transparent)" }}
    >
      不可用 · 无缓存
    </span>
  );
}

export function MappingTable({ adapter }: { adapter: AdapterInfo }) {
  return (
    <div className="border-t border-border">
      <table className="w-full border-collapse">
        <tbody>
          {adapter.mapping.map((m) => (
            <tr key={m.raw} className="border-b border-border last:border-b-0">
              <td className="px-3 py-1 font-mono text-[11px] text-text-muted">{m.raw}</td>
              <td className="w-8 px-1 py-1 text-center text-[11px] text-text-faint">→</td>
              <td className="px-3 py-1">
                <StatusBadge status={m.canonical} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adapter.unmappedRaw.length > 0 && (
        <div
          className="border-t border-border"
          style={{ background: "color-mix(in oklch, var(--color-danger) 6%, transparent)" }}
        >
          {adapter.unmappedRaw.map((raw) => (
            <div
              key={raw}
              className="flex items-center gap-2 border-b border-border px-3 py-1 last:border-b-0"
            >
              <Warning weight="bold" className="shrink-0 text-[13px] text-danger" />
              <span className="font-mono text-[11px] text-danger">{raw}</span>
              <span className="text-[11px] text-text-muted">未映射 → unknown</span>
              <button
                disabled
                title="原型暂不支持"
                className="ml-auto cursor-not-allowed rounded border border-border px-1.5 py-px text-[11px] text-text-faint"
              >
                补映射
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

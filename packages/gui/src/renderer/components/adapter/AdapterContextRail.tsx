import { PlugsConnected } from "@phosphor-icons/react";
import type { AdapterInfo, TaskRow } from "../../model/types";
import { dateTime, CHIP, SECTION_LABEL } from "./shared";
import { ConnectionDot, FreshnessLabel } from "./parts";

export function AdapterContextRail({
  adapters,
  focusedAdapter,
  tasks,
}: {
  adapters: AdapterInfo[];
  focusedAdapter: AdapterInfo;
  tasks: TaskRow[];
}) {
  const projectedCount = tasks.filter((t) => t.engine === focusedAdapter.engine).length;
  const externalAdapters = adapters.filter((a) => a.engine !== "local");
  const staleCount = adapters.filter((a) => a.freshness !== "fresh").length;
  const unmappedTotal = adapters.reduce((sum, a) => sum + a.unmappedRaw.length, 0);
  const connectedCount = adapters.filter((a) => a.connected).length;
  const lastSnapshot = focusedAdapter.lastSnapshotAt
    ? dateTime(focusedAdapter.lastSnapshotAt)
    : "本地 SoT";

  return (
    <aside className="sticky top-4 hidden self-start rounded-lg border border-border bg-surface px-3 py-3 lg:block">
      <div className="flex items-center justify-between gap-2">
        <span className={SECTION_LABEL}>Adapter 上下文</span>
        <PlugsConnected className="text-[15px] text-text-faint" />
      </div>

      <div className="mt-3 border-b border-border pb-3">
        <div className="text-[10px] text-text-faint">刷新语义</div>
        <div className="mt-1 text-[11px] text-text-muted">
          GUI 只触发 check 等价调用并读取缓存；外部状态仍由原引擎管理。
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">当前焦点</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-text">{focusedAdapter.displayName}</span>
          <span className={CHIP}>{focusedAdapter.engine}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <ConnectionDot connected={focusedAdapter.connected} />
          <FreshnessLabel freshness={focusedAdapter.freshness} />
          {focusedAdapter.unmappedRaw.length > 0 && (
            <span
              className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-stale"
              style={{ background: "color-mix(in oklch, var(--color-stale) 12%, transparent)" }}
            >
              {focusedAdapter.unmappedRaw.length} 未映射
            </span>
          )}
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="font-mono text-[17px] font-semibold text-text">{focusedAdapter.boundCount}</div>
            <div className="text-[10px] text-text-faint">绑定任务</div>
          </div>
          <div>
            <div className="font-mono text-[17px] font-semibold text-text">{projectedCount}</div>
            <div className="text-[10px] text-text-faint">投影内</div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-text-muted">
          快照 <span className="font-mono">{lastSnapshot}</span>
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="font-mono text-[16px] font-semibold text-text">{connectedCount}/{adapters.length}</div>
            <div className="text-[10px] text-text-faint">connected</div>
          </div>
          <div>
            <div className="font-mono text-[16px] font-semibold text-stale">{staleCount}</div>
            <div className="text-[10px] text-text-faint">stale</div>
          </div>
          <div>
            <div className="font-mono text-[16px] font-semibold text-danger">{unmappedTotal}</div>
            <div className="text-[10px] text-text-faint">unmapped</div>
          </div>
        </div>
      </div>

      <div className="border-b border-border py-3">
        <div className="text-[10px] text-text-faint">映射覆盖</div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {focusedAdapter.mapping.length > 0 ? (
            focusedAdapter.mapping.slice(0, 4).map((m) => (
              <div key={m.raw} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-muted">{m.raw}</span>
                <span className="text-[10px] text-text-faint">→</span>
                <span className="font-mono text-[10px] text-text">{m.canonical}</span>
              </div>
            ))
          ) : (
            <span className="text-[11px] text-text-faint">本地引擎无需映射</span>
          )}
          {focusedAdapter.mapping.length > 4 && (
            <div className="text-[10px] text-text-faint">+{focusedAdapter.mapping.length - 4} more mappings</div>
          )}
        </div>
      </div>

      <div className="pt-3">
        <div className="text-[10px] text-text-faint">外部引擎</div>
        <div className="mt-1.5 flex flex-col gap-1">
          {externalAdapters.map((a) => (
            <div key={a.engine} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: a.freshness === "fresh" ? "var(--color-status-done)" : "var(--color-stale)",
                }}
              />
              <span className="font-mono text-text-muted">{a.engine}</span>
              <span className="ml-auto font-mono text-text-faint">{a.boundCount}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

import { useState } from "react";
import {
  Key,
  Warning,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react";
import type { AdapterInfo } from "../../model/types";
import { dateTime } from "./shared";
import { ConnectionDot, FreshnessLabel, MappingTable } from "./parts";

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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isLocal = adapter.engine === "local";

  const refresh = () => {
    onFocus();
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
      setRefreshed(true);
    }, 1500);
  };

  const snapshotText = isLocal
    ? "—（本地无快照概念）"
    : refreshed
      ? "刚刚（模拟）"
      : adapter.lastSnapshotAt
        ? dateTime(adapter.lastSnapshotAt)
        : "—";

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
        <ConnectionDot connected={adapter.connected} />
        <FreshnessLabel freshness={adapter.freshness} />
        {adapter.unmappedRaw.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-stale"
            style={{ background: "color-mix(in oklch, var(--color-stale) 12%, transparent)" }}
          >
            <Warning weight="bold" className="text-[12px]" />
            {adapter.unmappedRaw.length} 个未映射
          </span>
        )}
        <button
          onClick={refresh}
          disabled={isLocal || refreshing}
          title={isLocal ? "本地引擎无快照" : "触发 check 等价调用落缓存"}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted enabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowsClockwise weight="bold" className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "刷新中…" : "刷新快照"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Key weight="duotone" className="text-[13px] text-text-faint" />
          {adapter.authHint}
          <span className="text-text-faint">（keychain · 不落明文）</span>
        </span>
        <span>
          绑定任务 <span className="font-mono">{adapter.boundCount}</span>
          <span className="text-text-faint">
            {" "}· 投影内 <span className="font-mono">{projectedCount}</span>
          </span>
        </span>
        <span>
          快照 <span className="font-mono">{snapshotText}</span>
        </span>
      </div>

      {isLocal && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-text-faint">
          本地文档引擎 · 状态即 SoT，无需快照
        </p>
      )}

      {adapter.mapping.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={() => {
              onFocus();
              setExpanded((v) => !v);
            }}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-text-muted hover:bg-surface-raised/60"
          >
            {expanded ? (
              <CaretDown weight="bold" className="text-text-faint" />
            ) : (
              <CaretRight weight="bold" className="text-text-faint" />
            )}
            状态映射 raw → canonical
            <span className="font-mono text-text-faint">
              {adapter.mapping.length}
              {adapter.unmappedRaw.length > 0 && ` +${adapter.unmappedRaw.length} 未映射`}
            </span>
          </button>
          {expanded && <MappingTable adapter={adapter} />}
        </div>
      )}
    </section>
  );
}

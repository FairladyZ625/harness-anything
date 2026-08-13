import { Handle, Position } from "@xyflow/react";
import type { TerritoryChip, TerritoryZone } from "../territory";

/**
 * 领地总览的两类节点(REQ-GUI-03 territory):
 *   TerritoryZoneNode  — 可折叠卡片(zone 标题 + chip 计数),单击折叠/展开。
 *   TerritoryChipNode  — zone 内实体 chip,单击进聚光灯。
 *
 * 无关系线(领地是 zone 总览,不是图)。两个渲染函数共用本文件。
 */

export function TerritoryZoneNode({ data }: any) {
  const zone = data.zone as TerritoryZone;
  const collapsed = Boolean(data.collapsed);
  const entityColor =
    zone.entity === "task"
      ? "var(--color-border-strong)"
      : zone.entity === "decision"
        ? "var(--color-accent)"
        : "var(--color-stale)";
  return (
    <div
      className="flex min-w-[180px] flex-col rounded-lg border bg-surface-raised shadow-sm"
      style={{ borderColor: entityColor, opacity: collapsed ? 0.55 : 1 }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div
        className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 select-none"
        onClick={(e) => {
          e.stopPropagation();
          data.onFold?.(zone.zoneId);
        }}
        data-testid="territory-zone-header"
        data-zone-id={zone.zoneId}
      >
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: entityColor }} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-text">
          {zone.title}
        </span>
        <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-faint">
          {zone.chips.length}
        </span>
        <span className="font-mono text-[10px] text-text-faint">{collapsed ? "▸" : "▾"}</span>
      </div>
      {!collapsed && (
        <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto px-2 py-2">
          {zone.chips.slice(0, 24).map((chip: TerritoryChip) => (
            <button
              key={chip.navRef}
              data-testid="territory-chip"
              data-nav-ref={chip.navRef}
              onClick={(e) => {
                e.stopPropagation();
                data.onOpen?.(chip.navRef);
              }}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    chip.entity === "task"
                      ? "var(--color-border-strong)"
                      : chip.entity === "decision"
                        ? "var(--color-accent)"
                        : "var(--color-stale)",
                }}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-text">{chip.label}</span>
              {chip.sub && (
                <span className="shrink-0 font-mono text-[9px] text-text-faint">{chip.sub}</span>
              )}
            </button>
          ))}
          {zone.chips.length > 24 && (
            <span className="px-1.5 font-mono text-[9px] text-text-faint">
              …还有 {zone.chips.length - 24}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
}

/** 未投影实体 landing chip(孤立 decision 等无 zone 归属的)。 */
export function TerritoryLandingNode({ data }: any) {
  const chips = (data.chips ?? []) as TerritoryChip[];
  return (
    <div className="flex min-w-[180px] flex-col rounded-lg border border-dashed border-border bg-surface px-3 py-2">
      <span className="font-mono text-[11px] text-text-faint">孤立 / landing</span>
      <div className="mt-1 flex flex-col gap-1">
        {chips.map((chip) => (
          <button
            key={chip.navRef}
            data-testid="territory-chip"
            data-nav-ref={chip.navRef}
            onClick={(e) => {
              e.stopPropagation();
              data.onOpen?.(chip.navRef);
            }}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised"
          >
            <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{chip.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

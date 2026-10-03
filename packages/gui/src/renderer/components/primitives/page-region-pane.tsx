import { useState, type DragEvent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { DotsSixVertical } from "@phosphor-icons/react";
import {
  RegionControlsContext,
  RegionHandleContext,
  usePageRegionHost,
  type RegionDockZone,
} from "./page-region-context.ts";
import type { PaneDirection } from "../../terminal-pane-focus.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 一个页面区域的 dockview 面板:整张卡是停靠落点,把手在区域头里(经 RegionDragHandle
 * 注入),按指针离哪条边最近分四个半区,预览遮罩与放下后的落位一致。交互与终端分屏的
 * TerminalPaneCard 同一模式:HTML5 拖拽 + 模块级 drag 标记(happy-dom 里也能驱动),
 * 正文文本选取/表单不触发——只有把手可拖。
 */

/** 正在被拖的区域;一个页面同一时刻只有一场拖拽。cancel 清掉当前悬停目标的半区高亮
 * (dragend 不冒泡到目标,浏览器的 dragleave 在取消时不总有)。 */
const drag: { regionId: string | null; cancel: (() => void) | null } = { regionId: null, cancel: null };

const zoneClassName: Record<RegionDockZone, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  above: "inset-x-0 top-0 h-1/2",
  below: "inset-x-0 bottom-0 h-1/2",
};

/** 指针离区域哪条边最近,就落到那一侧;区域无尺寸(测试环境)时默认落右侧。 */
export function dockZoneOf(
  event: { readonly clientX: number; readonly clientY: number },
  region: HTMLElement,
): RegionDockZone {
  const rect = region.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return "right";
  const x = (event.clientX - rect.left) / rect.width,
    y = (event.clientY - rect.top) / rect.height;
  const edges: readonly (readonly [RegionDockZone, number])[] = [
    ["left", x],
    ["right", 1 - x],
    ["above", y],
    ["below", 1 - y],
  ];
  return edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best))[0];
}

export const regionPanelComponent = "regionPanel";

export function RegionPanel(props: IDockviewPanelProps<{ readonly id: string }>) {
  const host = usePageRegionHost();
  const id = props.params.id;
  const region = host.regions.get(id);
  const [zone, setZone] = useState<RegionDockZone | null>(null);
  if (region === undefined) return null;
  const zoneOf = (event: DragEvent<HTMLDivElement>) => dockZoneOf(event, event.currentTarget);
  return (
    <div
      data-region={id}
      data-testid={region.testId}
      data-zone={zone ?? undefined}
      onDragOver={(event) => {
        if (!drag.regionId || drag.regionId === id) return;
        event.preventDefault();
        setZone(zoneOf(event));
        drag.cancel = () => setZone(null);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={(event) => {
        const source = drag.regionId;
        setZone(null);
        drag.cancel = null;
        if (!source || source === id) return;
        event.preventDefault();
        drag.regionId = null;
        host.dock(source, id, zoneOf(event));
      }}
      className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden"
    >
      {zone && (
        <div
          data-testid={`region-drop-overlay-${id}`}
          aria-hidden="true"
          className={`pointer-events-none absolute z-10 border-2 border-accent bg-accent/20 ${zoneClassName[zone]}`}
        />
      )}
      <RegionHandleContext.Provider value={<RegionHandle id={id} title={region.title} />}>
        <RegionControlsContext.Provider value={host.controls(id)}>{region.content}</RegionControlsContext.Provider>
      </RegionHandleContext.Provider>
    </div>
  );
}

function RegionHandle({ id, title }: { readonly id: string; readonly title: string }) {
  const host = usePageRegionHost();
  const label = t("components.pageRegions.move", { title });
  const arrowOf: Partial<Record<string, PaneDirection>> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  return (
    <button
      type="button"
      draggable
      aria-label={label}
      title={label}
      data-testid={`region-handle-${id}`}
      data-control-size="sm"
      onDragStart={(event) => {
        drag.regionId = id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        }
      }}
      onDragEnd={() => {
        drag.regionId = null;
        drag.cancel?.();
        drag.cancel = null;
      }}
      onKeyDown={(event) => {
        const direction = arrowOf[event.key];
        if (direction === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        // Alt+方向键调缝(本区域沿该轴增/减);纯方向键把本区域停靠到该方向的相邻区域。
        if (event.altKey) host.resizeSeam(id, direction, direction === "left" || direction === "up" ? -1 : 1);
        else host.dockKeyboard(id, direction);
      }}
      onClick={(event) => event.stopPropagation()}
      className="ui-control grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-sm text-text-faint hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
    >
      <DotsSixVertical aria-hidden="true" />
    </button>
  );
}

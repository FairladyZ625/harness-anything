import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  pointerWithin,
} from "@dnd-kit/core";
import { DotsSixVertical } from "@phosphor-icons/react";
import {
  SplitDivider,
  SplitExpandStrip,
  collapsedGridTemplate,
  SplitLayoutControls,
  splitGridTemplate,
  useSplitLayout,
} from "./split-layout.tsx";
import { readSplitPreferences, splitPreferenceStorage, writeSplitPreferences } from "../../split-layout-preferences.ts";

import { t } from "../../i18n/index.tsx";

interface Scope {
  readonly connectionId: string | null;
  readonly repoId: string;
  readonly slot: string;
}
export interface PageRegion {
  readonly id: string;
  readonly title: string;
  readonly content: ReactNode;
  readonly weight?: number;
  readonly testId?: string;
}
const HandleContext = createContext<ReactNode>(null);
const ControlsContext = createContext<ReactNode>(null);
export function RegionLayoutControls() {
  return useContext(ControlsContext);
}
/** Region and document headers consume the same dedicated handle. Body input remains untouched. */
export function RegionDragHandle() {
  return useContext(HandleContext);
}

export function regionOrder(saved: readonly string[], available: readonly string[]): string[] {
  return [...saved.filter((id) => available.includes(id)), ...available.filter((id) => !saved.includes(id))];
}
export function swapRegions(order: readonly string[], from: string, to: string): string[] {
  const next = [...order],
    a = next.indexOf(from),
    b = next.indexOf(to);
  if (a >= 0 && b >= 0) [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

/** Fixed page regions, with title-only movement and proportional seams. No floating panels or extra reads. */
export function PageRegions(
  props: Scope & {
    readonly regions: readonly PageRegion[];
    readonly columns: readonly (readonly string[])[];
    readonly testId: string;
    readonly defaultRatio?: number;
    readonly collapsible?: boolean;
  },
) {
  const [reset, setReset] = useState(0);
  return (
    <PageRegionsBody
      key={`${props.connectionId}:${props.repoId}:${props.slot}:${reset}`}
      {...props}
      onReset={() => {
        if (props.connectionId !== null) {
          const storage = splitPreferenceStorage();
          const slots = readSplitPreferences(storage, props.connectionId, props.repoId);
          for (const key of Object.keys(slots))
            if (key === props.slot || key.startsWith(`${props.slot}/`)) delete slots[key];
          writeSplitPreferences(storage, props.connectionId, props.repoId, slots);
        }
        setReset((value) => value + 1);
      }}
    />
  );
}
function PageRegionsBody({
  regions,
  columns,
  testId,
  defaultRatio = 0.6,
  collapsible = false,
  onReset,
  ...scope
}: Scope & {
  readonly regions: readonly PageRegion[];
  readonly columns: readonly (readonly string[])[];
  readonly testId: string;
  readonly defaultRatio?: number;
  readonly collapsible?: boolean;
  readonly onReset: () => void;
}) {
  const split = useSplitLayout({
    ...scope,
    minRatio: 0.2,
    maxRatio: 0.8,
    defaultRatioRow: defaultRatio,
    defaultRatioColumn: defaultRatio,
    autoBreakpoint: 900,
    collapsible,
  });
  const available = columns.flat().filter((id) => regions.some((region) => region.id === id));
  const order = regionOrder(split.order, available);
  const [over, setOver] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const host = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const move = (from: string, to: string) => {
    split.setOrder(swapRegions(order, from, to));
    setFocused(from);
  };
  useEffect(() => {
    if (focused !== null)
      host.current?.querySelector<HTMLButtonElement>(`[data-testid="region-handle-${CSS.escape(focused)}"]`)?.focus();
  }, [focused, split.order]);
  let offset = 0;
  const groups = columns
    .map((column) => {
      const length = column.filter((id) => available.includes(id)).length;
      const group = order.slice(offset, offset + length);
      offset += length;
      return group;
    })
    .filter((group) => group.length > 0);
  const renderRegion = (id: string) => {
    const region = regions.find((item) => item.id === id)!;
    return (
      <MovableRegion
        key={id}
        region={region}
        over={over === id}
        controls={
          id === available[0] ? (
            <SplitLayoutControls {...split.controlsProps} onReset={onReset} testId={`${testId}-controls`} />
          ) : null
        }
        onMove={(step) => {
          const target = order[order.indexOf(id) + step];
          if (target !== undefined) move(id, target);
        }}
      />
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragOver={({ over: target }) => setOver(target === null ? null : String(target.id))}
      onDragCancel={() => setOver(null)}
      onDragEnd={({ active, over: target }) => {
        if (target !== null) move(String(active.id), String(target.id));
        setOver(null);
      }}
    >
      <div ref={host} className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-hidden" data-testid={testId}>
        {split.collapsed && (
          <div className="flex shrink-0 justify-end">
            <SplitLayoutControls {...split.controlsProps} onReset={onReset} testId={`${testId}-controls`} />
          </div>
        )}
        <div
          ref={split.containerRef}
          className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
          style={
            groups.length > 1
              ? split.collapsed
                ? collapsedGridTemplate(split.effectiveOrientation)
                : splitGridTemplate(split.effectiveOrientation, split.ratio)
              : undefined
          }
        >
          {groups.length <= 1 ? (
            <RegionStack scope={scope} ids={groups[0] ?? []} render={renderRegion} regions={regions} path="0" />
          ) : (
            <>
              {split.collapsed ? (
                <SplitExpandStrip
                  orientation={split.effectiveOrientation}
                  onExpand={split.controlsProps.onToggleCollapse}
                  label={t("components.pageRegions.expand")}
                  testId={`${testId}-expand`}
                />
              ) : (
                <>
                  <RegionStack scope={scope} ids={groups[0]!} render={renderRegion} regions={regions} path="0" />
                  <SplitDivider
                    {...split.dividerProps}
                    label={t("components.pageRegions.resize")}
                    testId={`${testId}-divider`}
                  />
                </>
              )}
              {split.collapsed ? (
                <RegionStack
                  scope={scope}
                  ids={order.filter((id) => id !== available[0])}
                  render={renderRegion}
                  regions={regions}
                  path="1"
                />
              ) : (
                <RegionColumns
                  scope={scope}
                  groups={groups.slice(1)}
                  render={renderRegion}
                  regions={regions}
                  path="1"
                />
              )}
            </>
          )}
        </div>
      </div>
    </DndContext>
  );
}
function RegionColumns({
  scope,
  groups,
  render,
  regions,
  path,
}: {
  readonly scope: Scope;
  readonly groups: readonly (readonly string[])[];
  readonly render: (id: string) => ReactNode;
  readonly regions: readonly PageRegion[];
  readonly path: string;
}) {
  const ratio = 1 / Math.max(2, groups.length);
  const split = useSplitLayout({
    ...scope,
    slot: `${scope.slot}/columns/${path}`,
    minRatio: 0.2,
    maxRatio: 0.8,
    defaultRatioRow: ratio,
    defaultRatioColumn: ratio,
    autoBreakpoint: 0,
    collapsible: false,
  });
  if (groups.length <= 1)
    return <RegionStack scope={scope} ids={groups[0] ?? []} render={render} regions={regions} path={path} />;
  return (
    <div
      ref={split.containerRef}
      className="grid min-h-0 min-w-0 overflow-hidden"
      style={splitGridTemplate("row", split.ratio)}
    >
      <RegionStack scope={scope} ids={groups[0]!} render={render} regions={regions} path={path} />
      <SplitDivider {...split.dividerProps} label={t("components.pageRegions.resize")} />
      <RegionColumns scope={scope} groups={groups.slice(1)} render={render} regions={regions} path={`${path}/next`} />
    </div>
  );
}
function RegionStack({
  scope,
  ids,
  render,
  regions,
  path,
}: {
  readonly scope: Scope;
  readonly ids: readonly string[];
  readonly render: (id: string) => ReactNode;
  readonly regions: readonly PageRegion[];
  readonly path: string;
}) {
  const weight = (id: string) => regions.find((region) => region.id === id)?.weight ?? 1;
  const ratio = ids.length === 0 ? 0.5 : weight(ids[0]!) / ids.reduce((sum, id) => sum + weight(id), 0);
  const split = useSplitLayout({
    ...scope,
    slot: `${scope.slot}/${path}`,
    minRatio: 0.15,
    maxRatio: 0.85,
    defaultRatioColumn: ratio,
    defaultRatioRow: ratio,
    autoBreakpoint: Infinity,
    collapsible: false,
  });
  if (ids.length < 2) return ids[0] === undefined ? null : render(ids[0]);
  return (
    <div
      ref={split.containerRef}
      className="grid min-h-0 min-w-0 overflow-hidden"
      style={splitGridTemplate("column", split.ratio)}
    >
      {render(ids[0]!)}
      <SplitDivider
        {...split.dividerProps}
        label={t("components.pageRegions.height")}
        testId={`${scope.slot}-${path}-divider`}
      />
      <RegionStack scope={scope} ids={ids.slice(1)} render={render} regions={regions} path={`${path}/next`} />
    </div>
  );
}
function MovableRegion({
  region,
  over,
  onMove,
  controls,
}: {
  readonly region: PageRegion;
  readonly over: boolean;
  readonly onMove: (step: number) => void;
  readonly controls: ReactNode;
}) {
  const drag = useDraggable({ id: region.id });
  const drop = useDroppable({ id: region.id });
  const label = t("components.pageRegions.move", { title: region.title });
  const handle = (
    <button
      ref={drag.setActivatorNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      type="button"
      aria-label={label}
      title={label}
      data-testid={`region-handle-${region.id}`}
      data-control-size="sm"
      className="ui-control grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-sm text-text-faint hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onMove(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      <DotsSixVertical aria-hidden="true" />
    </button>
  );
  return (
    <div
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      data-region={region.id}
      data-testid={region.testId}
      data-drop-preview={over || undefined}
      className={`grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden ${over ? "outline outline-2 -outline-offset-2 outline-accent" : ""} ${drag.isDragging ? "opacity-60" : ""}`}
    >
      <HandleContext.Provider value={handle}>
        <ControlsContext.Provider value={controls}>{region.content}</ControlsContext.Provider>
      </HandleContext.Provider>
    </div>
  );
}

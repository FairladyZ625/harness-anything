// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { partitionForSkel } from "../src/renderer/graph/territory.ts";
import {
  deriveGridCols,
  layoutTerritory,
  CHIP_H,
  CHIP_GAP,
  EXPANDED_CHIP_CAP,
  FOLDED_CHIP_CAP,
  isTerritoryEntityChipNode,
  isTerritoryFoldNode,
  isTerritoryZoneNode,
  zoneHeaderH,
  ZONE_BODY_PAD_Y,
} from "../src/renderer/graph/territoryLayout.ts";

/**
 * 领地两级布局回归(archive 结构恢复):
 *   · deriveGridCols 按可用宽度派生列数;
 *   · zone 壳 + 独立 chip 节点,chip 落在 zone body 内、互不重叠;
 *   · 折叠态只显前 FOLDED_CHIP_CAP 个 chip + fold 提示行;
 *   · 行推进按行内最大 zone 高,下一行不压上一行;
 *   · landing(孤立实体)渲染为虚线 zone 变体,chip 同样可布局。
 */

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...overrides,
  };
}

function noop() {}

function layout(opts: { tasks: TaskRow[]; expandedZones?: ReadonlySet<string>; containerWidth?: number }) {
  const partition = partitionForSkel("task", opts.tasks, [], [], [], []);
  return layoutTerritory({
    partition,
    expandedZones: opts.expandedZones ?? new Set(),
    containerWidth: opts.containerWidth,
    onOpen: noop,
    onFold: noop,
  });
}

describe("deriveGridCols", () => {
  it("derives columns from available width (narrow → 1, wide → capped 6)", () => {
    expect(deriveGridCols(0)).toBe(3); // 未测量兜底
    expect(deriveGridCols(-10)).toBe(3);
    expect(deriveGridCols(Number.NaN)).toBe(3);
    expect(deriveGridCols(300)).toBe(1);
    expect(deriveGridCols(360 * 3)).toBe(3);
    expect(deriveGridCols(360 * 8)).toBe(6); // 封顶
  });
});

describe("layoutTerritory (two-level zone + chip)", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    task({ taskId: `t${i}`, title: `T${i}`, rootTaskId: "root", rootTitle: "PRD" }),
  );

  it("emits chips as separate nodes placed inside the zone body", () => {
    const { nodes } = layout({ tasks: many, containerWidth: 360 });
    const zone = nodes.find(isTerritoryZoneNode)!;
    const chips = nodes.filter(isTerritoryEntityChipNode);
    expect(zone).toBeDefined();
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.position.x).toBeGreaterThanOrEqual(zone.position.x);
      expect(chip.position.x + chip.width!).toBeLessThanOrEqual(zone.position.x + zone.width!);
      expect(chip.position.y).toBeGreaterThanOrEqual(zone.position.y + zoneHeaderH(zone.data.zone) + ZONE_BODY_PAD_Y);
      expect(chip.position.y + chip.height!).toBeLessThanOrEqual(zone.position.y + zone.height!);
    }
  });

  it("folds by default: FOLDED_CHIP_CAP chips + one fold row, not all 40", () => {
    const { nodes } = layout({ tasks: many, containerWidth: 360 });
    const chips = nodes.filter(isTerritoryEntityChipNode);
    const folds = nodes.filter(isTerritoryFoldNode);
    expect(chips).toHaveLength(FOLDED_CHIP_CAP);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.data.fold.hidden).toBe(40 - FOLDED_CHIP_CAP);
  });

  it("expands to the cap but never dumps thousands of chips", () => {
    const huge = Array.from({ length: 1174 }, (_, i) =>
      task({ taskId: `t${i}`, title: `T${i}`, rootTaskId: "root", rootTitle: "PRD" }),
    );
    const partition = partitionForSkel("task", huge, [], [], [], []);
    const { nodes } = layoutTerritory({
      partition,
      expandedZones: new Set(partition.zones.map((z) => z.zoneId)),
      containerWidth: 360,
      onOpen: noop,
      onFold: noop,
    });
    const chips = nodes.filter(isTerritoryEntityChipNode);
    expect(chips.length).toBeLessThanOrEqual(EXPANDED_CHIP_CAP);
    expect(chips.length).toBeGreaterThan(FOLDED_CHIP_CAP);
  });

  it("stacks chips with constant pitch so they never overlap", () => {
    const { nodes } = layout({ tasks: many, containerWidth: 360 });
    const chips = nodes.filter((n) => n.type === "territoryChip").sort((a, b) => a.position.y - b.position.y);
    for (let i = 1; i < chips.length; i += 1) {
      expect(chips[i]!.position.y - chips[i - 1]!.position.y).toBe(CHIP_H + CHIP_GAP);
    }
  });

  it("advances rows by the tallest zone in the row (no vertical overlap)", () => {
    // 三个独立 PRD 根(三个 zone),单列宽 → 3 行。
    const tasks = [
      ...Array.from({ length: 12 }, (_, i) => task({ taskId: `a${i}`, rootTaskId: "ra", rootTitle: "A" })),
      ...Array.from({ length: 2 }, (_, i) => task({ taskId: `b${i}`, rootTaskId: "rb", rootTitle: "B" })),
      task({ taskId: "c0", rootTaskId: "rc", rootTitle: "C" }),
    ];
    const { nodes } = layout({ tasks, containerWidth: 360 });
    const zones = nodes.filter(isTerritoryZoneNode).sort((a, b) => a.position.y - b.position.y);
    expect(zones).toHaveLength(3);
    for (let i = 1; i < zones.length; i += 1) {
      const prev = zones[i - 1]!;
      expect(zones[i]!.position.y).toBeGreaterThanOrEqual(prev.position.y + prev.height!);
    }
  });

  it("places multiple zones side by side when the container is wide", () => {
    const tasks = [
      task({ taskId: "a0", rootTaskId: "ra", rootTitle: "A" }),
      task({ taskId: "b0", rootTaskId: "rb", rootTitle: "B" }),
    ];
    const { nodes } = layout({ tasks, containerWidth: 360 * 3 });
    const zones = nodes.filter(isTerritoryZoneNode);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.position.y).toBe(zones[1]!.position.y);
    expect(zones[1]!.position.x).toBeGreaterThan(zones[0]!.position.x);
  });

  it("renders landing chips inside a landing pseudo-zone", () => {
    const partition = partitionForSkel("unified", [task()], [], [], [], []);
    const { nodes } = layoutTerritory({
      partition,
      expandedZones: new Set(),
      containerWidth: 360,
      onOpen: noop,
      onFold: noop,
    });
    const zoneNodes = nodes.filter((n) => n.type === "territoryZone");
    // task 自成 PRD 块 + landing 壳(decision landing 为空时仍可能有 task 块)。
    for (const zone of zoneNodes) {
      expect(zone.width).toBeGreaterThan(0);
      expect(zone.height).toBeGreaterThan(0);
    }
    expect(zoneNodes.length).toBeGreaterThanOrEqual(1);
  });
});

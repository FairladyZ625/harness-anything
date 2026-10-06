// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  borderLinkLength,
  borderPoint,
  CENTER_CARD,
  computeFleetLayout,
  curvePath,
  EDGE_CARD,
  LINK_MAX,
  LINK_MIN,
  type FleetNodePlacement,
} from "../src/renderer/views/collaboration/fleet-topology-layout.ts";

/** 布局的护栏契约:任务计划的「节点数 1–12 都排得开,窗口宽度变化时重排」,
 * 加上第 3 轮的一等契约——中心与边缘卡之间的可见连线在每一形态每一宽度
 * 都 ≥ LINK_MIN(流光/粒子要有能被看见的轨道)。 */
const WIDTHS = [390, 592, 640, 700, 830, 880, 950, 1104, 1120, 1174, 1440, 1920];
const MARGIN = 2;

function edgeIds(count: number): { nodeId: string; role: "center" | "edge" }[] {
  return [
    { nodeId: "center", role: "center" as const },
    ...Array.from({ length: count }, (_, index) => ({ nodeId: `edge-${index}`, role: "edge" as const })),
  ];
}

function assertRectsDisjoint(a: FleetNodePlacement, b: FleetNodePlacement, label: string): void {
  const gapX = a.left + a.width + MARGIN <= b.left || b.left + b.width + MARGIN <= a.left;
  const gapY = a.top + a.height + MARGIN <= b.top || b.top + b.height + MARGIN <= a.top;
  expect(gapX || gapY, `${label} must not overlap: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
}

/** 每条中心→边缘连线的可见长度:非窄形态量边框间直线(即所画贝塞尔的弦,
 * 曲线路径只会更长);窄形态量中点纵向差(S 形轨道的下界)。 */
function linkLengthsOf(width: number, count: number, height = 620): number[] {
  const layout = computeFleetLayout(width, height, edgeIds(count));
  const center = layout.placement.get("center")!;
  return [...layout.placement.values()]
    .filter((placement) => placement !== center)
    .map((placement) =>
      layout.narrow
        ? Math.abs(placement.top + placement.height / 2 - (center.top + center.height / 2))
        : borderLinkLength(center, placement),
    );
}

describe("舰队拓扑布局", () => {
  it("边缘 1–12 个在验收宽度档位上两两不重叠,且全部落在画布内", () => {
    for (const width of WIDTHS) {
      for (let count = 1; count <= 12; count += 1) {
        const layout = computeFleetLayout(width, 420, edgeIds(count));
        const placements = [...layout.placement.values()];
        expect(placements.length, `width=${width} count=${count} places every node`).toBe(count + 1);
        for (const placement of placements) {
          expect(placement.left, `width=${width} in-canvas left`).toBeGreaterThanOrEqual(0);
          expect(placement.top, `width=${width} in-canvas top`).toBeGreaterThanOrEqual(0);
          expect(placement.left + placement.width, `width=${width} in-canvas right`).toBeLessThanOrEqual(
            layout.canvasWidth + MARGIN,
          );
          expect(placement.top + placement.height, `width=${width} in-canvas bottom`).toBeLessThanOrEqual(
            layout.canvasHeight + MARGIN,
          );
        }
        for (let i = 0; i < placements.length; i += 1)
          for (let j = i + 1; j < placements.length; j += 1)
            assertRectsDisjoint(placements[i]!, placements[j]!, `width=${width} count=${count} pair ${i}-${j}`);
      }
    }
  });

  it("第 3 轮一等契约:每一形态、每一宽度档,中心-边缘可见连线都 ≥ LINK_MIN", () => {
    for (const width of WIDTHS) {
      for (let count = 1; count <= 12; count += 1) {
        for (const length of linkLengthsOf(width, count))
          expect(length, `width=${width} count=${count} visible link`).toBeGreaterThanOrEqual(LINK_MIN - 0.5);
      }
    }
  });

  it("宽容器小舰队(≤4)走雷达环:连线落在 [LINK_MIN, LINK_MAX] 带,队形横向铺开", () => {
    for (const width of [1120, 1174, 1440]) {
      for (let count = 1; count <= 4; count += 1) {
        const layout = computeFleetLayout(width, 620, edgeIds(count));
        const center = layout.placement.get("center")!;
        // 环形态:中心卡不在画布顶端(队列树的中心贴顶)。
        expect(center.top, `width=${width} count=${count} ring keeps the center mid-canvas`).toBeGreaterThan(40);
        for (const length of linkLengthsOf(width, count))
          expect(length, `width=${width} count=${count} ring link band`).toBeLessThanOrEqual(LINK_MAX + 0.5);
      }
    }
    // 铺开回归(第 2 轮「指挥台要撑开的舰队」):边缘卡横向跨度吃掉画布大头。
    const ring = computeFleetLayout(1174, 620, edgeIds(3));
    const center = ring.placement.get("center")!;
    const edges = [...ring.placement.values()].filter((placement) => placement !== center);
    const leftEdge = Math.min(...edges.map((placement) => placement.left));
    const rightEdge = Math.max(...edges.map((placement) => placement.left + placement.width));
    expect((rightEdge - leftEdge) / ring.canvasWidth).toBeGreaterThanOrEqual(0.6);
  });

  it("中带宽走队列树:中心卡在上方,边缘两列排在下方,连线斜向且 ≥ LINK_MIN", () => {
    const layout = computeFleetLayout(854, 620, edgeIds(3));
    const center = layout.placement.get("center")!;
    expect(layout.narrow).toBe(false);
    expect(center.top).toBeLessThanOrEqual(40);
    for (const placement of layout.placement.values())
      if (placement !== center)
        expect(placement.top, "tree edges sit below the center card").toBeGreaterThan(center.top);
    for (const length of linkLengthsOf(854, 3)) expect(length).toBeGreaterThanOrEqual(LINK_MIN - 0.5);
  });

  it("宽容器大舰队(>4)走双翼列:画布高度随节点数扩展", () => {
    const six = computeFleetLayout(1174, 420, edgeIds(6));
    const twelve = computeFleetLayout(1174, 420, edgeIds(12));
    expect(twelve.canvasHeight).toBeGreaterThan(six.canvasHeight);
    // 12 个分两翼各 6:6×124 + 5×20 + 上下 padding。
    expect(twelve.canvasHeight).toBeGreaterThanOrEqual(6 * 124 + 5 * 20 + 32);
  });

  it("第 2 轮视觉修正保持:节点卡足够大(节点是画布主角)", () => {
    expect(CENTER_CARD.width).toBeGreaterThanOrEqual(300);
    expect(CENTER_CARD.height).toBeGreaterThanOrEqual(140);
    expect(EDGE_CARD.width).toBeGreaterThanOrEqual(250);
    expect(EDGE_CARD.height).toBeGreaterThanOrEqual(120);
  });

  it("窄容器走纵向堆叠:卡片逐行下移,画布高度覆盖最后一张卡", () => {
    const layout = computeFleetLayout(390, 420, edgeIds(4));
    expect(layout.narrow).toBe(true);
    const tops = [...layout.placement.values()].map((placement) => placement.top).sort((a, b) => a - b);
    expect(new Set(tops).size).toBe(tops.length);
    const bottom = Math.max(...[...layout.placement.values()].map((placement) => placement.top + placement.height));
    expect(bottom).toBeLessThanOrEqual(layout.canvasHeight);
  });

  it("只有中心的仓(本地模式)也给出有限画布", () => {
    const layout = computeFleetLayout(1120, 420, edgeIds(0));
    expect(layout.placement.size).toBe(1);
    expect(layout.canvasHeight).toBeGreaterThan(0);
  });

  it("borderPoint 把连线端点收到卡片边框", () => {
    const box: FleetNodePlacement = { left: 100, top: 100, width: 200, height: 100 };
    const right = borderPoint(box, { x: 500, y: 150 });
    expect(right).toEqual({ x: 300, y: 150 });
    const down = borderPoint(box, { x: 200, y: 400 });
    expect(down).toEqual({ x: 200, y: 200 });
  });

  it("curvePath 产出中心→边缘方向的三次贝塞尔", () => {
    const from: FleetNodePlacement = { left: 0, top: 0, width: 100, height: 50 };
    const to: FleetNodePlacement = { left: 400, top: 300, width: 100, height: 50 };
    const path = curvePath(from, to);
    // 起点收在 from 卡边框(对角方向出下沿),终点收在 to 卡上沿。
    expect(path.startsWith("M 83.3 50.0 C ")).toBe(true);
    expect(path.endsWith("416.7 300.0")).toBe(true);
  });

  it("borderLinkLength 度量两卡边框间的可见连线(布局契约的尺子)", () => {
    const a: FleetNodePlacement = { left: 0, top: 0, width: 300, height: 148 };
    // beside 卡心在 (556, 74),与 a 卡心同高:纯水平方向,连线 = 中心距 − 两侧半宽。
    const beside: FleetNodePlacement = { left: 430, top: 12, width: 252, height: 124 };
    expect(borderLinkLength(a, beside)).toBeCloseTo(406 - 150 - 126, 5);
    // below 卡心在 (150, 412),与 a 卡心同列:纯垂直方向,连线 = 中心距 − 两侧半高。
    const below: FleetNodePlacement = { left: 24, top: 350, width: 252, height: 124 };
    expect(borderLinkLength(a, below)).toBeCloseTo(338 - 74 - 62, 5);
  });
});

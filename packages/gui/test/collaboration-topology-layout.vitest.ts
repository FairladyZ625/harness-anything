// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  borderPoint,
  CENTER_CARD,
  computeFleetLayout,
  curvePath,
  EDGE_CARD,
  suggestFleetCanvasHeight,
  type FleetNodePlacement,
} from "../src/renderer/views/collaboration/fleet-topology-layout.ts";

/** 布局的护栏契约:任务计划的「节点数 1–12 都排得开,窗口宽度变化时重排」。 */
const WIDTHS = [390, 640, 700, 889, 890, 939, 940, 1120, 1440, 1920];
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

  it("宽容器小舰队走雷达环:边缘围绕中心,不挤成一列", () => {
    const layout = computeFleetLayout(1440, 420, edgeIds(3));
    expect(layout.narrow).toBe(false);
    const center = layout.placement.get("center")!;
    const around = [...layout.placement.values()].filter((p) => p !== center);
    // 环形:至少一个边缘在中心卡的正上方或正下方(横向投影与中心重叠)。
    expect(
      around.some((p) => p.left < center.left + center.width && center.left < p.left + p.width),
      "a ring node sits above or below the center card",
    ).toBe(true);
  });

  it("宽容器大舰队走双翼列:画布高度随节点数扩展", () => {
    const six = computeFleetLayout(1120, 420, edgeIds(6));
    const twelve = computeFleetLayout(1120, 420, edgeIds(12));
    expect(twelve.canvasHeight).toBeGreaterThan(six.canvasHeight);
    // 12 个分两翼各 6:6×124 + 5×20 + 上下 padding。
    expect(twelve.canvasHeight).toBeGreaterThanOrEqual(6 * 124 + 5 * 20 + 32);
  });

  it("第 2 轮视觉修正:节点卡足够大,雷达环横向铺开,画布高度建议随节点数单调", () => {
    // 卡片尺寸下限:节点是画布主角,退回小卡即回归「画布大而空」的缺陷。
    expect(CENTER_CARD.width).toBeGreaterThanOrEqual(300);
    expect(CENTER_CARD.height).toBeGreaterThanOrEqual(140);
    expect(EDGE_CARD.width).toBeGreaterThanOrEqual(250);
    expect(EDGE_CARD.height).toBeGreaterThanOrEqual(120);
    // 1440 雷达环:边缘卡的横向跨度要吃掉画布宽度的大头(≥60%),不是挤在中间一撮。
    const ring = computeFleetLayout(1440, 460, edgeIds(3));
    const center = ring.placement.get("center")!;
    const edges = [...ring.placement.values()].filter((placement) => placement !== center);
    const leftEdge = Math.min(...edges.map((placement) => placement.left));
    const rightEdge = Math.max(...edges.map((placement) => placement.left + placement.width));
    expect((rightEdge - leftEdge) / ring.canvasWidth).toBeGreaterThanOrEqual(0.6);
    // 高度建议:节点越多画布越高,少节点时保持基础高度(不留死空白也不挤压)。
    const heights = [0, 1, 4, 8, 12].map((count) => suggestFleetCanvasHeight(count));
    expect(suggestFleetCanvasHeight(0)).toBeGreaterThanOrEqual(460);
    for (let index = 1; index < heights.length; index += 1)
      expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]!);
    expect(suggestFleetCanvasHeight(12)).toBeGreaterThan(suggestFleetCanvasHeight(2));
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

  it("画布高度建议覆盖环形形态的实际高度,底部节点不被容器折线裁半", () => {
    for (const count of [1, 2, 3, 4]) {
      const suggested = suggestFleetCanvasHeight(count);
      const layout = computeFleetLayout(1440, suggested, edgeIds(count));
      expect(
        layout.canvasHeight,
        `container ${suggested}px must fit the ring canvas (${layout.canvasHeight}px) for ${count} edges`,
      ).toBeLessThanOrEqual(suggested + MARGIN);
    }
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
});

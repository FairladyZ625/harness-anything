// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { regionMinimumHeight } from "../src/renderer/views/region-minimum.ts";

/**
 * 区域最小可用高度(标准 §2.1):标题行 + 行体里前三条完整行 + 页脚,量内容的自然位置。
 * 用假几何喂进去——happy-dom 不做布局,真实 DOM 的数由 Electron 实测留证。
 */

const box = (offsetTop: number, offsetHeight: number) => ({ offsetTop, offsetHeight });

function section(rows: readonly { offsetTop: number; offsetHeight: number }[], footer = true) {
  const body = { offsetTop: 36, rows };
  return {
    offsetHeight: 402,
    clientHeight: 400,
    children: [box(0, 36), { firstElementChild: body }, ...(footer ? [box(0, 28)] : [])],
  } as unknown as HTMLElement;
}

const rowsOf = (body: HTMLElement) => (body as unknown as { rows: Element[] }).rows;

describe("regionMinimumHeight", () => {
  it("covers the header, the first three rows as rendered, the footer and the frame border", () => {
    // 行高不等(58 / 58 / 41):下限跟实际底边走,不按行高常数乘。
    const rows = [box(36, 58), box(94, 58), box(152, 41), box(193, 58)];
    expect(regionMinimumHeight(section(rows), rowsOf)).toBe(36 + (152 + 41 - 36) + 28 + 2 + 1);
  });

  it("uses every row when there are fewer than three, and no footer when the region has none", () => {
    expect(regionMinimumHeight(section([box(36, 58)], false), rowsOf)).toBe(36 + 58 + 2 + 1);
  });

  it("has no minimum for a region without rows", () => {
    expect(regionMinimumHeight(section([]), rowsOf)).toBeUndefined();
  });
});

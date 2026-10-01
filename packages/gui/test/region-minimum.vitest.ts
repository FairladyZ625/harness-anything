// harness-test-tier: fast
import { afterEach, describe, expect, it, vi } from "vitest";
import { proseMinimumHeight, regionMinimumHeight } from "../src/renderer/components/primitives/region-minimum.ts";

/**
 * 区域最小可用高度(标准 §2.1):标题行 + 行体里前三条完整行 + 页脚,量内容的自然位置;
 * 正文型区域没有「条」,取标题行 + 约三行正文 + 页脚。
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

describe("proseMinimumHeight", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 行体是若干段落:first / last 是首尾两段的假几何,行高由 getComputedStyle 的桩给。
  function prose(paragraphs: readonly { offsetTop: number; offsetHeight: number }[], lineHeight: string) {
    vi.stubGlobal("getComputedStyle", () => ({ lineHeight }));
    const body = {
      offsetTop: 0,
      firstElementChild: paragraphs[0] ?? null,
      lastElementChild: paragraphs.at(-1) ?? null,
    };
    return {
      offsetHeight: 402,
      clientHeight: 400,
      children: [box(0, 36), { firstElementChild: body }, box(0, 28)],
    } as unknown as HTMLElement;
  }

  it("covers the header, three lines at the paragraph's own line height, the footer and the frame border", () => {
    // 正文 229px 高(十来行),行高 21px:下限只留三行,不留全文。
    expect(proseMinimumHeight(prose([box(0, 168), box(176, 53)], "21px"))).toBe(36 + 3 * 21 + 28 + 2 + 1);
  });

  it("uses the whole text when it is shorter than three lines", () => {
    expect(proseMinimumHeight(prose([box(0, 21)], "21px"))).toBe(36 + 21 + 28 + 2 + 1);
  });

  it("has no minimum for an empty body, or when the line height is not a length", () => {
    expect(proseMinimumHeight(prose([], "21px"))).toBeUndefined();
    expect(proseMinimumHeight(prose([box(0, 168)], "normal"))).toBeUndefined();
  });
});

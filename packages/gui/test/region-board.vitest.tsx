// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { DenseRow } from "../src/renderer/components/primitives/DenseRow";
import { Region } from "../src/renderer/components/primitives/Region";
import {
  BoardColumn,
  BoardMain,
  BoardRegion,
  BoardTimeline,
  RegionBoard,
} from "../src/renderer/components/primitives/RegionBoard";

/**
 * 区域板的列容器(标准 §2.1):主区一列或两列 + 最右一列时间线,区域外框带「至少露出三条」
 * 的实测下限。happy-dom 不做布局,这里只守结构与「哪些区域有下限」;真实
 * 高度分配由 Electron 实测留证。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const region = (key: string, rows: number, fill = false) =>
  createElement(
    BoardRegion,
    { key, region: key, fill, "data-testid": `box-${key}` },
    createElement(
      Region,
      { title: key },
      rows === 0
        ? createElement("p", null, "整篇文档")
        : Array.from({ length: rows }, (_, index) => createElement(DenseRow, { key: index, title: `行 ${index}` })),
    ),
  );

function board(main: readonly ReactNode[], timeline: boolean) {
  return createElement(
    RegionBoard,
    { "data-testid": "board" },
    createElement(
      BoardMain,
      { "data-testid": "main" },
      main.map((column, index) => createElement(BoardColumn, { key: index }, column)),
    ),
    timeline
      ? createElement(
          BoardTimeline,
          { "data-testid": "timeline" },
          createElement(Region, { title: "进展" }, createElement("p", null, "按天进展")),
        )
      : null,
  );
}

describe("RegionBoard", () => {
  it("lays regions out as board → main → columns, with the timeline as the board's last column", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(board([[region("mine", 1), region("stuck", 5)], [region("plan", 0, true)]], true)));

    const element = host.querySelector<HTMLElement>('[data-testid="board"]')!;
    // 断点量最近的 @container 祖先:≥900px 两列,≥1400px 主区的每一列自成一列。
    expect(element.className).toContain("@[900px]:grid-cols-2");
    expect(element.className).toContain("@[1400px]:grid-flow-col");
    const main = host.querySelector<HTMLElement>('[data-testid="main"]')!;
    expect([...element.children]).toEqual([main, host.querySelector('[data-testid="timeline"]')]);
    expect(main.className).toContain("@[900px]:overflow-y-auto");
    expect(main.className).toContain("@[1400px]:contents");
    expect(
      [...main.children].map((column) => [...column.children].map((box) => (box as HTMLElement).dataset.region)),
    ).toEqual([["mine", "stuck"], ["plan"]]);
    const timeline = host.querySelector<HTMLElement>('[data-testid="timeline"]')!;
    expect(timeline.dataset.region).toBe("recent");
    expect(timeline.closest('[data-testid="main"]')).toBeNull();
    // 每个外框里是一个被拉伸的 Region,内容在 Region 内部滚动。
    for (const box of host.querySelectorAll("[data-region]")) {
      expect(box.className).toContain("grid-rows-[minmax(0,1fr)]");
      expect(box.querySelector(":scope > section")!.children[1]!.firstElementChild!.className).toContain(
        "overflow-y-auto",
      );
    }
    act(() => root.unmount());
    host.remove();
  });

  it("measures a row minimum for regions made of rows, and gives document regions the remaining height instead", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(board([[region("plan", 0, true)]], false)));
    const box = (key: string) => host.querySelector<HTMLElement>(`[data-testid="box-${key}"]`)!;

    // 文档区没有「条」:不量下限,占满列内剩余高度并有固定的可读下限。
    expect(box("plan").style.minHeight).toBe("");
    expect(box("plan").className).toContain("@[900px]:flex-[1_1_100%]");
    expect(box("plan").className).toContain("@[900px]:min-h-[16rem]");

    // 之后才出现的区域也被量到(板每次渲染后重量,不靠调用方传依赖)。happy-dom 不做布局,
    // 数值来自测试桩的假几何,没有意义——有下限即说明行被认出来了。
    act(() => root.render(board([[region("stuck", 5)], [region("plan", 0, true)]], false)));
    expect(box("stuck").style.minHeight).toMatch(/^[1-9]\d*px$/u);
    expect(box("stuck").className).toContain("@[900px]:flex-[1_1_auto]");
    expect(box("plan").style.minHeight).toBe("");
    act(() => root.unmount());
    host.remove();
  });
});

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
  BoardSide,
  RegionBoard,
} from "../src/renderer/components/primitives/RegionBoard";

/**
 * 区域板的列容器(标准 §2.1):主区一列或两列 + 最右一列,两列时主区 3 份、右列 2 份;区域
 * 外框带实测下限(条目区至少露出三条,正文区至少露出约三行)。happy-dom 不做布局,这里只守
 * 结构与「哪些区域有下限」;真实宽度与高度分配由 Electron 实测留证。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

// rows 为 0 时行体是一段正文(没有「条」);行高写在元素上,happy-dom 才读得到。
const region = (key: string, rows: number, fill = false) =>
  createElement(
    BoardRegion,
    { key, region: key, fill, "data-testid": `box-${key}` },
    createElement(
      Region,
      { title: key },
      rows === 0
        ? createElement("p", { style: { lineHeight: "20px" } }, "一段正文")
        : Array.from({ length: rows }, (_, index) => createElement(DenseRow, { key: index, title: `行 ${index}` })),
    ),
  );

function board(main: readonly ReactNode[], side: boolean) {
  return createElement(
    RegionBoard,
    { "data-testid": "board" },
    createElement(
      BoardMain,
      { "data-testid": "main" },
      main.map((column, index) => createElement(BoardColumn, { key: index }, column)),
    ),
    side
      ? createElement(
          BoardSide,
          { region: "templates", "data-testid": "side" },
          createElement(Region, { title: "模板" }, createElement("p", null, "模板列表")),
        )
      : null,
  );
}

describe("RegionBoard", () => {
  it("lays regions out as board → main → columns, with the side region as the board's last column", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(board([[region("mine", 1), region("stuck", 5)], [region("plan", 0, true)]], true)));

    const element = host.querySelector<HTMLElement>('[data-testid="board"]')!;
    // 断点量最近的 @container 祖先:≥900px 两列(主区 3 份 | 右列 2 份),≥1400px 主区的每一列
    // 自成一列并与右列等宽。
    expect(element.className).toContain("@[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]");
    expect(element.className).not.toContain("grid-cols-2");
    expect(element.className).toContain("@[1400px]:grid-flow-col");
    expect(element.className).toContain("@[1400px]:auto-cols-[minmax(0,1fr)]");
    const main = host.querySelector<HTMLElement>('[data-testid="main"]')!;
    expect([...element.children]).toEqual([main, host.querySelector('[data-testid="side"]')]);
    expect(main.className).toContain("@[900px]:overflow-y-auto");
    // 没有右列的板,主区占满两列而不是只占 3 份。
    expect(main.className).toContain("@[900px]:only:col-span-full");
    expect(main.className).toContain("@[1400px]:contents");
    expect(
      [...main.children].map((column) => [...column.children].map((box) => (box as HTMLElement).dataset.region)),
    ).toEqual([["mine", "stuck"], ["plan"]]);
    // 右列的区域键由调用方给,不再写死成时间线的 recent。
    const side = host.querySelector<HTMLElement>('[data-testid="side"]')!;
    expect(side.dataset.region).toBe("templates");
    expect(side.closest('[data-testid="main"]')).toBeNull();
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

    // fill 的文档区:不用量出的下限,占满列内剩余高度并有固定的可读下限。
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

  it("gives a prose region without rows a line-height minimum, so its column neighbours cannot squeeze it to nothing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(board([[region("stuck", 5), region("purpose", 0)]], true)));
    const purpose = host.querySelector<HTMLElement>('[data-testid="box-purpose"]')!;
    // 正文区没有「条」也不是 fill:下限按正文的行高量。happy-dom 的几何全是 0,所以这里
    // 只守「有下限」;三行的算法在 region-minimum 的测试里用假几何守。
    expect(purpose.style.minHeight).toMatch(/^[1-9]\d*px$/u);
    expect(purpose.className).toContain("@[900px]:flex-[1_1_auto]");
    act(() => root.unmount());
    host.remove();
  });
});

// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FocusLayer } from "../src/renderer/components/primitives/FocusLayer.tsx";
import { Region } from "../src/renderer/components/primitives/Region.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 区域框的布局过渡只属于「原位放大/收回」:motion 的布局过渡是给元素套 transform: scale(),
 * 文字跟着被拉伸压扁。平时(数据到达、下限重量、窗口缩放)区域尺寸变了必须直接到位。
 * happy-dom 没有布局引擎,盒子由本文件按元素喂给 getBoundingClientRect。
 */

type Box = { left: number; top: number; width: number; height: number };
const SMALL: Box = { left: 100, top: 100, width: 400, height: 200 };
const TALL: Box = { left: 100, top: 100, width: 400, height: 600 };
const DIALOG: Box = { left: 300, top: 150, width: 1200, height: 800 };

let root: Root;
let host: HTMLDivElement;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // 区域的盒子跟着内容走:motion 在提交前量旧盒子、提交后量新盒子,与真实布局同序。
    const region = this.closest("section"),
      box =
        this.closest("[role=dialog]") !== null
          ? DIALOG
          : region === null
            ? null
            : region.textContent.includes("many rows")
              ? TALL
              : SMALL;
    // 内容层(外框的直接子元素)与外框同盒:够让 motion 把它们当成同一处的父子。
    const { left, top, width, height } = box ?? { left: 0, top: 0, width: 0, height: 0 };
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** 渲染提交后逐帧记下各元素的内联 transform(motion 的布局过渡写在这里)。 */
async function transformsAfter(render: () => void, pick: () => readonly (HTMLElement | null)[]) {
  const seen: string[] = [];
  act(render);
  for (let frame = 0; frame < 8; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (const element of pick()) seen.push(element?.style.transform ?? "");
  }
  return seen;
}
const section = () => host.querySelector<HTMLElement>("section");

it("a region without focusId is never scaled when its size changes", async () => {
  act(() => root.render(<Region title="plain">one row</Region>));
  const seen = await transformsAfter(
    () => root.render(<Region title="plain">many rows</Region>),
    () => [section(), ...section()!.querySelectorAll<HTMLElement>(":scope > div")],
  );
  expect(seen.filter((transform) => transform.includes("scale"))).toEqual([]);
});

it("a zoomable region is not scaled by its own size change while the focus layer stays closed", async () => {
  act(() =>
    root.render(
      <Region title="zoomable" focusId="mine">
        one row
      </Region>,
    ),
  );
  const seen = await transformsAfter(
    () =>
      root.render(
        <Region title="zoomable" focusId="mine">
          many rows
        </Region>,
      ),
    () => [section(), ...section()!.querySelectorAll<HTMLElement>(":scope > div")],
  );
  expect(seen.filter((transform) => transform.includes("scale"))).toEqual([]);
});

it("opening the focus layer grows its frame from the region box in the same commit, content unscaled", async () => {
  const board = (open: boolean) => (
    <>
      <Region title="zoomable" focusId="mine" focusOpen={open}>
        one row
      </Region>
      <FocusLayer
        open={open}
        sourceId="mine"
        title="zoomable"
        itemIds={[]}
        selectedId={null}
        onSelect={() => undefined}
        onClose={() => undefined}
        list={null}
        detail={null}
      />
    </>
  );
  act(() => root.render(board(false)));
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
  const frames = await transformsAfter(
    () => root.render(board(true)),
    () => [dialog(), dialog()?.querySelector<HTMLElement>(":scope > div") ?? null],
  );
  const scaleOf = (transform: string) => {
    const [, x, y] = /scale\(([\d.]+)(?:, ([\d.]+))?\)/u.exec(transform) ?? [];
    return [Number(x), Number(y ?? x)] as const;
  };
  // 提交后的第一帧外框就已经在从原区域的盒子(400×200)往放大层的盒子(1200×800)长。
  const [frameX, frameY] = scaleOf(frames[0]!);
  expect(frameX).toBeGreaterThanOrEqual(SMALL.width / DIALOG.width);
  expect(frameX).toBeLessThan(1);
  expect(frameY).toBeGreaterThanOrEqual(SMALL.height / DIALOG.height);
  expect(frameY).toBeLessThan(1);
  // 内容层反向补偿:与外框的缩放相乘是 1,文字保持原尺寸。
  const [contentX, contentY] = scaleOf(frames[1]!);
  expect(frameX * contentX).toBeCloseTo(1, 3);
  expect(frameY * contentY).toBeCloseTo(1, 3);
});

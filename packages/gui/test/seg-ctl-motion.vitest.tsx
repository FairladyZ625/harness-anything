// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY, useMotionPreference } from "../src/renderer/motion-config.tsx";
import { SegCtl } from "../src/renderer/components/primitives/SegCtl.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../src/renderer/motion-tokens.ts";

/**
 * A6 SegCtl 滑动指示:选中背景是 motion 共享元素(layoutId 按实例隔离),切换时
 * 从旧选项滑到新选项;「减少动态效果」或偏好「关」时不渲染 motion 元素,背景
 * 瞬时到位(规范 §6)。happy-dom 没有布局,这里断言「传给 motion 的合同」——
 * transition 取自动效 token、layoutId 随实例隔离;滑动本身的视觉在截图真机帧上验证。
 * 阴性对照:去掉 motion.span(或 reduced 分支),下面的 called/not-called 断言变红。
 */
const probe = vi.hoisted(() => ({ reduced: false, span: vi.fn(() => null) }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  motion: new Proxy({}, { get: () => probe.span }),
  useReducedMotion: () => probe.reduced,
}));

function PreferenceSwitcher() {
  const { setPreference } = useMotionPreference();
  return createElement("button", { "data-testid": "pref-off", onClick: () => setPreference("off") }, "off");
}

function Harness({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  return createElement(
    AppMotionConfig,
    null,
    createElement(SegCtl, {
      value,
      onChange: setValue,
      label: "Mode",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    }),
    createElement(PreferenceSwitcher),
  );
}

let root: Root;
let host: HTMLDivElement;
const mount = (initial: string) => {
  act(() => {
    root.render(createElement(Harness, { initial }));
  });
};
const buttons = () => [...host.querySelectorAll("button")].filter((b) => b.dataset.testid !== "pref-off");
const thumb = () => host.querySelector<HTMLElement>('[data-testid="seg-ctl-thumb"]');

beforeEach(() => {
  probe.reduced = false;
  probe.span.mockClear();
  // mock 的 motion.span 渲染真实 span(转发 testid/类名),DOM 结构断言才落得到地上。
  probe.span.mockImplementation((props: { "data-testid"?: string; className?: string }) =>
    createElement("span", { "data-testid": props["data-testid"], className: props.className }),
  );
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

it("renders the selected thumb as a shared element with token timing", () => {
  mount("a");
  expect(probe.span).toHaveBeenCalledTimes(1);
  const props = probe.span.mock.calls[0][0] as { layoutId: string; transition: object };
  expect(props.transition).toEqual({ duration: MOTION_DURATION.controlSlide, ease: MOTION_EASE.out });
  expect(props.transition).toEqual({ duration: 0.18, ease: "easeOut" });
  expect(typeof props.layoutId).toBe("string");
  expect(buttons()[0].contains(thumb())).toBe(true);
  expect(buttons()[1].contains(thumb())).toBe(false);
});

it("slides the thumb to the newly selected option under the same layoutId", () => {
  mount("a");
  const firstLayoutId = (probe.span.mock.calls[0][0] as { layoutId: string }).layoutId;
  probe.span.mockClear();
  act(() => buttons()[1].click());
  expect(probe.span).toHaveBeenCalledTimes(1);
  expect((probe.span.mock.calls[0][0] as { layoutId: string }).layoutId).toBe(firstLayoutId);
  expect(buttons()[1].contains(thumb())).toBe(true);
  expect(buttons()[0].contains(thumb())).toBe(false);
  expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
});

it("isolates layoutId per instance so neighbouring controls never share a thumb", () => {
  act(() => {
    root.render(
      createElement(
        AppMotionConfig,
        null,
        createElement(Harness, { initial: "a" }),
        createElement(Harness, { initial: "b" }),
      ),
    );
  });
  const ids = probe.span.mock.calls.map((call) => (call[0] as { layoutId: string }).layoutId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(host.querySelectorAll('[data-testid="seg-ctl-thumb"]')).toHaveLength(2);
});

it("reduced motion swaps the thumb instantly without a motion element", () => {
  probe.reduced = true;
  mount("a");
  expect(probe.span).not.toHaveBeenCalled();
  expect(thumb()?.className).toContain("bg-accent");
  act(() => buttons()[1].click());
  expect(probe.span).not.toHaveBeenCalled();
  expect(buttons()[1].contains(thumb())).toBe(true);
});

it("motion preference off likewise skips the motion element", () => {
  mount("a");
  act(() => {
    host.querySelector<HTMLButtonElement>('[data-testid="pref-off"]')!.click();
  });
  probe.span.mockClear();
  act(() => buttons()[1].click());
  expect(probe.span).not.toHaveBeenCalled();
  expect(buttons()[1].contains(thumb())).toBe(true);
});

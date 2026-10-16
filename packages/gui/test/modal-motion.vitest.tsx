// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY, useMotionPreference } from "../src/renderer/motion-config.tsx";
import { MODAL_MOTION, Modal } from "../src/renderer/components/primitives/Modal.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * A3 弹窗进出动效(task 细边与弹窗进出动效样张):Modal 原语内部承载进出场,
 * 对外接口不变(挂载即开、卸载即关)。断言三态偏好下的进场关键帧、卸载时的
 * 退场快照(克隆宿主的增删与关键帧)、偏好关闭时完全瞬时,以及原生 dialog
 * cancel(Esc)仍走 onClose。
 */
const probe = vi.hoisted(() => {
  const settleAll: ((value?: undefined) => void)[] = [];
  return {
    animate: vi.fn(() => {
      let settle: (value?: undefined) => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        settle = resolve;
      });
      settleAll.push(settle);
      return { stop: vi.fn(), complete: vi.fn(), finished };
    }),
    /** 手动放行动画完成:宿主移除时机由它驱动,断言才能观察到快照存续期。 */
    settleAll: () => {
      for (const settle of settleAll.splice(0)) settle();
    },
    reduced: false,
  };
});
vi.mock("motion", async (original) => ({ ...(await original<typeof import("motion")>()), animate: probe.animate }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => probe.reduced,
}));

function MotionPreferenceSwitcher() {
  const { setPreference } = useMotionPreference();
  return createElement(
    "button",
    {
      "data-testid": "pref-off",
      onClick: () => setPreference("off"),
    },
    "off",
  );
}

function Harness({ onClose }: { readonly onClose: () => void }) {
  return createElement(
    AppMotionConfig,
    null,
    createElement(Modal, { title: "样张", testId: "motion-modal", onClose }, "内容"),
    createElement(MotionPreferenceSwitcher),
  );
}

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
function mount() {
  act(() => {
    root.render(createElement(Harness, { onClose }));
  });
}
async function nextFrame() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  probe.animate.mockClear();
  probe.reduced = false;
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  setActiveLocale("zh-CN");
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  probe.settleAll();
  act(() => root.unmount());
  // 卸载调度的退场快照在下一帧才触发:冲掉这一帧,避免渗进下一个用例的记录。
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await Promise.resolve();
  await Promise.resolve();
  host.remove();
  for (const snapshot of document.querySelectorAll("[data-modal-exit-snapshot]")) snapshot.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

it("enters with rise+fade on scrim and panel at the layout-animation duration", () => {
  mount();
  const calls = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number; ease: string }][];
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toEqual({ opacity: [0, 1] });
  expect(calls[1]?.[1]).toEqual({ opacity: [0, 1], y: [MODAL_MOTION.enterDistance, 0] });
  for (const call of calls) {
    expect(call[2].duration).toBe(MODAL_MOTION.enterDuration);
    expect(call[2].ease).toBe("easeOut");
  }
  const dialog = host.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  expect(host.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
});

it("reduced motion enters opacity-only within the 120ms budget and exits the same way", async () => {
  probe.reduced = true;
  mount();
  const enter = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number }][];
  expect(enter).toHaveLength(2);
  for (const call of enter) {
    expect(call[1]).toEqual({ opacity: [0, 1] });
    expect(call[2].duration).toBe(MODAL_MOTION.reducedDuration);
  }
  probe.animate.mockClear();
  act(() => root.unmount());
  await nextFrame();
  const exit = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number }][];
  expect(exit.map((call) => [call[0].className.split(" ")[0], call[0].tagName, call[1]])).toEqual([
    ["glass-scrim", "DIV", { opacity: [1, 0] }],
    ["glass", "DIV", { opacity: [1, 0] }],
  ]);
  probe.settleAll();
  await nextFrame();
  expect(document.querySelector("[data-modal-exit-snapshot]")).toBeNull();
});

it("unmount plays an exit snapshot clone at the captured geometry, then removes it", async () => {
  mount();
  probe.animate.mockClear();
  act(() => root.unmount());
  await nextFrame();
  const snapshot = document.querySelector<HTMLElement>("[data-modal-exit-snapshot]");
  expect(snapshot).not.toBeNull();
  expect(snapshot?.getAttribute("aria-hidden")).toBe("true");
  const calls = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number; ease: string }][];
  expect(cases(calls)).toEqual([{ opacity: [1, 0] }, { opacity: [1, 0], y: [0, MODAL_MOTION.exitDistance] }]);
  expect(calls[0]?.[2].duration).toBe(MODAL_MOTION.exitDuration);
  expect(calls[1]?.[2].ease).toBe("easeIn");
  probe.settleAll();
  await nextFrame();
  expect(document.querySelector("[data-modal-exit-snapshot]")).toBeNull();
});

it("motion preference off disables both directions entirely", async () => {
  mount();
  act(() => {
    host.querySelector<HTMLButtonElement>('[data-testid="pref-off"]')!.click();
  });
  probe.animate.mockClear();
  act(() => root.unmount());
  await nextFrame();
  expect(probe.animate).not.toHaveBeenCalled();
  expect(document.querySelector("[data-modal-exit-snapshot]")).toBeNull();
});

it("dialog cancel (Esc) still routes to onClose", () => {
  mount();
  const dialog = host.querySelector("dialog")!;
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

function cases(calls: unknown[]) {
  return calls.map((call) => (call as [unknown, object])[1]);
}

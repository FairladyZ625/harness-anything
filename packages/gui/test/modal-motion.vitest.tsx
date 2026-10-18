// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY, useMotionPreference } from "../src/renderer/motion-config.tsx";
import { Modal } from "../src/renderer/components/primitives/Modal.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * A3 弹窗进出动效(dec_AEE443D93D207C4AEB032E7881 CH2):Modal 受 open 属性控制,
 * AnimatePresence 管进出;退场期间是真实 DOM,表单控件的当前值原样在场
 * (fact F-A7686F9B:卸载快照克隆会丢受控 select 的当前选中项)。
 *
 * happy-dom 没有 WAAPI 且 rAF 立即触发,motion 的 JS 后端时钟几乎不走。这里装一个
 * 虚拟帧时钟接管 requestAnimationFrame 与 performance.now:每泵一帧精确推进
 * 16.7ms,动画确定性地走完;泵帧包在 act() 里,motion 的 onExitComplete setState
 * 才会被冲刷。时长数值(300/180/100ms)的权威断言在截图脚本的真机帧上,这里断言
 * 关键帧形态与在场语义。
 */
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => probe.reduced,
}));
const probe = vi.hoisted(() => ({ reduced: false }));

const FRAME_MS = 16.7;
let virtualNow = 0;
let rafId = 0;
let rafQueue: { readonly id: number; readonly callback: FrameRequestCallback }[] = [];
let nowSpy: ReturnType<typeof vi.spyOn>;
let rafSpy: ReturnType<typeof vi.spyOn>;
/** 泵一帧:虚拟时钟前进一帧,队列里的 rAF 回调以帧时间戳触发。 */
async function frame() {
  await act(async () => {
    await Promise.resolve();
    const callbacks = rafQueue;
    rafQueue = [];
    virtualNow += FRAME_MS;
    for (const { callback } of callbacks) callback(virtualNow);
  });
}
/** 泵帧直至条件成立。 */
async function settle(condition: () => boolean, frames = 80) {
  let met = false;
  for (let index = 0; index < frames && !(met = condition()); index += 1) await frame();
  expect(met, `condition not met within ${frames} frames`).toBe(true);
}

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

/** 复刻 tab 类调用点的形态:守卫对象随关闭置 null,children/title 靠它求值。 */
function Harness({ onClose, initialOpen = false }: { readonly onClose: () => void; readonly initialOpen?: boolean }) {
  const [editing, setEditing] = useState<{ readonly unit: string } | null>(initialOpen ? { unit: "分钟" } : null);
  const [note, setNote] = useState("");
  const flip = () => setEditing((current) => (current === null ? { unit: "分钟" } : null));
  return createElement(
    AppMotionConfig,
    null,
    createElement("button", { "data-testid": "toggle", onClick: flip }, "toggle"),
    createElement(
      Modal,
      {
        open: editing !== null,
        title: editing === null ? "" : `单位:${editing.unit}`,
        testId: "motion-modal",
        onClose,
      },
      editing === null
        ? null
        : createElement(
            "select",
            {
              "data-testid": "unit-select",
              value: editing.unit,
              onChange: (event: { currentTarget: { value: string } }) =>
                setEditing({ unit: event.currentTarget.value }),
            },
            createElement("option", { value: "毫秒" }, "毫秒"),
            createElement("option", { value: "分钟" }, "分钟"),
          ),
      createElement("input", {
        "data-testid": "note-input",
        value: note,
        onChange: (event: { currentTarget: { value: string } }) => setNote(event.currentTarget.value),
      }),
    ),
    createElement(MotionPreferenceSwitcher),
  );
}

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
const openModal = () => {
  act(() => {
    host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
  });
};
const closeModal = () => {
  act(() => {
    host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
  });
};
function mount(initialOpen = false) {
  act(() => {
    root.render(createElement(Harness, { onClose, initialOpen }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  probe.reduced = false;
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  setActiveLocale("zh-CN");
  onClose.mockClear();
  virtualNow = 0;
  rafId = 0;
  rafQueue = [];
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => virtualNow);
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    rafId += 1;
    rafQueue.push({ id: rafId, callback });
    return rafId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await settle(() => host.querySelector("dialog") === null).catch(() => undefined);
  act(() => root.unmount());
  nowSpy.mockRestore();
  rafSpy.mockRestore();
  vi.restoreAllMocks();
  host.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

const panel = () => host.querySelector<HTMLElement>("dialog .glass");
const scrim = () => host.querySelector<HTMLElement>("dialog .glass-scrim");

it("opens on open=true with rise+fade keyframes and the native dialog open state", async () => {
  mount();
  openModal();
  expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  // 面板挂浮层表面档(2026-10-18 业主截图:模态透底、表单标签不可读):可读性由
  // .glass-overlay 的不透明面色承担,新建类对话框(Provider/Agent/定时计划)全走这里。
  expect(panel()?.className).toContain("glass-overlay");
  // 挂载提交即写初始关键帧:压暗层与面板全透明,面板带 10px 上浮偏移。
  expect(scrim()?.style.opacity).toBe("0");
  expect(panel()?.style.opacity).toBe("0");
  expect(panel()?.style.transform).toContain("translateY(10px)");
  await settle(() => panel()?.style.opacity === "1" && scrim()?.style.opacity === "1");
  expect(panel()?.style.transform).not.toContain("translateY");
  expect(host.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
});

it("reduced motion enters and exits opacity-only", async () => {
  probe.reduced = true;
  mount(true);
  expect(panel()?.style.transform).toBe("");
  expect(panel()?.style.opacity).toBe("0");
  await settle(() => panel()?.style.opacity === "1");
  expect(panel()?.style.transform).toBe("");
  closeModal();
  // 退场中段只淡出不位移。
  await settle(() => panel() !== null && Number(panel()?.style.opacity) < 0.9);
  expect(panel()?.style.transform).toBe("");
  await settle(() => host.querySelector("dialog") === null);
});

it("exits through fall+fade keyframes and keeps the real DOM until the exit completes", async () => {
  mount(true);
  await settle(() => panel()?.style.opacity === "1");
  closeModal();
  // 关闭当帧:真实 DOM 还在,退场从原值起,不瞬时消失。
  const exiting = panel();
  expect(exiting).not.toBeNull();
  expect(exiting?.style.opacity).toBe("1");
  // 退场中段:面板在下落(正值的 y 位移)并淡出,压暗层同步淡出,节点仍连接。
  await settle(() => panel() !== null && Number(panel()?.style.opacity) < 0.9);
  expect(/translateY\([0-9.]+px\)/u.test(panel()?.style.transform ?? "")).toBe(true);
  expect(Number(scrim()?.style.opacity)).toBeLessThan(0.9);
  expect(exiting.isConnected).toBe(true);
  await settle(() => host.querySelector("dialog") === null);
  expect(exiting.isConnected).toBe(false);
});

it("keeps the live form values visible while the exit is playing (F-A7686F9B)", async () => {
  mount();
  openModal();
  const select = () => host.querySelector<HTMLSelectElement>('[data-testid="unit-select"]');
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="note-input"]');
  await settle(() => panel()?.style.opacity === "1");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select()!, "分钟");
    select()!.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input()!, "退场中不丢");
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(select()!.value).toBe("分钟");
  closeModal();
  // 退场进行中:守卫对象已置 null,但正在退场的真实 DOM 仍显示关闭时的当前值。
  await settle(() => panel() !== null && Number(panel()?.style.opacity) < 0.9);
  expect(select()).not.toBeNull();
  expect(select()!.value).toBe("分钟");
  expect(select()!.selectedOptions[0]?.textContent).toBe("分钟");
  expect(input()!.value).toBe("退场中不丢");
  expect(host.querySelector("dialog b")?.textContent).toBe("单位:分钟");
  await settle(() => host.querySelector("dialog") === null);
  expect(select()).toBeNull();
});

it("motion preference off shows and hides instantly with no animation", async () => {
  mount();
  openModal();
  await settle(() => panel()?.style.opacity === "1");
  closeModal();
  await settle(() => host.querySelector("dialog") === null);
  // 弹窗常驻期间把偏好切到「关」:重开不再从透明起播,关闭免动画卸载。
  act(() => {
    host.querySelector<HTMLButtonElement>('[data-testid="pref-off"]')!.click();
  });
  openModal();
  expect(["", "1"].includes(panel()?.style.opacity ?? "")).toBe(true);
  expect(panel()?.style.transform).toBe("");
  closeModal();
  await settle(() => host.querySelector("dialog") === null, 20);
});

it("dialog cancel (Esc) still routes to onClose", () => {
  mount(true);
  act(() => {
    host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY } from "../src/renderer/motion-config.tsx";
import { FocusLayer } from "../src/renderer/components/primitives/FocusLayer.tsx";
import { Drawer } from "../src/renderer/components/primitives/Drawer.tsx";
import { MOTION_DURATION } from "../src/renderer/motion-tokens.ts";

/**
 * 压暗层 reduced 分支守卫(业主体感 2026-10-17 批准的存量修复;规范 §6:减弱动效只留
 * ≤120ms 纯淡入):FocusLayer 与 Drawer 的 scrim 是纯 opacity,motion 库在减弱动效下只
 * 瞬时化位移/布局,opacity 仍按原时长播——修复前分别是 350ms/300ms。这里用虚拟帧时钟
 * (每帧 16.7ms)断言:系统+OS 减弱动效下,压暗层在 120ms 预算内淡满(旧值需要 18–21 帧,
 * 新值 ≤8 帧,判定力充分);偏好「关」时挂载即不播。
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
/** 泵一帧并返回累计帧数;虚拟时钟前进一帧,队列里的 rAF 回调以帧时间戳触发。 */
async function frame() {
  await act(async () => {
    await Promise.resolve();
    const callbacks = rafQueue;
    rafQueue = [];
    virtualNow += FRAME_MS;
    for (const { callback } of callbacks) callback(virtualNow);
  });
}

let root: Root;
let host: HTMLDivElement;
function mount(child: React.ReactNode) {
  act(() => {
    root.render(createElement(AppMotionConfig, null, child));
  });
}
const focusLayer = (open: boolean) =>
  createElement(FocusLayer, {
    open,
    title: "清单",
    itemIds: ["a"],
    selectedId: "a",
    onSelect: () => {},
    onClose: () => {},
    list: createElement("div", null, "list"),
    detail: createElement("div", null, "detail"),
  });
const drawer = (open: boolean) =>
  createElement(Drawer, { open, onClose: () => {}, ariaLabel: "详情" }, createElement("div", null, "content"));

/** 泵帧直到压暗层淡满,返回用掉的帧数(每帧 16.7ms)。 */
async function framesToFullOpacity(scrim: () => Element | null, budgetFrames: number) {
  let used = 0;
  while ((scrim()?.style.opacity ?? "1") !== "1" && used <= budgetFrames + 12) {
    await frame();
    used += 1;
  }
  return used;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  probe.reduced = false;
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
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
afterEach(() => {
  act(() => root.unmount());
  nowSpy.mockRestore();
  rafSpy.mockRestore();
  vi.restoreAllMocks();
  host.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

it("FocusLayer scrim fades in within the reduced-motion budget instead of the full scrim duration", async () => {
  probe.reduced = true;
  mount(focusLayer(true));
  const scrim = () => document.body.querySelector(".glass-scrim");
  expect(scrim()?.style.opacity).toBe("0");
  const used = await framesToFullOpacity(scrim, 8);
  // 120ms 预算 = 8 帧(133ms);修复前的 focusScrim 350ms 需要约 21 帧,此处必然超预算变红。
  expect(used, `scrim took ${used} frames (${used * FRAME_MS}ms)`).toBeLessThanOrEqual(8);
  expect(MOTION_DURATION.reducedFade).toBeLessThanOrEqual(0.12);
});

it("modal Drawer scrim fades in within the reduced-motion budget instead of the overlay rise duration", async () => {
  probe.reduced = true;
  mount(drawer(true));
  const scrim = () => document.body.querySelector(".glass-scrim");
  expect(scrim()?.style.opacity).toBe("0");
  const used = await framesToFullOpacity(scrim, 8);
  // 修复前的 overlayRise 300ms 需要约 18 帧,此处必然超预算变红。
  expect(used, `scrim took ${used} frames (${used * FRAME_MS}ms)`).toBeLessThanOrEqual(8);
});

it("motion preference off mounts both scrims without any fade", async () => {
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "off");
  mount(focusLayer(true));
  const focusScrim = () => document.body.querySelector(".glass-scrim");
  expect(focusScrim()?.style.opacity).not.toBe("0");
  await frame();
  await frame();
  expect(focusScrim()?.style.opacity ?? "1").toBe("1");
  // 同一棵树里换挂 Drawer(替换子树,不卸 root)。
  mount(drawer(true));
  const drawerScrim = () => document.body.querySelector(".glass-scrim");
  expect(drawerScrim()?.style.opacity).not.toBe("0");
  await frame();
  await frame();
  expect(drawerScrim()?.style.opacity ?? "1").toBe("1");
});

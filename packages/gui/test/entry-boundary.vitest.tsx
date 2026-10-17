// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AppMotionConfig,
  MOTION_PREFERENCE_STORAGE_KEY,
  useMotionPreference,
  type MotionPreference,
} from "../src/renderer/motion-config.tsx";
import { PageEntryBoundary, TabPanel } from "../src/renderer/components/primitives/EntryBoundary.tsx";
import { pageEntryIdentity } from "../src/renderer/components/primitives/page-entry-identity.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import type { AppLocation } from "../src/renderer/navigation/viewHistory.ts";
import { MOTION_DURATION } from "../src/renderer/motion-tokens.ts";

const probe = vi.hoisted(() => ({ animate: vi.fn(() => ({ complete: vi.fn() })), reduced: false }));
vi.mock("motion", async (original) => ({ ...(await original<typeof import("motion")>()), animate: probe.animate }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => probe.reduced,
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  probe.animate.mockClear();
  probe.reduced = false;
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
/** 树内的偏好切换器:与设置页走同一个 useMotionPreference().setPreference,验证不重载立即生效。 */
function PreferenceSwitcher() {
  const { setPreference } = useMotionPreference();
  return (
    <>
      {(["system", "on", "off"] as const).map((preference) => (
        <button key={preference} data-testid={`pref-${preference}`} onClick={() => setPreference(preference)}>
          {preference}
        </button>
      ))}
    </>
  );
}
function switchPreference(preference: MotionPreference) {
  act(() => host.querySelector<HTMLButtonElement>(`[data-testid="pref-${preference}"]`)!.click());
}
function render(page: string, tab = "overview", revision = 0, regions = 3) {
  act(() =>
    root.render(
      <AppMotionConfig>
        <PageEntryBoundary identity={page}>
          <TabPanel idPrefix="example" value={tab}>
            {Array.from({ length: regions }, (_, i) => (
              <section data-entry-region key={`${revision}-${i}`}>
                Region {i}
              </section>
            ))}
          </TabPanel>
        </PageEntryBoundary>
        <PreferenceSwitcher />
      </AppMotionConfig>,
    ),
  );
}
it("plays only explicit identity changes, including simultaneous page and tab changes", () => {
  render("first");
  expect(probe.animate).not.toHaveBeenCalled();
  render("first", "evidence");
  expect(probe.animate).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("example-tab-evidence");
  probe.animate.mockClear();
  render("first", "evidence", 1);
  expect(probe.animate).not.toHaveBeenCalled();
  render("second", "overview", 2);
  expect(probe.animate).toHaveBeenCalledTimes(3);
  probe.animate.mockClear();
  render("second", "overview", 3);
  expect(probe.animate).not.toHaveBeenCalled();
});
it("does not replay when Pending is replaced by late data or subsequent refreshes", () => {
  render("first", "overview", 0, 0);
  render("second", "overview", 0, 0);
  expect(probe.animate).toHaveBeenCalledTimes(1);
  probe.animate.mockClear();
  render("second", "overview", 1);
  render("second", "overview", 2);
  expect(probe.animate).not.toHaveBeenCalled();
});
it("caps region staggering and animates a region-free panel only once", () => {
  render("first", "overview", 0, 12);
  render("second", "overview", 0, 12);
  const calls = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number; delay: number }][];
  expect(calls[0]?.[1]).toEqual({ opacity: [0, 1], y: [7, 0] });
  expect(calls[0]?.[2].duration).toBe(MOTION_DURATION.entryRise);
  expect(calls[1]?.[2].delay).toBe(MOTION_DURATION.entryStagger);
  expect(calls.at(-1)?.[2].delay).toBe(MOTION_DURATION.entryMaxDelay);
  // 入场整体(时长+封顶)不拖沓的上界;档位区间断言在 motion-tokens.vitest.ts。
  expect(MOTION_DURATION.entryRise + MOTION_DURATION.entryMaxDelay).toBeLessThanOrEqual(0.45);
  probe.animate.mockClear();
  render("third", "overview", 0, 0);
  expect(probe.animate).toHaveBeenCalledTimes(1);
});
it("follows reduced motion, supports always on, and disables entrance when off", () => {
  probe.reduced = true;
  render("first");
  render("second");
  expect(probe.animate.mock.calls[0]?.slice(1)).toEqual([
    { opacity: [0, 1] },
    { duration: 0.1, delay: 0, ease: "easeOut" },
  ]);
  probe.animate.mockClear();
  // 同一棵树内切到「始终开启」(设置页同一路径):系统减弱动态仍开,入场立即恢复位移。
  switchPreference("on");
  render("third");
  expect(probe.animate.mock.calls[0]?.[1]).toEqual({ opacity: [0, 1], y: [7, 0] });
  probe.animate.mockClear();
  switchPreference("off");
  render("fourth");
  expect(probe.animate).not.toHaveBeenCalled();
});

it("does not replay page entry when a task preview drawer opens or switches (previewId-only change)", () => {
  // App.tsx 的真实形态:边界吃 pageEntryIdentity(projectId, location)。任务预览抽屉
  // 只改 previewId(打开 task-a、切到 task-b),页面没换,内容区入场不得重播
  // (业主 2026-10-17 反馈的存量问题;identity 从不含 previewId,这里把契约钉成测试)。
  const baseLocation: AppLocation = {
    view: "board",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: DEFAULT_TASK_FILTERS,
    drill: null,
  };
  const renderLocation = (patch: Partial<AppLocation>) => {
    const location = { ...baseLocation, ...patch };
    act(() =>
      root.render(
        <AppMotionConfig>
          <PageEntryBoundary identity={pageEntryIdentity("project", location)}>
            <section data-entry-region>Board</section>
          </PageEntryBoundary>
        </AppMotionConfig>,
      ),
    );
  };
  renderLocation({});
  renderLocation({ view: "agenda" });
  expect(probe.animate).toHaveBeenCalledTimes(1);
  probe.animate.mockClear();
  renderLocation({ view: "agenda", previewId: "task-a" });
  renderLocation({ view: "agenda", previewId: "task-b" });
  expect(probe.animate).not.toHaveBeenCalled();
});

it("allows local tab switching after a page switch without rerendering the page boundary", () => {
  function LocalTabs() {
    const [tab, setTab] = useState("overview");
    return (
      <>
        <button onClick={() => setTab("evidence")}>Switch tab</button>
        <TabPanel idPrefix="local" value={tab}>
          <section data-entry-region>Content</section>
        </TabPanel>
      </>
    );
  }
  function page(identity: string) {
    act(() =>
      root.render(
        <AppMotionConfig>
          <PageEntryBoundary identity={identity}>
            <LocalTabs />
          </PageEntryBoundary>
        </AppMotionConfig>,
      ),
    );
  }
  page("first");
  page("second");
  expect(probe.animate).toHaveBeenCalledTimes(1);
  probe.animate.mockClear();
  act(() => host.querySelector("button")!.click());
  expect(probe.animate).toHaveBeenCalledTimes(1);
});

it("reads the stored motion preference and falls back to following the system", async () => {
  const { MOTION_PREFERENCE_STORAGE_KEY, storedMotionPreference } = await import("../src/renderer/motion-config.tsx");
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  expect(storedMotionPreference()).toBe("system");
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "on");
  expect(storedMotionPreference()).toBe("on");
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "off");
  expect(storedMotionPreference()).toBe("off");
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "bounce");
  expect(storedMotionPreference()).toBe("system");
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

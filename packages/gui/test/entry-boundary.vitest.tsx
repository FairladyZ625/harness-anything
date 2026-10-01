// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMotionConfig, type MotionPreference } from "../src/renderer/motion-config.tsx";
import { ENTRY_MOTION, PageEntryBoundary, TabPanel } from "../src/renderer/components/primitives/EntryBoundary.tsx";

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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function render(page: string, tab = "overview", revision = 0, preference: MotionPreference = "system", regions = 3) {
  act(() =>
    root.render(
      <AppMotionConfig preference={preference}>
        <PageEntryBoundary identity={page}>
          <TabPanel idPrefix="example" value={tab}>
            {Array.from({ length: regions }, (_, i) => (
              <section data-entry-region key={`${revision}-${i}`}>
                Region {i}
              </section>
            ))}
          </TabPanel>
        </PageEntryBoundary>
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
  render("first", "overview", 0, "system", 0);
  render("second", "overview", 0, "system", 0);
  expect(probe.animate).toHaveBeenCalledTimes(1);
  probe.animate.mockClear();
  render("second", "overview", 1);
  render("second", "overview", 2);
  expect(probe.animate).not.toHaveBeenCalled();
});
it("caps region staggering and animates a region-free panel only once", () => {
  render("first", "overview", 0, "system", 12);
  render("second", "overview", 0, "system", 12);
  const calls = probe.animate.mock.calls as unknown as [HTMLElement, object, { duration: number; delay: number }][];
  expect(calls[0]?.[1]).toEqual({ opacity: [0, 1], y: [7, 0] });
  expect(calls[1]?.[2].delay).toBe(0.025);
  expect(calls.at(-1)?.[2].delay).toBe(0.1);
  expect(ENTRY_MOTION.duration + ENTRY_MOTION.maxDelay).toBeLessThanOrEqual(0.28);
  probe.animate.mockClear();
  render("third", "overview", 0, "system", 0);
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
  render("third", "overview", 0, "on");
  expect(probe.animate.mock.calls[0]?.[1]).toEqual({ opacity: [0, 1], y: [7, 0] });
  probe.animate.mockClear();
  render("fourth", "overview", 0, "off");
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

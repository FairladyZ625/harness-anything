// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useViewHistory } from "../src/renderer/navigation/useViewHistory.ts";
import { useProjectSwitch } from "../src/renderer/navigation/useProjectSwitch.ts";
import { initialLocation } from "../src/renderer/navigation/viewHistoryStorage.ts";
import type { AppLocation } from "../src/renderer/navigation/viewHistory.ts";

/**
 * 切仓恢复位置(业主 2026-10-11:切回项目直接回到它上次停留的页面)。挂真实的
 * useViewHistory + useProjectSwitch(与 App.tsx 同一接线,projectId 可切换),
 * 覆盖任务约束链:A 下钻任务 → 切 B → 切回 A 回到该任务;从没打开过的仓落总览;
 * 位置失效(存储里的 view 已随页面撤销)落总览不报错;重启(会话存储清空)后
 * 位置仍从 localStorage 恢复;显式目标/跨仓续导航推在恢复栈之上,后退原路返回。
 *
 * 「恢复的位置指向已删除任务」不在此层:渲染侧 App 的 selected 派生
 * (tasks.find(...) ?? null)自会落底层视图,不新增机制;见 e2e 场景与 App.tsx。
 */

interface Harness {
  readonly repoId: string;
  readonly location: AppLocation;
  readonly canBack: boolean;
  gotoBoard: () => void;
  drillTask: (taskId: string) => void;
  navigateLocal: (fields: Partial<AppLocation>) => void;
  openProject: (repoId: string, targetView?: "agenda" | "graph", continueInRepo?: () => void) => Promise<void>;
}

const mounted: Root[] = [];
let latest: Harness | null = null;

function Probe({ initialRepo }: { readonly initialRepo: string }) {
  // 与 App.tsx 同构:useViewHistory 持位置,useProjectSwitch 持切仓策略,
  // switchProject 即 App 的 setActiveRepoId。
  const [repoId, setRepoId] = useState(initialRepo);
  const { location, navigate, canBack } = useViewHistory(repoId, initialLocation());
  const { openProject } = useProjectSwitch({ projectId: repoId, navigate, switchProject: setRepoId });
  latest = {
    repoId,
    location,
    canBack,
    gotoBoard: () =>
      navigate({ view: "board", focusedEntityRef: null, selectedId: null, previewId: null, drill: null }),
    drillTask: (taskId) => navigate({ selectedId: taskId, previewId: null }),
    navigateLocal: (fields) => navigate(fields),
    openProject,
  };
  return null;
}

async function mountProbe(initialRepo = "proj-a") {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe, { initialRepo })));
  return () => latest!;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  latest = null;
});

describe("切仓恢复位置(业主 2026-10-11)", () => {
  it("项目 A 下钻任务 → 切到 B → 切回 A,回到该任务页面且后退仍可用", async () => {
    const h = await mountProbe();
    act(() => h().gotoBoard());
    act(() => h().drillTask("t1"));
    expect(h().location.view).toBe("board");
    expect(h().location.selectedId).toBe("t1");
    // 切到从没打开过的 B:落 B 的总览(项目主页)。
    await act(async () => h().openProject("proj-b"));
    expect(h().repoId).toBe("proj-b");
    expect(h().location.view).toBe("overview");
    expect(h().location.selectedId).toBeNull();
    // 切回 A:直接回到任务 t1 的位置,栈完整(可后退回看板)。
    await act(async () => h().openProject("proj-a"));
    expect(h().repoId).toBe("proj-a");
    expect(h().location.view).toBe("board");
    expect(h().location.selectedId).toBe("t1");
    expect(h().canBack).toBe(true);
  });

  it("重启(会话存储清空)后位置仍恢复:历史栈存 localStorage 而非 sessionStorage", async () => {
    const h = await mountProbe();
    act(() => h().gotoBoard());
    act(() => h().drillTask("t1"));
    await act(async () => {
      for (const root of mounted.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    // 重启 = 会话存储丢失,本地偏好保留。
    window.sessionStorage.clear();
    const h2 = await mountProbe();
    expect(h2().location.view).toBe("board");
    expect(h2().location.selectedId).toBe("t1");
    expect(h2().canBack).toBe(true);
  });

  it("上次位置已失效(存储里的 view 已随页面撤销)时回项目总览,不报错", async () => {
    window.localStorage.setItem(
      "harness-view-history:proj-stale",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [
            {
              view: "workbench",
              selectedId: null,
              previewId: null,
              focusedEntityRef: null,
              taskFilters: initialLocation().taskFilters,
              drill: null,
            },
          ],
          index: 0,
        },
      }),
    );
    const h = await mountProbe("proj-b");
    await act(async () => h().openProject("proj-stale"));
    expect(h().repoId).toBe("proj-stale");
    expect(h().location.view).toBe("overview");
  });

  it("显式目标(管理页活动链接)落在恢复栈之上:到达目标,后退原路回上次位置", async () => {
    // B 先有历史:board → 下钻 t9。
    const h = await mountProbe("proj-b");
    act(() => h().gotoBoard());
    act(() => h().drillTask("t9"));
    await act(async () => h().openProject("proj-a"));
    await act(async () => h().openProject("proj-b", "agenda"));
    expect(h().location.view).toBe("agenda");
    expect(h().canBack).toBe(true);
  });

  it("跨仓实体导航(续导航)落在恢复栈之上:到达实体,后退原路返回", async () => {
    const h = await mountProbe("proj-a");
    act(() => h().drillTask("t1"));
    // 与 App 的 openInRepo 同构:续导航经 pending intent 在切仓落地后执行。
    await act(async () =>
      h().openProject("proj-b", undefined, () => {
        latest?.navigateLocal({ view: "graph", focusedEntityRef: "decision/d1", selectedId: null, previewId: null });
      }),
    );
    expect(h().repoId).toBe("proj-b");
    expect(h().location.view).toBe("graph");
    expect(h().location.focusedEntityRef).toBe("decision/d1");
    expect(h().canBack).toBe(true);
  });
});

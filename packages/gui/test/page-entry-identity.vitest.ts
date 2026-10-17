// harness-test-tier: fast
import { expect, it } from "vitest";
import { pageEntryIdentity } from "../src/renderer/components/primitives/page-entry-identity.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import type { AppLocation } from "../src/renderer/navigation/viewHistory.ts";

const location: AppLocation = {
  view: "overview",
  selectedId: null,
  previewId: null,
  focusedEntityRef: null,
  taskFilters: DEFAULT_TASK_FILTERS,
  drill: null,
};
const identity = (patch: Partial<AppLocation>, project = "project") =>
  pageEntryIdentity(project, { ...location, ...patch });

it("distinguishes page kinds and projects", () => {
  expect(identity({ view: "agenda" })).not.toBe(identity({ view: "overview" }));
  expect(identity({}, "other")).not.toBe(identity({}));
  expect(identity({ selectedId: "task-a" })).not.toBe(identity({}));
});
it("distinguishes entities within each detail page", () => {
  expect(identity({ selectedId: "task-a" })).not.toBe(identity({ selectedId: "task-b" }));
  expect(identity({ view: "workspace", scopeRootTaskId: "work-a" })).not.toBe(
    identity({ view: "workspace", scopeRootTaskId: "work-b" }),
  );
  for (const view of [
    "decisionDetail",
    "factDetail",
    "presets",
    "entities",
    "sessions",
    "agentSquad",
    "providers",
    "schedules",
    "daemonObserve",
  ] as const) {
    expect(identity({ view, focusedEntityRef: "decision/a" })).not.toBe(
      identity({ view, focusedEntityRef: "decision/b" }),
    );
  }
});
it("keeps identity through filters, previews and entity sublocations", () => {
  const detail = { view: "decisionDetail", focusedEntityRef: "decision/a" } as const;
  expect(identity({ ...detail, taskFilters: { ...DEFAULT_TASK_FILTERS, query: "changed" }, previewId: "task-b" })).toBe(
    identity(detail),
  );
  expect(identity({ ...detail, focusedEntityRef: "decisionreview/a/report/review-1" })).toBe(identity(detail));
  expect(identity({ view: "sessions", focusedEntityRef: "session/a/log" })).toBe(
    identity({ view: "sessions", focusedEntityRef: "session/a" }),
  );
});
it("keeps identity when a task preview drawer opens or switches on the views that host it", () => {
  // 任务预览抽屉(全局 previewId)的承载面:看板卡片、工作页任务列表、详情页旁路。
  // 打开(null→task-a)与抽屉内切换(task-a→task-b)都是「页面没换」,不得重播入场
  // (业主 2026-10-17 反馈;身份只由「页面是谁」决定,不含 previewId)。
  for (const view of ["board", "agenda", "workspace", "overview"] as const) {
    const closed = identity({ view, scopeRootTaskId: view === "workspace" ? "work-a" : null });
    expect(identity({ view, scopeRootTaskId: view === "workspace" ? "work-a" : null, previewId: "task-a" })).toBe(
      closed,
    );
    expect(identity({ view, scopeRootTaskId: view === "workspace" ? "work-a" : null, previewId: "task-b" })).toBe(
      closed,
    );
  }
});

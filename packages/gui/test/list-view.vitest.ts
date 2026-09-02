// harness-test-tier: contract
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { ListView } from "../src/renderer/views/ListView.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { taskProjectionFields } from "./task-projection-fields.ts";

beforeAll(() => setActiveLocale("en-US"));

const makeTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  taskId: "task-a",
  title: "Alpha",
  projectId: "p",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  module: "core",
  lastKnownAt: "2026-07-09T00:00:00.000Z",
  gates: [],
  docs: [],
  ...taskProjectionFields(overrides.coordinationStatus ?? "active", {
    archived: (overrides.packageDisposition ?? "active") !== "active",
  }),
  ...overrides,
});

// The list is an audit view: rows navigate, the pager pages, favorites pin.
// Batch operations were removed together with their simulated-alert buttons — until a
// real batch command exists in the daemon registry there is nothing honest for a
// selection to do, so no selection affordance is rendered either.
describe("list view", () => {
  it("pins ledger-pinned tasks to the top with a marker and an inline write affordance", () => {
    const later = makeTask({ taskId: "task-later", title: "Later", lastKnownAt: "2026-07-01T00:00:00.000Z" });
    const pinned = makeTask({
      taskId: "task-pinned",
      title: "Pinned today",
      lastKnownAt: "2026-06-01T00:00:00.000Z",
      pinned: true,
      activeExecutionId: "execution-holder",
      leaseHolder: "person-zeyu · codex-sol",
      leasePhase: "held",
      leaseExpiresAt: "2026-08-30T01:00:00.000Z",
      currentNode: "review",
      canonicalStatus: "active",
    });
    const favorite = makeTask({ taskId: "task-favorite", title: "Favorite", lastKnownAt: "2026-07-05T00:00:00.000Z" });
    const tasks = [later, pinned, favorite];
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks,
        allTasks: tasks,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        relations: [],
        favorites: new Set(["task-favorite"]),
        onToggleFavorite: () => undefined,
        onSetPin: () => undefined,
        embedded: true,
      }),
    );
    // 置顶次序:台账 pin → 本地收藏 → 更新时间。
    const firstRow = markup.indexOf("task-pinned"),
      secondRow = markup.indexOf("task-favorite"),
      thirdRow = markup.indexOf("task-later");
    expect(firstRow).toBeGreaterThan(-1);
    expect(firstRow).toBeLessThan(secondRow);
    expect(secondRow).toBeLessThan(thirdRow);
    expect(markup).toContain("task-pinned-marker-task-pinned");
    expect(markup).toContain("task-pin-toggle-task-pinned");
    // 行内直接给出 status / currentNode / lease 持有者,不必点进详情。
    expect(markup).toContain("node:review");
    expect(markup).toContain("execution-holder");
    expect(markup).toContain("person-zeyu · codex-sol");
    expect(markup).toContain("held");
    expect(markup).toContain("no lease");
  });

  it("keeps pinned state read-only when no pin write channel is wired", () => {
    const pinned = makeTask({ taskId: "task-pinned", title: "Pinned", pinned: true });
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks: [pinned],
        allTasks: [pinned],
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    expect(markup).toContain("task-pinned-marker-task-pinned");
    expect(markup).not.toContain("task-pin-toggle-");
  });

  it("renders rows and the pager without any selection or batch-operation affordance", () => {
    const tasks = [makeTask(), makeTask({ taskId: "task-b", title: "Beta" })];
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks,
        allTasks: tasks,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        relations: [],
        favorites: new Set(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    for (const text of ["task-a", "Alpha", "task-b", "Beta", "Previous page", "Next page"])
      expect(markup).toContain(text);
    expect(markup).not.toContain('type="checkbox"');
    for (const gone of ["Batch operations", "Batch run Check", "Batch mark Ready", "Batch archiving", "Deselect"])
      expect(markup).not.toContain(gone);
  });
});

// harness-test-tier: contract
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { ListView } from "../src/renderer/views/ListView.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

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
  ...overrides,
});

// The list is an audit view: rows navigate, the pager pages, favorites pin.
// Batch operations were removed together with their simulated-alert buttons — until a
// real batch command exists in the daemon registry there is nothing honest for a
// selection to do, so no selection affordance is rendered either.
describe("list view", () => {
  it("renders rows and the pager without any selection or batch-operation affordance", () => {
    const tasks = [makeTask(), makeTask({ taskId: "task-b", title: "Beta" })];
    const markup = renderToStaticMarkup(createElement(ListView, { tasks, allTasks: tasks, filters: DEFAULT_TASK_FILTERS, onFiltersChange: () => undefined, onSelect: () => undefined, relations: [], favorites: new Set(), onToggleFavorite: () => undefined, embedded: true }));
    for (const text of ["task-a", "Alpha", "task-b", "Beta", "Previous page", "Next page"]) expect(markup).toContain(text);
    expect(markup).not.toContain('type="checkbox"');
    for (const gone of ["Batch operations", "Batch run Check", "Batch mark Ready", "Batch archiving", "Deselect"]) expect(markup).not.toContain(gone);
  });
});

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskProjectionRow } from "../../kernel/src/index.ts";
import {
  buildGuiViewModelFromTaskProjection,
  readGuiTaskDetailResult,
  readGuiTaskDocumentResult,
  readGuiTaskListResult,
  toGuiCommandFeedback
} from "../src/api/view-model.ts";
import { rendererCapabilityModel, rendererNavigation } from "../src/renderer/app-model.ts";
import {
  LEDGER_REFRESH_INTERVAL_MS,
  createRendererQueryClient,
  ledgerRefreshInterval,
  setProjectionPushActive,
} from "../src/renderer/query-client.ts";
import { GraphView } from "../src/renderer/views/GraphView.tsx";
import { applyProjectionChange } from "../src/renderer/projection-notifications.ts";

describe("renderer app model", () => {
  it("refreshes visible ledger queries without polling a hidden window", () => {
    const defaults = createRendererQueryClient().getDefaultOptions().queries;

    expect(defaults?.refetchOnWindowFocus).toBe("always");
    expect(defaults?.refetchInterval).toBe(ledgerRefreshInterval);
    expect(defaults?.refetchIntervalInBackground).toBe(false);
    setProjectionPushActive(false);
    expect(ledgerRefreshInterval()).toBe(LEDGER_REFRESH_INTERVAL_MS);
    setProjectionPushActive(true);
    expect(ledgerRefreshInterval()).toBe(false);
    setProjectionPushActive(false);
  });

  it("keeps the renderer capability model privilege-free", () => {
    expect(rendererCapabilityModel).toEqual({
      nodeGlobalsAvailable: false,
      privilegedModulesAvailable: false,
      receivesOnlyPreloadData: true
    });
  });

  it("keeps primary navigation stable for Vite renderer code", () => {
    expect(rendererNavigation.map((item) => item.id)).toEqual([
      "workspace",
      "board",
      "list",
      "detail",
      "doc-viewer",
      "review-queue",
      "graph"
    ]);
  });

  it("builds task shell views from sqlite-task-row/v1 fields only", () => {
    const rows = [
      taskRow({ taskId: "task-child", title: "Child", parentTaskId: "task-parent", coordinationStatus: "blocked" }),
      taskRow({ taskId: "task-parent", title: "Parent", closeoutReadiness: "ready" }),
      taskRow({ taskId: "task-archived", title: "Archived", packageDisposition: "archived" })
    ];

    const model = buildGuiViewModelFromTaskProjection(rows);

    expect(model.list.map((row) => row.taskId)).toEqual(["task-child", "task-parent"]);
    expect(model.board.find((column) => column.id === "blocked")?.taskIds).toEqual(["task-child"]);
    expect(model.reviewQueue.map((row) => row.taskId)).toEqual(["task-parent"]);
    expect(model.graph.nodes).toEqual([
      { id: "task-child", title: "Child" },
      { id: "task-parent", title: "Parent" }
    ]);
    expect(model.graph.edges).toEqual([
      { from: "task-parent", to: "task-child", kind: "child" }
    ]);
  });

  it("reads task route results defensively without depending on optional route fields", () => {
    const list = readGuiTaskListResult({
      ok: true,
      tasks: [
        taskRow({ taskId: "task-1", title: "One" }),
        taskRow({ taskId: "task-archived", title: "Archived", packageDisposition: "archived" })
      ]
    });
    const detail = readGuiTaskDetailResult({
      ok: true,
      task: taskRow({ taskId: "task-1", title: "One" }),
      documents: [{ path: "INDEX.md", kind: "document" }, { label: "ignored" }]
    });
    const document = readGuiTaskDocumentResult({ ok: true, taskId: "task-1", path: "INDEX.md" });
    const invalid = readGuiTaskListResult({ ok: true, tasks: [{ taskId: "task-1", title: "One" }] });

    expect(list).toMatchObject({ ok: true, warnings: [] });
    expect(list.ok && list.rows[0]).toMatchObject({ taskId: "task-1", title: "One" });
    expect(list.ok && list.rows.map((row) => row.taskId)).toEqual(["task-1"]);
    expect(detail.ok && detail.documents).toEqual([{ path: "INDEX.md", kind: "document" }]);
    expect(document).toEqual({ ok: true, taskId: "task-1", path: "INDEX.md", body: "" });
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: "invalid_task_projection_row",
        hint: "Expected sqlite-task-row/v1 task projection row."
      }
    });
  });

  it("normalizes command feedback from lean local results and rich command receipts", () => {
    expect(toGuiCommandFeedback({ ok: true })).toEqual({
      ok: true,
      summary: "Command completed.",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: false,
      error: { code: "task_not_found", hint: "missing" }
    })).toEqual({
      ok: false,
      summary: "Command failed.",
      errorCode: "task_not_found",
      hint: "missing",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: true,
      schema: "command-receipt/v2",
      command: "ha task progress append",
      action: "progress append",
      summary: "appended progress",
      paths: [{ role: "progress", path: "progress.md" }],
      next: [{ command: "ha task show task-1" }],
      meta: {
        generatedAt: "2026-07-07T00:00:00.000Z",
        compatibility: {}
      }
    })).toEqual({
      ok: true,
      summary: "appended progress",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: false,
      schema: "command-receipt/v2",
      command: "ha task status set",
      action: "status set",
      summary: "failed",
      error: { code: "invalid_status", hint: "bad status" },
      warnings: ["ignored by default display"],
      meta: {
        generatedAt: "2026-07-07T00:00:00.000Z",
        compatibility: {}
      }
    })).toEqual({
      ok: false,
      summary: "failed",
      errorCode: "invalid_status",
      hint: "bad status",
      warnings: ["ignored by default display"]
    });
  });

  it("renders an explicit empty state when the triadic ledger has no entities", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { tasks: [], decisions: [], facts: [], relations: [] })
    );

    expect(markup).toContain("triadic-graph-empty-state");
    expect(markup).toContain("No triadic relation data yet");
  });
});

describe("projection notification invalidation", () => {
  it("invalidates the changed entity surfaces for only the notified repo", async () => {
    const client = projectionQueryClient();
    client.setQueryData(["harness", "tasks", "list", "repo-a"], [{ id: "task-a" }]);
    client.setQueryData(["harness", "tasks", "detail", "repo-a", "task-a"], { id: "task-a" });
    client.setQueryData(["harness", "tasks", "detail", "repo-a", "task-b"], { id: "task-b" });
    client.setQueryData(["harness", "tasks", "list", "repo-b"], [{ id: "task-a" }]);
    client.setQueryData(["harness", "triadic", "snapshot", "repo-a"], {});

    applyProjectionChange(client, projectionChange("repo-a", [{ kind: "task", id: "task-a" }]));
    await Promise.resolve();

    expect(queryInvalidated(client, ["harness", "tasks", "list", "repo-a"])).toBe(true);
    expect(queryInvalidated(client, ["harness", "tasks", "detail", "repo-a", "task-a"])).toBe(true);
    expect(queryInvalidated(client, ["harness", "tasks", "detail", "repo-a", "task-b"])).toBe(false);
    expect(queryInvalidated(client, ["harness", "tasks", "list", "repo-b"])).toBe(false);
    expect(queryInvalidated(client, ["harness", "triadic", "snapshot", "repo-a"])).toBe(true);
  });

  it("uses repo-wide invalidation when an event has no entity detail", async () => {
    const client = projectionQueryClient();
    client.setQueryData(["harness", "catalog", "snapshot", "repo-a"], {});
    client.setQueryData(["harness", "tasks", "list", "repo-a"], []);
    client.setQueryData(["harness", "tasks", "list", "repo-b"], []);
    applyProjectionChange(client, projectionChange("repo-a", []));
    await Promise.resolve();
    expect(queryInvalidated(client, ["harness", "catalog", "snapshot", "repo-a"])).toBe(true);
    expect(queryInvalidated(client, ["harness", "tasks", "list", "repo-a"])).toBe(true);
    expect(queryInvalidated(client, ["harness", "tasks", "list", "repo-b"])).toBe(false);
  });
});

function projectionQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
}

function queryInvalidated(client: QueryClient, key: ReadonlyArray<string>): boolean {
  return client.getQueryState(key)?.isInvalidated ?? false;
}

function projectionChange(repoId: string, entities: ReadonlyArray<{ readonly kind: string; readonly id: string }>) {
  return {
    type: "change" as const,
    repoId,
    event: { schema: "projection-change/v1" as const, sourceHash: "sha256:new", entities }
  };
}

function taskRow(overrides: Partial<TaskProjectionRow>): TaskProjectionRow {
  return {
    schema: "sqlite-task-row/v1",
    taskId: "task-default",
    title: "Default",
    canonicalStatus: "planned",
    coordinationStatus: "open",
    rawStatus: "planned",
    packageDisposition: "active",
    closeoutReadiness: "not-ready",
    lifecycleEngine: "local",
    freshness: "fresh",
    updatedAt: "2026-07-07T00:00:00.000Z",
    source: "local-document",
    sourcePath: "harness/tasks/task-default/INDEX.md",
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    ...overrides
  };
}

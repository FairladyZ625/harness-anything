// @vitest-environment jsdom
//
// task_01KX812C0R · appendTaskProgress end-to-end write consume.
//
// The `appendTaskProgress` IPC method (preload/allowlist.ts: shipped) + the
// `useAppendTaskProgressMutation` hook (renderer/task-data.ts) existed but no
// UI entry fired them. This test pins the renderer-side wiring
// (TaskDetailView "Append progress" textarea+button → mutation → bridge) so
// the write verb cannot silently regress to a no-op.
//
// Mutation check: the test must go red if the onClick/onSubmit wiring into
// useAppendTaskProgressMutation is removed. The assertion target is
// `window.harness.appendTaskProgress` (the bridge method), so the test has
// real mutation-detecting power across React Query → api-client → bridge.
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import { ToastProvider } from "../src/renderer/components/MutationToast.tsx";

afterEach(() => {
  cleanup();
  // @ts-expect-index-signature -- delete bridge mocks between tests.
  delete (window as { harness?: unknown }).harness;
});

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchInterval: false },
      mutations: { retry: false },
    },
  });
}

const emptyAttribution = {
  originator: null,
  latestActor: null,
  trailCount: 0,
  completeness: "unresolved" as const,
};

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_progress_target",
    title: "Work in motion",
    projectId: "proj-active",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "software/coding",
    lastKnownAt: "2026-07-01T00:00:00.000Z",
    gates: [],
    docs: [],
    rootTaskId: "task_root",
    rootTitle: "Milestone Root",
    attribution: emptyAttribution,
    ...overrides,
  };
}

function installBridge(overrides: { readonly appendTaskProgress?: (payload: unknown) => unknown } = {}) {
  const calls: { appendTaskProgress: ReadonlyArray<unknown> } = { appendTaskProgress: [] };
  const harness = {
    getTaskDetail: async () => ({
      ok: true,
      task: { schema: "sqlite-task-row/v1", taskId: "task_progress_target", title: "Work in motion" },
      documents: [{ path: "progress.md" }, { path: "review.md" }],
    }),
    getTaskDocument: async () => ({ ok: true, taskId: "task_progress_target", path: "progress.md", body: "" }),
    appendTaskProgress: async (payload: unknown) => {
      calls.appendTaskProgress.push(payload);
      return overrides.appendTaskProgress ? overrides.appendTaskProgress(payload) : { ok: true };
    },
  };
  // @ts-expect-index-signature -- test bridge is intentionally permissive.
  (window as { harness?: unknown }).harness = harness;
  return calls;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("task_01KX812C0R · appendTaskProgress write consume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires window.harness.appendTaskProgress with the typed text when Append is clicked", async () => {
    const calls = installBridge();
    const t = task();

    render(
      createElement(
        QueryClientProvider,
        { client: makeQueryClient() },
        createElement(ToastProvider, null, createElement(TaskDetailView, {
          task: t,
          onBack: () => undefined,
          onUpdate: () => undefined,
          projectName: "Test project",
        })),
      ),
    );

    await flush();

    const input = await screen.findByTestId("task-progress-input");
    const button = await screen.findByTestId("task-progress-submit");

    await act(async () => {
      fireEvent.change(input, { target: { value: "shipped draft v2" } });
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    expect(calls.appendTaskProgress).toHaveLength(1);
    const payload = calls.appendTaskProgress[0] as { readonly taskId: string; readonly text: string };
    expect(payload.taskId).toBe("task_progress_target");
    expect(payload.text).toBe("shipped draft v2");
  });

  it("surfaces an error toast when the daemon rejects the progress append", async () => {
    installBridge({
      appendTaskProgress: () => ({ ok: false, error: { code: "write_rejected", hint: "holder held" } }),
    });
    const t = task();

    render(
      createElement(
        QueryClientProvider,
        { client: makeQueryClient() },
        createElement(ToastProvider, null, createElement(TaskDetailView, {
          task: t,
          onBack: () => undefined,
          onUpdate: () => undefined,
          projectName: "Test project",
        })),
      ),
    );

    await flush();

    const input = await screen.findByTestId("task-progress-input");
    const button = await screen.findByTestId("task-progress-submit");
    await act(async () => {
      fireEvent.change(input, { target: { value: "any" } });
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    await waitFor(() => {
      const toasts = document.querySelectorAll(".ee-toast");
      expect(toasts.length).toBeGreaterThan(0);
    });
  });

  it("does not fire appendTaskProgress when the text is empty (submit guard)", async () => {
    const calls = installBridge();
    const t = task();

    render(
      createElement(
        QueryClientProvider,
        { client: makeQueryClient() },
        createElement(ToastProvider, null, createElement(TaskDetailView, {
          task: t,
          onBack: () => undefined,
          onUpdate: () => undefined,
          projectName: "Test project",
        })),
      ),
    );

    await flush();

    const button = await screen.findByTestId("task-progress-submit");
    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    expect(calls.appendTaskProgress).toHaveLength(0);
  });
});

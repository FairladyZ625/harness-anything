// @vitest-environment jsdom
//
// task_01KX812C0R · reviewTask end-to-end write consume.
//
// The `reviewTask` IPC method (preload/allowlist.ts: shipped) + the
// `useReviewTaskMutation` hook (renderer/task-data.ts) have existed for a long
// time, but no UI entry fired them. This test pins the renderer-side wiring
// (TaskDetailView "Submit review" button → mutation → harness bridge) so the
// write verb cannot silently regress to a no-op.
//
// Mutation check (required by task_plan §Verification): the test must go red
// if the onClick wiring into useReviewTaskMutation is removed. The assertion
// target is `window.harness.reviewTask` (the bridge method the mutation
// settles through), not just a local vi.fn() — so the test has real
// mutation-detecting power across the React Query → api-client → bridge path.
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
    taskId: "task_review_target",
    title: "Reviewable work",
    projectId: "proj-active",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "ready",
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

/**
 * Bridge mock: TaskDetailView always fires getTaskDetail + getTaskDocument on
 * mount. Stub them with valid shapes so the read paths settle and the test
 * can focus on the write verb.
 */
function installBridge(overrides: { readonly reviewTask?: (payload: unknown) => unknown } = {}) {
  const calls: { reviewTask: ReadonlyArray<unknown> } = { reviewTask: [] };
  const harness = {
    getTaskDetail: async () => ({
      ok: true,
      task: { schema: "sqlite-task-row/v1", taskId: "task_review_target", title: "Reviewable work" },
      documents: [{ path: "review.md" }, { path: "progress.md" }],
    }),
    getTaskDocument: async () => ({ ok: true, taskId: "task_review_target", path: "review.md", body: "" }),
    reviewTask: async (payload: unknown) => {
      calls.reviewTask.push(payload);
      return overrides.reviewTask ? overrides.reviewTask(payload) : { ok: true };
    },
  };
  // @ts-expect-index-signature -- test bridge is intentionally permissive.
  (window as { harness?: unknown }).harness = harness;
  return calls;
}

async function flush() {
  // Let TaskDetailView's read queries + the mutation settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("task_01KX812C0R · reviewTask write consume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires window.harness.reviewTask when the Submit review button is clicked", async () => {
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

    const button = await screen.findByTestId("task-review-submit");
    expect(button).toBeTruthy();

    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    // The mutation fires the bridge method with the task id. RepoId is
    // optional (omitted when undefined); we only assert the load-bearing
    // taskId field so the test does not brittle up against repo-scope plumbing.
    expect(calls.reviewTask).toHaveLength(1);
    expect((calls.reviewTask[0] as { readonly taskId: string }).taskId).toBe("task_review_target");
  });

  it("surfaces an error toast when the daemon rejects the review", async () => {
    installBridge({
      reviewTask: () => ({ ok: false, error: { code: "review_schema_invalid", hint: "malformed" } }),
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

    const button = await screen.findByTestId("task-review-submit");
    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    await waitFor(() => {
      // Mutation error toast is rendered with role=status.
      const toasts = document.querySelectorAll(".ee-toast");
      expect(toasts.length).toBeGreaterThan(0);
      expect(toasts[toasts.length - 1]?.textContent ?? "").toMatch(/review/i);
    });
  });
});

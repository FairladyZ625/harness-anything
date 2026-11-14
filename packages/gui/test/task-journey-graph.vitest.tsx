// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskJourney } from "../src/renderer/model/task-journey.ts";
import { TaskJourneyGraph } from "../src/renderer/components/taskDetail/TaskJourneyGraph.tsx";
import { TaskTimelineRegion } from "../src/renderer/components/taskDetail/TaskDetailSections.tsx";
import { runtimeQueryKeys } from "../src/renderer/agent-runtime-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskRow, EventEntry } from "../src/renderer/model/types.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";

const { getTaskDispatches } = vi.hoisted(() => ({ getTaskDispatches: vi.fn() }));
vi.mock("../src/renderer/api-client.ts", async (original) => {
  const actual = await original<typeof import("../src/renderer/api-client.ts")>();
  return { ...actual, harnessClient: { ...actual.harnessClient, getTaskDispatches } };
});
const at = (hour: number) => `2026-11-14T${String(hour).padStart(2, "0")}:00:00.000Z`;
const event = (kind: EventEntry["kind"], hour: number, recordRef?: string): EventEntry => ({
  kind,
  at: at(hour),
  projectId: "repo",
  taskId: "task",
  summary: kind,
  ref: recordRef?.split("/")[1] ?? "",
  ...(recordRef ? { recordRef } : {}),
});
const task = (patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId: "task",
    projectId: "repo",
    title: "Journey",
    createdAt: at(8),
    lastKnownAt: at(16),
    canonicalStatus: "blocked",
    coordinationStatus: "blocked",
    iteration: 1,
    gates: [],
    events: [
      event("start", 9, "execution/e1"),
      event("submit", 10, "execution/e1"),
      event("rejected", 11, "review/r1"),
      event("start", 12, "execution/e2"),
    ],
    blockers: [
      { kind: "depends-on", relationId: "dep", sourceTaskId: "task", targetTaskId: "upstream", rationale: "API ready" },
      {
        kind: "awaits",
        relationId: "ask",
        sourceTaskId: "task",
        personId: "owner",
        askKind: "question",
        question: "Choose storage?",
      },
    ],
    ...patch,
  }) as TaskRow;
const dispatch = (
  id: string,
  hour: number,
  patch: Partial<TaskDispatchProjectionRow> = {},
): TaskDispatchProjectionRow =>
  ({
    dispatchId: `d${id}`,
    executionId: `e${id}`,
    taskId: "task",
    runtimeSessionId: `s${id}`,
    instanceId: "instance",
    agentName: "Sol",
    role: "implementation",
    startedAt: at(hour),
    endedAt: at(hour + 1),
    status: "succeeded",
    attemptIndex: 0,
    ...patch,
  }) as TaskDispatchProjectionRow;
const rows = [dispatch("1", 9), dispatch("2", 12, { status: "running", endedAt: null })];
const mounted: { root: Root; client: QueryClient }[] = [];
async function render(
  element: React.ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, client });
  await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  return container;
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  getTaskDispatches.mockReset();
});
afterEach(async () => {
  for (const { root, client } of mounted.splice(0)) {
    await act(async () => root.unmount());
    client.clear();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("task journey (dec_653AB9E451B58125CA2B5C0289 CH2)", () => {
  it("orders two lanes, preserves both rounds and makes the rejection → R2 loop explicit", () => {
    const graph = buildTaskJourney({ nowMs: Date.parse(at(16)), task: task(), dispatches: [...rows].reverse() });
    const workers = graph.nodes.filter((node) => node.lane === "worker");
    expect(workers.map((node) => node.round)).toEqual([1, 2]);
    expect(workers[0]).toMatchObject({ runtimeSessionId: "s1", durationMs: 3_600_000, recordRefs: ["execution/e1"] });
    expect(workers[1]).toMatchObject({ runtimeSessionId: "s2", durationMs: 14_400_000 });
    const rejected = graph.nodes.find((node) => node.eventKind === "rejected")!;
    expect(graph.edges).toContainEqual({ from: rejected.id, to: workers[1]!.id, reworkLoop: true });
    expect(graph.nodes.filter((node) => node.kind === "gate")).toHaveLength(2);
    expect(graph.nodes[0]!.kind).toBe("creation");
  });

  it("groups execution events once, never guesses record references, and supports an active execution without events", () => {
    const graph = buildTaskJourney({ nowMs: Date.parse(at(16)), task: task(), dispatches: [] });
    expect(graph.nodes.filter((node) => node.lane === "worker").map((node) => node.recordRefs)).toEqual([
      ["execution/e1"],
      ["execution/e2"],
    ]);
    const active = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: task({ events: [], activeExecutionId: "active", blockers: [] }),
      dispatches: [],
    });
    expect(active.nodes.find((node) => node.lane === "worker")?.recordRefs).toEqual(["execution/active"]);
    const plain = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: task({ events: [{ ...event("start", 9), ref: "execution/fake" }], blockers: [] }),
      dispatches: [],
    });
    expect(plain.nodes.find((node) => node.lane === "worker")?.recordRefs).toEqual([]);
  });

  it("keeps reviewer dispatches on the control lane and appends waiting gates and terminal state from the cut", () => {
    const graph = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: task({
        blockers: [],
        coordinationStatus: "submitted",
        closeoutBlocker: "review_pending",
        gates: [{ name: "CI", ok: false, status: "failed" }],
      }),
      dispatches: [...rows, dispatch("review", 14, { role: "reviewer" })],
    });
    expect(graph.nodes.filter((node) => node.lane === "worker")).toHaveLength(2);
    expect(graph.nodes.find((node) => node.runtimeSessionId === "sreview")?.lane).toBe("control");
    expect(graph.nodes.filter((node) => node.kind === "gate")).toHaveLength(2);
    const done = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: task({ canonicalStatus: "done", coordinationStatus: "done", blockers: [] }),
      dispatches: [],
    });
    expect(done.nodes.at(-1)?.kind).toBe("terminal");
  });

  it("selects native buttons, shows execution details, and routes sessions/closeout records", async () => {
    const onOpenSession = vi.fn(),
      onOpenRecord = vi.fn(),
      onNavigateEntity = vi.fn();
    const container = await render(
      <TaskJourneyGraph
        journey={buildTaskJourney({ nowMs: Date.parse(at(16)), task: task(), dispatches: rows })}
        onOpenSession={onOpenSession}
        onOpenRecord={onOpenRecord}
        onNavigateEntity={onNavigateEntity}
      />,
    );
    const worker = container.querySelector<HTMLButtonElement>('[data-journey-round="1"]')!;
    expect(worker.tagName).toBe("BUTTON");
    await act(async () => worker.click());
    expect(worker.getAttribute("aria-pressed")).toBe("true");
    const inspector = container.querySelector('[data-testid="task-journey-inspector"]')!;
    expect(inspector.textContent).toContain("Sol");
    await act(async () => inspector.querySelector<HTMLButtonElement>('[title="session/s1"]')!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("session/s1");
    const byText = (text: string) =>
      [...inspector.querySelectorAll("button")].find((node) => node.textContent === text)!;
    await act(async () => byText("打开会话").click());
    expect(onOpenSession).toHaveBeenCalledWith("s1");
    await act(async () => byText("打开记录 · execution/e1").click());
    expect(onOpenRecord).toHaveBeenCalledWith("execution/e1");
    const rejection = container.querySelector<HTMLButtonElement>('[data-journey-kind="review"]')!;
    await act(async () => rejection.click());
    await act(async () => byText("打开记录 · review/r1").click());
    expect(onOpenRecord).toHaveBeenCalledWith("review/r1");
  });

  it("renders immediately during dispatch loading, reuses the dispatch cache, and folds audit records", async () => {
    getTaskDispatches.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await render(<TaskTimelineRegion task={task()} />, client);
    expect(container.querySelectorAll("[data-journey-round]")).toHaveLength(2);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("4");
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(getTaskDispatches).toHaveBeenCalledTimes(1);
    await act(async () => client.setQueryData(runtimeQueryKeys.dispatches("repo", "task"), { dispatches: rows }));
    await vi.waitFor(() => expect(container.querySelector('[data-journey-round="1"]')?.textContent).toContain("Sol"));
    expect(getTaskDispatches).toHaveBeenCalledTimes(1);
  });

  it("retains the event graph when the dispatch read fails and handles blockers without events", async () => {
    getTaskDispatches.mockRejectedValue(new Error("dispatch offline"));
    const container = await render(<TaskTimelineRegion task={task({ events: [] })} />);
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("dispatch offline"),
    );
    expect(container.querySelectorAll('[data-journey-kind="gate"]')).toHaveLength(2);
  });
});

// review-dispatch_cdc6e2d05b9e7c861d65a1ba F1–F3: read the actual cut and observation clock.
describe("task journey review regressions", () => {
  it.each(["review_pending", "review_rejected", "consent", "projection_unknown", "execution", "lineage"] as const)(
    "uses the authoritative %s closeout blocker",
    (closeoutBlocker) => {
      const graph = buildTaskJourney({
        nowMs: Date.parse(at(16)),
        task: task({
          events: [],
          blockers: [],
          canonicalStatus: "in_review",
          coordinationStatus: "in_review",
          closeoutBlocker,
        }),
        dispatches: [],
      });
      expect(graph.nodes.at(-1)).toMatchObject({ kind: "gate", closeoutBlocker });
      expect(graph.nodes.filter((node) => node.id === "waiting-review")).toEqual([]);
    },
  );

  it("does not invent a review gate for an exempt submitted cut, and retains the named failed gate", () => {
    const exempt = task({
      events: [],
      blockers: [],
      canonicalStatus: "submitted",
      coordinationStatus: "submitted",
      closeoutBlocker: undefined,
    });
    expect(
      buildTaskJourney({ nowMs: Date.parse(at(16)), task: exempt, dispatches: [] }).nodes.filter(
        (node) => node.kind === "gate",
      ),
    ).toEqual([]);
    const gated = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: { ...exempt, closeoutBlocker: "gate", gates: [{ name: "CI", ok: false, status: "failed" }] },
      dispatches: [],
    });
    expect(gated.nodes.filter((node) => node.kind === "gate")).toHaveLength(1);
    expect(gated.nodes.at(-1)).toMatchObject({ id: "gate:CI", summary: "CI", activity: "failed" });
  });

  it("selects consent in the default inspector after approval, without claiming review is pending", async () => {
    const container = await render(
      <TaskJourneyGraph
        journey={buildTaskJourney({
          nowMs: Date.parse(at(16)),
          task: task({
            events: [event("approved", 13, "review/r1")],
            blockers: [],
            canonicalStatus: "in_review",
            coordinationStatus: "in_review",
            closeoutBlocker: "consent",
          }),
          dispatches: [],
        })}
      />,
    );
    const inspector = container.querySelector('[data-testid="task-journey-inspector"]')!;
    expect(inspector.textContent).toContain("待同意");
    expect(inspector.textContent).not.toContain("待裁决");
    expect(inspector.textContent).not.toContain("等待评审");
  });

  it.each([false, true])("shows abandoned fallback execution as terminal, submitted=%s", (submitted) => {
    const graph = buildTaskJourney({
      nowMs: Date.parse(at(16)),
      task: task({
        events: [
          event("start", 9, "execution/old"),
          ...(submitted ? [event("submit", 10, "execution/old")] : []),
          event("abandoned", 11, "execution/old"),
        ],
        blockers: [],
      }),
      dispatches: [],
    });
    expect(graph.nodes.filter((node) => node.lane === "worker")).toMatchObject([
      { activity: "cancelled", recordRefs: ["execution/old"] },
    ]);
  });

  it("refreshes running duration from observation time even when task and dispatch objects are unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(at(16));
    const live = dispatch("live", 15, { startedAt: "2026-11-14T15:59:50.000Z", endedAt: null, status: "running" });
    const cached = { dispatches: [live] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = runtimeQueryKeys.dispatches("repo", "task");
    client.setQueryData(key, cached);
    getTaskDispatches.mockResolvedValue({
      ok: true,
      status: "ready",
      taskIds: ["task"],
      unavailableTaskIds: [],
      dispatches: cached.dispatches,
      outcome: "succeeded",
      exitCode: 0,
      page: { cursor: null, nextCursor: null, limit: 16 },
      watermark: 1,
      sourceRevision: 1,
    });
    const staleTask = task({
      events: [],
      blockers: [],
      canonicalStatus: "active",
      coordinationStatus: "active",
      lastKnownAt: at(8),
    });
    const container = await render(<TaskTimelineRegion task={staleTask} />, client);
    const inspector = () => container.querySelector('[data-testid="task-journey-inspector"]')!.textContent;
    expect(inspector()).toContain("10s");
    expect(getTaskDispatches).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_001);
    });
    expect(inspector()).toContain("14s");
    expect(getTaskDispatches).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe(cached);
    expect(staleTask.lastKnownAt).toBe(at(8));
  });
});

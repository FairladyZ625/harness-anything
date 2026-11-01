// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harnessClient } from "../src/renderer/api-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { LiveFloorView } from "../src/renderer/views/LiveFloorView.tsx";
import { NO_WORKS } from "../src/renderer/model/work-collections.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { FIXTURE_RUNTIME_OVERVIEW, fixtureTaskRow } from "./entityIdGateFixtures.ts";

vi.mock("../src/renderer/agenda-data.ts", () => ({
  useAgendaQuery: () => ({ data: undefined, isPending: false, error: null }),
}));

const FRAME_LIMIT = 98_304;
const task = (): TaskRow =>
  ({
    ...fixtureTaskRow("task-one", "Paging task"),
    projectId: "repo-one",
    canonicalStatus: "planned",
    deliveryStage: "queued",
    lastKnownAt: new Date().toISOString(),
    events: [],
    reviews: [{ executionId: "execution-review", verdict: "changes_requested" }],
  }) as unknown as TaskRow;
const dispatches = (): TaskDispatchProjectionRow[] =>
  Array.from({ length: 500 }, (_, index) => ({
    dispatchId: `dispatch-${index}`,
    runtimeSessionId: `runtime-${index}`,
    taskId: "task-one",
    taskTitle: index === 499 ? "Last-page review" : "Older round",
    executionId: "execution-review",
    instanceId: "instance-one",
    attemptGroupId: `attempt-${index}`,
    attemptIndex: 0,
    provider: { instance: "instance-one", model: "test-model" },
    role: "reviewer",
    classification: null,
    reason: "Long reason and /path/to/dispatch/".repeat(20),
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: new Date(Date.now() - 72 * 3600_000 + index * 1000).toISOString(),
    endedAt: new Date(Date.now() - (index === 499 ? 3600_000 : 48 * 3600_000)).toISOString(),
    outcome: "succeeded",
    status: "succeeded",
  }));
const page = (rows: readonly TaskDispatchProjectionRow[], cursor: string | null, nextCursor: string | null) => ({
  ok: true as const,
  status: "ready" as const,
  taskIds: ["task-one"],
  unavailableTaskIds: [],
  dispatches: rows,
  outcome: "succeeded" as const,
  exitCode: 0,
  watermark: 1,
  sourceRevision: 1,
  page: { limit: 16, cursor, nextCursor },
});
let root: Root | undefined;
let client: QueryClient | undefined;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
  localStorage.clear();
  vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue({ ...FIXTURE_RUNTIME_OVERVIEW, sessions: [] });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  client?.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: client! },
        createElement(LiveFloorView, {
          repoId: "repo-one",
          tasks: [task()],
          works: NO_WORKS,
          onOpenTask: vi.fn(),
          onNavigateEntity: vi.fn(),
        }),
      ),
    ),
  );
  return container;
}

it("Live floor drains bounded dispatch pages and retains the recent reviewer on the last page", async () => {
  const rows = dispatches();
  expect(Buffer.byteLength(JSON.stringify(page(rows, null, null)))).toBeGreaterThan(FRAME_LIMIT);
  const read = vi.spyOn(harnessClient, "getTaskDispatches").mockImplementation(async (payload) => {
    if (payload.limit === undefined || payload.limit > 16)
      throw new Error(`invalid_frame: Fleet frame exceeds ${FRAME_LIMIT} bytes`);
    const start = Number(payload.cursor ?? 0),
      end = Math.min(start + payload.limit, rows.length);
    const result = page(rows.slice(start, end), payload.cursor ?? null, end < rows.length ? String(end) : null);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(FRAME_LIMIT);
    return result;
  });
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="live-floor-ended"]')?.textContent).toContain("Last-page review"),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-testid="live-floor-ended"]')?.textContent).toContain("Rejected in review");
  expect(container.querySelectorAll('[data-testid="live-floor-ended-row"]')).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(Math.ceil(rows.length / 16));
});

it("Live floor keeps a failed dispatch read visible", async () => {
  vi.spyOn(harnessClient, "getTaskDispatches").mockRejectedValue(
    new Error("fleet_read_too_large: use limit=16 and cursor"),
  );
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("use limit=16 and cursor"),
  );
});

it("the task timeline shows a read error instead of an empty dispatch history", async () => {
  vi.spyOn(harnessClient, "getTaskDispatches")
    .mockResolvedValueOnce(page([], null, null))
    .mockRejectedValue(new Error("Center unavailable for timeline"));
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="live-floor-stage-queued"] button')).not.toBeNull(),
  );
  await act(async () =>
    (container.querySelector('[data-testid="live-floor-stage-queued"] button') as HTMLButtonElement).click(),
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="live-floor-task-drawer"] [role="alert"]')?.textContent).toContain(
      "Center unavailable for timeline",
    ),
  );
});

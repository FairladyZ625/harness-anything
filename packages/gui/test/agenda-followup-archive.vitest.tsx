// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harnessClient, type AgendaSuccess, type TaskListSuccess } from "../src/renderer/api-client.ts";
import type { GuiActionResult, TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { taskQueryKeys } from "../src/renderer/task-data.ts";
import { taskReworkClient } from "../src/renderer/task-rework-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { AgendaView } from "../src/renderer/views/AgendaView.tsx";

// The selection, projection adapter, quiet queue and both Outbox actions remain real.
vi.mock("../src/renderer/views/agenda/AgendaEntityFocus.tsx", () => ({ AgendaEntityFocus: () => null }));
const AT = "2026-11-15T00:00:00.000Z";
const agenda: AgendaSuccess = {
  ok: true,
  status: "ready",
  inFlight: [],
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  attentionItems: [],
  regionWeights: { ci: 0, mine: 0, stuck: 0, run: 0, review: 0, queue: 0, recent: 0, works: 0 },
  awaitingRestart: [],
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  awaitingYou: [],
  answeredForYou: [],
  decisionReviewInProgress: [],
  awaitingDecisionReview: [],
  awaitingDecision: [],
  waitingOnOthers: [],
  dispatchable: [],
  summary: "",
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 1,
  sourceRevision: 1,
};
function projection(taskId: string, status: "done" | "in_review"): TaskSnapshotProjectionRow {
  return {
    taskId,
    workspaceRevision: 1,
    createdAt: AT,
    updatedAt: AT,
    completedAt: status === "done" ? AT : null,
    snapshot: {
      revision: 1,
      task: {
        schema: "task/v2",
        taskId,
        title: `Delivery ${taskId}`,
        taskClass: "standard",
        status,
        graph: { nodes: [{ id: "implementation", kind: "implementation" }], edges: [] },
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person_owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
      executions: [],
      reviews: [],
      consents: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: null,
    },
    packagePath: `tasks/${taskId}`,
    coordinationStatus: status,
    snapshotAvailability: { consents: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "ready", gates: [] },
    blockingAssessment: { taskId, state: "clear", label: "none", blockers: [], warnings: [] },
    placement: {
      productLines: [],
      spawningDecisionIds: [],
      parentTaskId: null,
      origin: "native",
      engine: "kernel/task-lifecycle/v1",
      packageDisposition: "active",
      provenance: [],
    },
    executionEvidence: [],
    board: { columnId: "review", rank: 1 },
    visibility: { archived: false, noise: false },
    capabilities: [],
    risk: { flagged: false },
    phase: { index: 0, reason: null, steps: ["planned", "active", "in_review", "done"] },
  } as TaskSnapshotProjectionRow;
}
const applied = (extra: object = {}): GuiActionResult => ({
  schema: "command-receipt/v2",
  command: "task-archive",
  ok: true,
  outcome: "applied",
  opId: "op-archive",
  proof: { durable: true, canonicalVisible: true, committedRevision: 5, appliedCut: 5 },
  ...extra,
});
let host: HTMLDivElement;
let root: Root;
let cache: QueryClient;
let rows: TaskSnapshotProjectionRow[];
const read = (): TaskListSuccess => ({
  ok: true,
  status: "ready",
  rows,
  invalidRows: [],
  warnings: [],
  watermark: 1,
  sourceRevision: 1,
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  notifyManager.setNotifyFunction((notify) => act(notify));
  setActiveLocale("zh-CN");
  vi.useFakeTimers({ now: new Date(AT), toFake: ["Date"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rows = [
    projection("a_earlier", "in_review"),
    projection("b_done", "done"),
    projection("c_next", "in_review"),
    projection("d_sibling", "done"),
    projection("z_received", "done"),
  ];
  rows[4].placement = { ...rows[4].placement, packageDisposition: "archived" };
  cache.setQueryData(taskQueryKeys.list("repo"), read());
  vi.spyOn(harnessClient, "getTasks").mockImplementation(async () => read());
  vi.spyOn(harnessClient, "getWorkIndex").mockResolvedValue({
    ok: true,
    status: "ready",
    works: [{ taskId: "work", title: "Work", memberTaskIds: ["b_done", "d_sibling"] }],
    watermark: 1,
    sourceRevision: 1,
  });
  vi.spyOn(harnessClient, "getTaskDeliveryDiff").mockImplementation(async ({ taskId }) => ({
    ok: true,
    status: "ready",
    taskId,
    baseline: "base",
    commitSha: "head",
    files: [],
    truncated: false,
    watermark: 1,
    sourceRevision: 1,
  }));
  vi.spyOn(harnessClient, "getTaskDocuments").mockImplementation(async ({ taskId }) => ({
    ok: true,
    status: "ready",
    taskId,
    documents: [],
    watermark: 1,
    sourceRevision: 1,
  }));
  vi.spyOn(taskReworkClient, "read").mockResolvedValue({ reworkTargets: [] } as never);
  vi.spyOn(harnessClient, "getCatalogSnapshot").mockResolvedValue({
    defaults: { presetId: "standard", verticalId: "software", locale: "zh-CN" },
  } as never);
  vi.spyOn(harnessClient, "getCatalogPreset").mockResolvedValue({
    resolved: { documents: [{ slot: "task.plan", body: "## Brief" }] },
  } as never);
  vi.spyOn(harnessClient, "createTask").mockResolvedValue(applied({ taskId: "followup" }));
});
afterEach(() => {
  act(() => root.unmount());
  cache.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  notifyManager.setNotifyFunction((notify) => notify());
});
const get = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const selected = () => get("agenda-current-card").getAttribute("data-item-id");
const wait = async (assertion: () => void) =>
  vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    assertion();
  });
const click = (id: string) => act(() => get(id).click());
async function createFollowup(quietOpen = false) {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(AgendaView, {
          repoId: "repo",
          agenda,
          agendaError: null,
          onNavigateEntity: vi.fn(),
        }),
      ),
    ),
  );
  const filter = [...get("agenda-filter-chips").querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("出件验收"),
  )!;
  act(() => filter.click());
  await wait(() => expect(get("agenda-row-b_done")).not.toBeNull());
  act(() => get("agenda-row-b_done").querySelector<HTMLButtonElement>("button")!.click());
  if (quietOpen)
    act(() => {
      const drawer = get("agenda-quiet-fyi") as HTMLDetailsElement;
      drawer.open = true;
      drawer.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
  const input = get("agenda-followup-title") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "Check deployment");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(() => expect(get("agenda-followup").hasAttribute("disabled")).toBe(false));
  click("agenda-followup");
  await wait(() => expect(harnessClient.createTask).toHaveBeenCalledOnce());
  await wait(() => expect(host.querySelector('[title="task/followup"]'), host.textContent ?? "").not.toBeNull());
  await wait(() => expect((get("agenda-archive") as HTMLButtonElement).disabled).toBe(false));
  expect(selected()).toBe("b_done");
  expect(harnessClient.createTask).toHaveBeenCalledWith(expect.objectContaining({ parentTaskId: "work" }));
}

// F-ARCHIVE-RETAIN: exercise the sequence, not just an archive on an untouched card.
it.each([
  { batch: false, quietOpen: false, moveAway: false },
  { batch: true, quietOpen: false, moveAway: false },
  { batch: false, quietOpen: true, moveAway: false },
  { batch: true, quietOpen: true, moveAway: false },
  { batch: false, quietOpen: false, moveAway: true },
])(
  "releases a followed-up card after archive, batch=$batch quietOpen=$quietOpen moveAway=$moveAway",
  async ({ batch, quietOpen, moveAway }) => {
    let finish!: (value: GuiActionResult) => void;
    const archive = vi.spyOn(harnessClient, "archiveTasks").mockImplementation(async ({ taskIds }) => {
      const answer = await new Promise<GuiActionResult>((resolve) => {
        finish = resolve;
      });
      rows = rows.map((row) =>
        taskIds.includes(row.taskId)
          ? { ...row, placement: { ...row.placement, packageDisposition: "archived" } }
          : row,
      );
      return answer;
    });
    await createFollowup(quietOpen);
    click(batch ? "agenda-archive-work" : "agenda-archive");
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: batch ? ["b_done", "d_sibling"] : ["b_done"] }),
    );
    expect(selected()).toBe("b_done");
    if (moveAway) act(() => get("agenda-row-a_earlier").querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => {
      finish(applied());
      await vi.waitFor(() =>
        expect(
          cache.getQueryData<TaskListSuccess>(taskQueryKeys.list("repo"))!.rows.find((r) => r.taskId === "b_done")!
            .placement.packageDisposition,
        ).toBe("archived"),
      );
    });
    expect(selected()).toBe(moveAway ? "a_earlier" : "c_next");
    expect(get("agenda-current-card").textContent).not.toContain("Delivery b_done");
    expect(get("agenda-archive")).toBeNull();
    expect(get("agenda-followup")).toBeNull();
    expect(get("agenda-progress").textContent).toBe(`${moveAway ? 1 : 2} / ${quietOpen ? 5 : batch ? 2 : 3}`);
    expect(get("agenda-quiet-fyi").textContent).toContain("Delivery b_done");
  },
);

it.each(["pending", "op_rejected"] as const)(
  "keeps the follow-up card for an unapplied %s receipt",
  async (outcome) => {
    vi.spyOn(harnessClient, "archiveTasks").mockResolvedValue(
      applied({
        outcome,
        proof: undefined,
        ok: outcome !== "op_rejected",
        nextAction: "Inspect acceptance",
      }),
    );
    await createFollowup();
    click("agenda-archive");
    await wait(() => expect(get("agenda-outbox-actions").textContent).toContain("Inspect acceptance"));
    expect(selected()).toBe("b_done");
    expect(host.querySelector('[title="task/followup"]')).not.toBeNull();
    expect(get("agenda-archive")).not.toBeNull();
  },
);

it.each([false, true])("drops an archived snapshot from another window, quietOpen=%s", async (quietOpen) => {
  const archive = vi.spyOn(harnessClient, "archiveTasks");
  await createFollowup(quietOpen);
  await act(async () => {
    rows = rows.map((row) =>
      row.taskId === "b_done" ? { ...row, placement: { ...row.placement, packageDisposition: "archived" } } : row,
    );
    await cache.invalidateQueries({ queryKey: taskQueryKeys.all("repo") });
  });
  await wait(() => expect(get("agenda-quiet-fyi").textContent).toContain("Delivery b_done"));
  expect(selected()).toBe("a_earlier");
  expect(get("agenda-archive")).toBeNull();
  expect(get("agenda-followup")).toBeNull();
  expect(get("agenda-progress").textContent).toBe(`1 / ${quietOpen ? 5 : 3}`);
  expect(get("agenda-quiet-fyi").textContent).toContain("Delivery b_done");
  expect(archive).not.toHaveBeenCalled();
  if (quietOpen) {
    act(() =>
      get("agenda-quiet-fyi").querySelector<HTMLButtonElement>('[data-testid="agenda-row-b_done"] button')!.click(),
    );
    expect(selected()).toBe("b_done");
    expect(get("agenda-archive")).toBeNull();
  }
});

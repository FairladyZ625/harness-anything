// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessClient, type AgendaSuccess, type TaskListSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { AgendaView } from "../src/renderer/views/AgendaView.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { agendaQueryKeys } from "../src/renderer/agenda-data.ts";
import { taskQueryKeys, TASK_EXPLAINER_DOC } from "../src/renderer/task-data.ts";

// dec_653AB9E451B58125CA2B5C0289/CH1: the existing route becomes the workbench.
// Keep the real read hooks, Explainer and answer mutation; isolate only graph drawing.
vi.mock("../src/renderer/views/workspace/WorkGraphTab.tsx", () => ({
  WorkGraphTab: (props: { workRootTaskId: string; active: boolean; tasks: readonly unknown[] }) =>
    createElement("div", {
      "data-testid": "work-graph-wiring",
      "data-work-root": props.workRootTaskId,
      "data-active": String(props.active),
      "data-task-count": props.tasks.length,
    }),
}));

const AT = "2026-11-14T01:00:00.000Z";
const NOW = new Date("2026-11-15T01:00:00.000Z");
const ask = (relationId: string, patch: Partial<AgendaAwaitsRow> = {}): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 4,
  sourceRef: "task/task_question",
  title: `Question ${relationId}`,
  status: "active",
  personId: "person_owner",
  askKind: "question",
  question: "Use the existing API?",
  askedAt: AT,
  askedBy: "person_worker",
  ...patch,
});
const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
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
  ...patch,
});

function projection(
  taskId: string,
  status: TaskSnapshotProjectionRow["coordinationStatus"] = "submitted",
  completedAt: string | null = null,
): TaskSnapshotProjectionRow {
  return {
    taskId,
    workspaceRevision: 1,
    createdAt: AT,
    updatedAt: AT,
    completedAt,
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
    closeoutAssessment: {
      readiness: "ready",
      gates: [
        { gateId: "tests", ok: true, status: "passed" },
        { gateId: "review", ok: null, status: "missing" },
      ],
    },
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

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const navigate = vi.fn();
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  navigate.mockClear();
  vi.spyOn(harnessClient, "getTasks").mockResolvedValue({
    ok: true,
    status: "ready",
    rows: [],
    invalidRows: [],
    warnings: [],
    watermark: 1,
    sourceRevision: 1,
  } as TaskListSuccess);
  vi.spyOn(harnessClient, "getWorkIndex").mockResolvedValue({
    ok: true,
    status: "ready",
    works: [],
    watermark: 1,
    sourceRevision: 1,
  });
  vi.spyOn(harnessClient, "getTaskDispatches").mockResolvedValue({
    ok: true,
    status: "ready",
    taskIds: [],
    unavailableTaskIds: [],
    dispatches: [],
    outcome: "not_started",
    exitCode: 0,
    page: { cursor: null, nextCursor: null, limit: 500 },
    watermark: 1,
    sourceRevision: 1,
  });
  vi.spyOn(harnessClient, "getTaskDeliveryDiff").mockImplementation(async ({ taskId }) => ({
    ok: true,
    status: "ready",
    taskId,
    baseline: "base",
    commitSha: "head",
    truncated: false,
    files: [
      {
        filePath: "src/fix.ts",
        lines: [
          { kind: "add", text: "new one", newLineNo: 1 },
          { kind: "add", text: "new two", newLineNo: 2 },
          { kind: "remove", text: "old", oldLineNo: 1 },
        ],
      },
    ],
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
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function render(read: AgendaSuccess | undefined = agenda(), repoId = "repo") {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgendaView, {
          repoId,
          agenda: read,
          agendaError: null,
          onNavigateEntity: navigate,
        }),
      ),
    ),
  );
}
function seedTasks(rows: TaskSnapshotProjectionRow[]) {
  client.setQueryData(taskQueryKeys.list("repo"), {
    ok: true,
    status: "ready",
    rows,
    invalidRows: [],
    warnings: [],
    watermark: 1,
    sourceRevision: 1,
  } satisfies TaskListSuccess);
}
const find = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
};
const click = (id: string) => act(() => find<HTMLButtonElement>(id).click());
function chip(text: string) {
  const el = [...find("agenda-filter-chips").querySelectorAll("button")].find((b) => b.textContent?.startsWith(text));
  if (!el) throw new Error(`missing filter ${text}`);
  act(() => el.click());
}
const selected = () => find("agenda-current-card").getAttribute("data-item-id");
function key(key: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
}
function input(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const settle = async (assertion: () => void) =>
  act(async () => {
    await vi.waitFor(assertion);
  });

describe("Agenda unified Inbox / Outbox workbench", () => {
  it("renders daemon scores and every structured reason on both row and selected card", () => {
    render(
      agenda({
        awaitingYou: [ask("first"), ask("priority")],
        attentionItems: [
          {
            ref: "relation/priority",
            title: "Priority",
            kind: "awaiting-you",
            region: "mine",
            workTaskId: null,
            attention: {
              score: 143,
              reasons: [
                { label: "高风险", contribution: 60 },
                { label: "阻塞下游 3 项", contribution: 83 },
              ],
            },
          },
        ],
      }),
    );
    expect(selected()).toBe("priority");
    for (const el of [find("agenda-row-priority"), find("agenda-current-card")]) {
      expect(el.textContent).toContain("143");
      expect(el.textContent).toContain("高风险");
      expect(el.textContent).toContain("阻塞下游 3 项");
      expect(el.querySelector('[data-contribution="83"]')).not.toBeNull();
    }
    expect(find("agenda-layout-mode").textContent).toContain("主从分栏");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(harnessClient.getTaskDeliveryDiff).not.toHaveBeenCalled();
    expect(harnessClient.getTaskDocuments).not.toHaveBeenCalled();
  });

  it("switches split/deck, preserves selection, and supports bounded J/K navigation in both modes", () => {
    render(agenda({ awaitingYou: [ask("a"), ask("b"), ask("c")] }));
    expect(selected()).toBe("a");
    key("k");
    expect(selected()).toBe("a");
    key("j");
    expect(selected()).toBe("b");
    click("agenda-mode-focus");
    expect(host.querySelector('[data-testid="agenda-queue"]')).toBeNull();
    expect(selected()).toBe("b");
    expect(find("agenda-progress").textContent).toBe("2 / 3");
    key("J");
    expect(selected()).toBe("c");
    key("j");
    expect(selected()).toBe("c");
    click("agenda-previous");
    expect(selected()).toBe("b");
    click("agenda-next");
    expect(selected()).toBe("c");
    key("k");
    expect(selected()).toBe("b");
    click("agenda-mode-split");
    expect(find("agenda-queue")).toBeTruthy();
    expect(find("agenda-row-b").querySelector('[data-selected="true"]')).not.toBeNull();
  });

  it("does not hijack search, textarea, select, editable descendants, modified or consumed keys", () => {
    render(agenda({ awaitingYou: [ask("a"), ask("b")] }));
    const search = find<HTMLInputElement>("agenda-search");
    act(() => search.focus());
    key("j", search);
    key("k", search);
    expect(selected()).toBe("a");
    input(search, "j");
    expect(search.value).toBe("j");
    input(search, "");
    const reply = find<HTMLTextAreaElement>("agenda-answer-comment");
    key("j", reply);
    expect(selected()).toBe("a");
    for (const tag of ["select", "input", "textarea"]) {
      const control = document.createElement(tag);
      host.append(control);
      key("j", control);
      control.remove();
      expect(selected()).toBe("a");
    }
    const editable = document.createElement("div"),
      nested = document.createElement("span");
    editable.setAttribute("contenteditable", "true");
    editable.append(nested);
    host.append(editable);
    key("j", nested);
    expect(selected()).toBe("a");
    key("j", window, { ctrlKey: true });
    key("j", window, { altKey: true });
    key("j", window, { metaKey: true });
    const consumed = new KeyboardEvent("keydown", { key: "j", cancelable: true });
    consumed.preventDefault();
    act(() => window.dispatchEvent(consumed));
    expect(selected()).toBe("a");
    key("j");
    expect(selected()).toBe("b");
  });

  it("submits a custom awaits reply with the shared version contract and invalidates agenda", async () => {
    const retire = vi.spyOn(harnessClient, "retireRelation").mockResolvedValue({
      ok: true,
      opId: "op-answer",
      outcome: "applied",
      proof: { durable: true, canonicalVisible: true, committedRevision: 5, appliedCut: 5 },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(agenda({ awaitingYou: [ask("answer")] }));
    expect(find<HTMLButtonElement>("agenda-answer-submit").disabled).toBe(true);
    input(find<HTMLTextAreaElement>("agenda-answer-comment"), "  Keep the API  ");
    click("agenda-answer-submit");
    await settle(() =>
      expect(retire).toHaveBeenCalledExactlyOnceWith({
        repoId: "repo",
        relationId: "answer",
        expectedVersion: 4,
        reason: "Keep the API",
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agendaQueryKeys.read("repo") });
    await settle(() => expect(find("agenda-answer-feedback").getAttribute("data-state")).toBe("success"));
  });

  it("prefills consent choices without silently submitting, exposes rejection feedback, and resets per item", async () => {
    const retire = vi.spyOn(harnessClient, "retireRelation").mockRejectedValue(new Error("answer refused"));
    render(agenda({ awaitingYou: [ask("a", { askKind: "consent" }), ask("b", { askKind: "consent" })] }));
    click("agenda-answer-choice-agree");
    expect(retire).not.toHaveBeenCalled();
    expect(find<HTMLButtonElement>("agenda-answer-submit").disabled).toBe(false);
    click("agenda-answer-submit");
    await settle(() => expect(find("agenda-answer-feedback").textContent).toContain("answer refused"));
    expect(find("agenda-answer-feedback").getAttribute("data-state")).toBe("error");
    key("j");
    expect(selected()).toBe("b");
    expect(find<HTMLButtonElement>("agenda-answer-submit").disabled).toBe(true);
  });

  it("loads exactly one delivery/document pair for twenty Outbox tasks and renders actual Explainer", async () => {
    seedTasks(Array.from({ length: 20 }, (_, n) => projection(`task_${n}`)));
    vi.mocked(harnessClient.getTaskDocuments).mockImplementation(async ({ taskId }) => ({
      ok: true,
      status: "ready",
      taskId,
      documents: [
        { path: TASK_EXPLAINER_DOC, blobSha256: "blob", size: 30, mediaType: "text/html", uncommitted: false },
      ],
      watermark: 1,
      sourceRevision: 1,
    }));
    vi.spyOn(harnessClient, "getTaskDocument").mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "task_0",
      path: TASK_EXPLAINER_DOC,
      body: "<h1>Review this delivery</h1>",
      uncommitted: false,
      worktreeBody: null,
      contentKind: "text",
      watermark: 1,
      sourceRevision: 1,
    });
    render();
    expect(harnessClient.getTaskDeliveryDiff).not.toHaveBeenCalled();
    chip("出件验收");
    await settle(() =>
      expect(find("work-explainer-document").querySelector('[data-testid="html-artifact-webview"]')).not.toBeNull(),
    );
    expect(harnessClient.getTaskDeliveryDiff).toHaveBeenCalledExactlyOnceWith({ repoId: "repo", taskId: "task_0" });
    expect(harnessClient.getTaskDocuments).toHaveBeenCalledExactlyOnceWith({ repoId: "repo", taskId: "task_0" });
    expect(find("agenda-delivery-summary").textContent).toContain("1");
    expect(find("agenda-delivery-summary").textContent).toContain("+2");
    expect(find("agenda-delivery-summary").textContent).toContain("−1");
    expect(find("agenda-gate-summary").textContent).toContain("1 / 2");
    click("agenda-tab-files");
    expect(find("agenda-delivery-files").textContent).toContain("src/fix.ts");
    click("agenda-tab-gates");
    expect(find("agenda-delivery-gates").textContent).toContain("review");
    expect(find("agenda-delivery-gates").textContent).toContain("missing");
    click("agenda-card-open");
    expect(navigate).toHaveBeenCalledWith("taskreview/task_0");
    const next = find("agenda-row-task_1").querySelector<HTMLButtonElement>("button")!;
    act(() => next.click());
    await settle(() => expect(harnessClient.getTaskDeliveryDiff).toHaveBeenCalledTimes(2));
    expect(harnessClient.getTaskDocuments).toHaveBeenCalledTimes(2);
  });

  it("adds submitted/in_review and recently completed deliveries, excluding old or undated done and archives", () => {
    const archived = {
      ...projection("archived"),
      placement: { ...projection("archived").placement, packageDisposition: "archived" as const },
    };
    seedTasks([
      projection("submitted"),
      projection("review", "in_review"),
      projection("recent", "done", AT),
      projection("old", "done", "2026-10-01T00:00:00Z"),
      projection("undated", "done"),
      projection("active", "active"),
      archived,
    ]);
    render();
    chip("出件验收");
    expect(
      [...host.querySelectorAll('[data-testid^="agenda-row-"]')].map((el) => el.getAttribute("data-testid")),
    ).toEqual(["agenda-row-submitted", "agenda-row-review", "agenda-row-recent"]);
    expect(find("agenda-delivery-tabs").textContent).not.toContain("说明");
  });

  it("keeps answered receipts folded at the bottom and out of default Inbox and keyboard flow", () => {
    render(
      agenda({
        awaitingYou: [ask("inbox")],
        answeredForYou: [
          {
            relationId: "receipt",
            sourceRef: "task/task_answered",
            title: "Answered",
            status: "active",
            personId: "person_owner",
            askKind: "question",
            question: "Ship?",
            answer: "Ship it",
            answeredBy: "person_owner",
            answeredAt: AT,
          },
        ],
      }),
    );
    expect(host.querySelector('[data-testid="agenda-row-receipt"]')).toBeNull();
    chip("全部");
    const quiet = find<HTMLDetailsElement>("agenda-quiet-fyi");
    expect(quiet.open).toBe(false);
    expect(find("agenda-current-card").compareDocumentPosition(quiet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    key("j");
    expect(selected()).toBe("inbox");
    act(() => {
      quiet.open = true;
      quiet.dispatchEvent(new Event("toggle"));
    });
    act(() => find("agenda-row-receipt").querySelector<HTMLButtonElement>("button")!.click());
    expect(selected()).toBe("receipt");
    click("agenda-card-open");
    expect(navigate).toHaveBeenCalledWith("task/task_answered");
  });

  it("mounts WorkGraphTab for the selected attention work and resets the graph boundary across works", () => {
    render(
      agenda({
        awaitingYou: [ask("a"), ask("b")],
        attentionItems: ["a", "b"].map((id) => ({
          ref: `relation/${id}`,
          title: id,
          kind: "awaiting-you" as const,
          region: "mine" as const,
          workTaskId: `work_${id}`,
          attention: { score: 10, reasons: [] },
        })),
      }),
    );
    expect(find("work-graph-wiring").getAttribute("data-work-root")).toBe("work_a");
    expect(find("work-graph-wiring").getAttribute("data-active")).toBe("true");
    key("j");
    expect(find("work-graph-wiring").getAttribute("data-work-root")).toBe("work_b");
  });

  it("resolves supplemental task Work from the shared index without inferring from parent links", async () => {
    seedTasks([projection("child")]);
    client.setQueryData(taskQueryKeys.works("repo"), {
      ok: true,
      status: "ready",
      works: [{ taskId: "work_root", title: "Work", memberTaskIds: ["child"] }],
      watermark: 1,
      sourceRevision: 1,
    });
    render();
    chip("出件验收");
    await settle(() => expect(find("work-graph-wiring").getAttribute("data-work-root")).toBe("work_root"));
    expect(find("work-graph-wiring").getAttribute("data-task-count")).toBe("1");
  });

  it("keeps agenda-only cards usable when supplementary task/work reads fail and reports delivery read failure", async () => {
    vi.mocked(harnessClient.getTasks).mockRejectedValue(new Error("task read unavailable"));
    vi.mocked(harnessClient.getWorkIndex).mockRejectedValue(new Error("work read unavailable"));
    vi.mocked(harnessClient.getTaskDeliveryDiff).mockRejectedValue(new Error("diff unavailable"));
    vi.mocked(harnessClient.getTaskDocuments).mockRejectedValue(new Error("documents unavailable"));
    render(
      agenda({
        awaitingAdjudication: [
          {
            taskId: "delivery",
            title: "Agenda delivery",
            work: null,
            pinned: false,
            executionId: "exe_delivery",
            submittedAt: AT,
            blockingAssessment: { state: "clear" } as never,
          },
        ],
      }),
    );
    chip("出件验收");
    expect(find("agenda-current-card").textContent).toContain("Agenda delivery");
    await settle(() => expect(host.textContent).toContain("diff unavailable"));
    expect(host.textContent).toContain("documents unavailable");
    click("agenda-card-open");
    expect(navigate).toHaveBeenCalledWith("taskreview/delivery");
    expect(host.querySelector('[data-testid="work-graph-wiring"]')).toBeNull();
  });

  it("retains selection after refresh, chooses a visible replacement after removal, and clears repository state", () => {
    render(agenda({ awaitingYou: [ask("a"), ask("b")] }));
    key("j");
    expect(selected()).toBe("b");
    render(agenda({ awaitingYou: [ask("a"), ask("b", { question: "Updated question" })] }));
    expect(selected()).toBe("b");
    expect(find("agenda-current-card").textContent).toContain("Updated question");
    render(agenda({ awaitingYou: [ask("a")] }));
    expect(selected()).toBe("a");
    click("agenda-mode-focus");
    render(agenda({ awaitingYou: [ask("other")] }), "another-repo");
    expect(selected()).toBe("other");
  });

  it("preserves native Decision review routes while exposing all its awaits with daemon attention", () => {
    render(
      agenda({
        awaitingYou: [
          ask("one", { sourceRef: "decision/dec_native" }),
          ask("two", { sourceRef: "decision/dec_native", question: "Keep this boundary?" }),
        ],
        attentionItems: [
          {
            ref: "relation/two",
            title: "Decision question",
            kind: "awaiting-you",
            region: "mine",
            workTaskId: "work_native",
            attention: { score: 177, reasons: [{ label: "等待裁决", contribution: 177 }] },
          },
        ],
      }),
    );
    expect(selected()).toBe("dec_native");
    expect(host.querySelectorAll('[data-testid="agenda-row-dec_native"]')).toHaveLength(1);
    expect(find("agenda-current-card").querySelectorAll("form")).toHaveLength(2);
    expect(find("agenda-current-card").textContent).toContain("177");
    expect(find("work-graph-wiring").getAttribute("data-work-root")).toBe("work_native");
    click("agenda-card-open");
    expect(navigate).toHaveBeenCalledWith("decisionreview/dec_native/respond");
  });

  it("renders agenda before pending task reads and labels truncated diff counts truthfully", async () => {
    vi.mocked(harnessClient.getTasks).mockImplementation(() => new Promise(() => {}));
    render(agenda({ awaitingYou: [ask("ready")] }));
    expect(selected()).toBe("ready");
    const read = agenda({
      awaitingAdjudication: [
        {
          taskId: "partial",
          title: "Partial delivery",
          work: null,
          executionId: "exe_partial",
          submittedAt: AT,
          pinned: false,
          blockingAssessment: { state: "clear" } as never,
        },
      ],
    });
    vi.mocked(harnessClient.getTaskDeliveryDiff).mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "partial",
      baseline: "base",
      commitSha: "head",
      files: [{ filePath: "partial.ts", lines: [{ kind: "add", text: "new" }] }],
      truncated: true,
      watermark: 1,
      sourceRevision: 1,
    });
    render(read);
    chip("出件验收");
    await settle(() => expect(find("agenda-delivery-summary").textContent).toContain("仅统计已载入变更"));
    expect(find("agenda-delivery-summary").textContent).toContain("+1 / −0");
    expect(find("agenda-gate-summary").textContent).toBe("门禁未读取");
  });
});

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
import { runtimeCommandClient } from "../src/renderer/runtime-command-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { taskReworkClient } from "../src/renderer/task-rework-client.ts";
import { agendaQueryKeys } from "../src/renderer/agenda-data.ts";
import { taskQueryKeys, TASK_EXPLAINER_DOC } from "../src/renderer/task-data.ts";

// dec_653AB9E451B58125CA2B5C0289/CH1: the existing route becomes the workbench.
// Keep the real read hooks, Explainer and answer mutation; isolate only graph drawing.
// dec_4AEEEB88AB4BB75474915BAC5C CH3: exercise the real bounded neighborhood host, isolate drawing only.
vi.mock("../src/renderer/graph/EgoNeighborhood", async (original) => ({
  ...(await original<typeof import("../src/renderer/graph/EgoNeighborhood")>()),
  EgoNeighborhood: (props: {
    focusRef: string;
    hops: { up: number; down: number };
    decisions: readonly { title: string }[];
  }) =>
    createElement("div", {
      "data-testid": "focal-graph-wiring",
      "data-focus-ref": props.focusRef,
      "data-hops": JSON.stringify(props.hops),
      "data-decisions": props.decisions.map((d) => d.title).join(","),
      "data-invented-judgment": String(props.decisions.some((d) => "claimsOpen" in d)),
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

const deliveryRow = (taskId: string): AgendaSuccess["awaitingAdjudication"][number] => ({
  taskId,
  title: `Agenda delivery ${taskId}`,
  work: null,
  pinned: false,
  executionId: `exe_${taskId}`,
  submittedAt: AT,
  blockingAssessment: { taskId, state: "clear", label: "none", blockers: [], warnings: [] },
});

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const navigate = vi.fn();
const focusGraph = vi.fn();
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
  focusGraph.mockClear();
  vi.spyOn(harnessClient, "getDecisionSummaries").mockResolvedValue({
    ok: true,
    decisions: [
      {
        decisionId: "dec_native",
        title: "Native summary title",
        state: "in_effect",
        riskTier: "low",
        urgency: "medium",
        proposedAt: AT,
      },
    ],
    warnings: [],
  });
  vi.spyOn(harnessClient, "getRelationGraph").mockResolvedValue({
    ok: true,
    edges: [],
    facts: [],
    factAnchors: [],
    coverageRows: [],
    warnings: [],
  });
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
          onFocusGraph: focusGraph,
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
    const reply = find<HTMLTextAreaElement>("awaits-answer-comment");
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
    expect(find<HTMLButtonElement>("awaits-answer-submit").disabled).toBe(true);
    input(find<HTMLTextAreaElement>("awaits-answer-comment"), "  Keep the API  ");
    click("awaits-answer-submit");
    await settle(() =>
      expect(retire).toHaveBeenCalledExactlyOnceWith({
        repoId: "repo",
        relationId: "answer",
        expectedVersion: 4,
        reason: "Keep the API",
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agendaQueryKeys.read("repo") });
    await settle(() => expect(find("awaits-answer-feedback").getAttribute("data-state")).toBe("success"));
    expect(host.querySelector('[data-testid="awaits-answer-close-done"]')).toBeNull();
  });

  it("refreshes a conflicted inline answer without closing the card or assuming a panel callback", async () => {
    vi.spyOn(harnessClient, "retireRelation").mockResolvedValue({
      ok: false,
      opId: "op-conflict",
      outcome: "op_rejected",
      code: "revision_conflict",
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(agenda({ awaitingYou: [ask("conflict")] }));
    input(find<HTMLTextAreaElement>("awaits-answer-comment"), "Keep the API");
    click("awaits-answer-submit");
    await settle(() => expect(find("awaits-answer-feedback").getAttribute("data-state")).toBe("conflict"));
    invalidate.mockClear();
    click("awaits-answer-refresh");
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: agendaQueryKeys.read("repo") });
    expect(selected()).toBe("conflict");
  });

  it("prefills consent choices without silently submitting, exposes rejection feedback, and resets per item", async () => {
    const retire = vi.spyOn(harnessClient, "retireRelation").mockRejectedValue(new Error("answer refused"));
    render(agenda({ awaitingYou: [ask("a", { askKind: "consent" }), ask("b", { askKind: "consent" })] }));
    click("awaits-answer-choice-agree");
    expect(retire).not.toHaveBeenCalled();
    expect(find<HTMLButtonElement>("awaits-answer-submit").disabled).toBe(false);
    click("awaits-answer-submit");
    await settle(() => expect(find("awaits-answer-feedback").textContent).toContain("answer refused"));
    expect(find("awaits-answer-feedback").getAttribute("data-state")).toBe("error");
    key("j");
    expect(selected()).toBe("b");
    expect(find<HTMLButtonElement>("awaits-answer-submit").disabled).toBe(true);
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

  it.each([
    { status: "submitted", source: "receipt", completedAt: null },
    { status: "submitted", source: "question", completedAt: null },
    { status: "in_review", source: "review", completedAt: null },
    { status: "done", source: "receipt", completedAt: AT },
  ] as const)("keeps $status delivery reachable beside its $source item", async ({ status, source, completedAt }) => {
    seedTasks([projection("delivery", status, completedAt)]);
    const read = agenda({
      awaitingYou: source === "question" ? [ask("question", { sourceRef: "task/delivery" })] : [],
      underReview: source === "review" ? [deliveryRow("delivery")] : [],
      answeredForYou:
        source === "receipt"
          ? [
              {
                ...ask("receipt", { sourceRef: "task/delivery" }),
                answer: "Ship it",
                answeredBy: "owner",
                answeredAt: AT,
              },
            ]
          : [],
    });
    render(read);
    expect(harnessClient.getTaskDeliveryDiff).not.toHaveBeenCalled();
    expect(harnessClient.getTaskDocuments).not.toHaveBeenCalled();
    chip("出件验收");
    expect(find("agenda-queue").querySelectorAll('[data-testid^="agenda-row-"]')).toHaveLength(1);
    expect(selected()).toBe("delivery");
    await settle(() => expect(find("agenda-delivery-summary").textContent).toContain("+2 / −1"));
    expect(find("agenda-gate-summary").textContent).toContain("1 / 2");
    expect(harnessClient.getTaskDeliveryDiff).toHaveBeenCalledExactlyOnceWith({ repoId: "repo", taskId: "delivery" });
    expect(harnessClient.getTaskDocuments).toHaveBeenCalledExactlyOnceWith({ repoId: "repo", taskId: "delivery" });
    chip(source === "question" ? "收件拍板" : "跟进与回执");
    if (source === "receipt") {
      const quiet = find<HTMLDetailsElement>("agenda-quiet-fyi");
      expect(quiet.open).toBe(false);
      expect(find("agenda-row-receipt").textContent).toContain("Ship it");
    } else {
      expect(selected()).toBe(source === "question" ? "question" : "delivery");
      expect(host.querySelector('[data-testid="agenda-delivery-summary"]')).toBeNull();
      if (source === "question") expect(find("awaits-answer-comment")).toBeTruthy();
    }
    expect(harnessClient.getTaskDeliveryDiff).toHaveBeenCalledTimes(1);
    expect(harnessClient.getTaskDocuments).toHaveBeenCalledTimes(1);
  });

  it("retains one native adjudication card when task projection and an Inbox question reference the same task", async () => {
    seedTasks([projection("delivery")]);
    render(
      agenda({
        awaitingAdjudication: [deliveryRow("delivery")],
        awaitingYou: [ask("question", { sourceRef: "task/delivery" })],
      }),
    );
    expect(find("awaits-answer-comment")).toBeTruthy();
    chip("出件验收");
    expect(find("agenda-queue").querySelectorAll('[data-testid^="agenda-row-"]')).toHaveLength(1);
    expect(find("agenda-current-card").textContent).toContain("Agenda delivery delivery");
    await settle(() => expect(find("agenda-delivery-summary").textContent).toContain("+2 / −1"));
    expect(harnessClient.getTaskDeliveryDiff).toHaveBeenCalledTimes(1);
    expect(harnessClient.getTaskDocuments).toHaveBeenCalledTimes(1);
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

  it("defaults to the selected task journey and resets one-hop focus across siblings of the same Work", async () => {
    seedTasks([projection("a"), projection("b")]);
    render(
      agenda({
        awaitingYou: [ask("a", { sourceRef: "task/a" }), ask("b", { sourceRef: "task/b" })],
        attentionItems: ["a", "b"].map((id) => ({
          ref: `relation/${id}`,
          title: id,
          kind: "awaiting-you" as const,
          region: "mine" as const,
          workTaskId: "umbrella",
          attention: { score: 10, reasons: [] },
        })),
      }),
    );
    expect(find("agenda-entity-focus").getAttribute("data-focus-ref")).toBe("task/a");
    expect(find("task-journey-graph")).toBeTruthy();
    // dec_4AEEEB88AB4BB75474915BAC5C CH3 owner rework: the focus toolbar owns this action.
    expect(find("agenda-entity-focus").querySelectorAll('[data-testid="view-in-graph-button"]')).toHaveLength(1);
    act(() =>
      find("agenda-entity-focus").querySelector<HTMLButtonElement>('[data-testid="view-in-graph-button"]')!.click(),
    );
    expect(focusGraph).toHaveBeenLastCalledWith("task/a");
    expect(host.querySelector('[data-testid="focal-graph-wiring"]')).toBeNull();
    click("agenda-focus-neighborhood");
    expect(find("focal-graph-wiring").getAttribute("data-focus-ref")).toBe("task/a");
    expect(find("agenda-entity-focus").querySelectorAll('[data-testid="view-in-graph-button"]')).toHaveLength(1);
    expect(find("focal-graph-wiring").getAttribute("data-hops")).toBe('{"up":1,"down":1}');
    key("j");
    expect(find("agenda-entity-focus").getAttribute("data-focus-ref")).toBe("task/b");
    expect(find("task-journey-graph")).toBeTruthy();
    expect(host.querySelector('[data-testid="focal-graph-wiring"]')).toBeNull();
    click("agenda-focus-neighborhood");
    expect(find("focal-graph-wiring").getAttribute("data-focus-ref")).toBe("task/b");
    await settle(() =>
      expect(harnessClient.getRelationGraph).toHaveBeenCalledWith(expect.objectContaining({ entity: "task/b" })),
    );
    for (const [payload] of vi.mocked(harnessClient.getRelationGraph).mock.calls)
      expect(payload.entity).toMatch(/^task\/[ab]$/);
    expect(host.querySelector('[data-testid="agenda-work-topology"]')).toBeNull();
  });

  it("focuses the supplemental child itself even when the shared index names an umbrella Work", async () => {
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
    expect(find("agenda-entity-focus").getAttribute("data-focus-ref")).toBe("task/child");
    expect(find("task-journey-graph")).toBeTruthy();
    expect(host.querySelector('[data-testid="agenda-work-topology"]')).toBeNull();
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

  it("preserves native Decision review routes while exposing all its awaits with daemon attention", async () => {
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
    expect(find("agenda-current-card").querySelectorAll('[data-testid="awaits-approval-card"]')).toHaveLength(2);
    expect(find("agenda-current-card").textContent).toContain("177");
    expect(find("focal-graph-wiring").getAttribute("data-focus-ref")).toBe("decision/dec_native");
    await settle(() =>
      expect(find("focal-graph-wiring").getAttribute("data-decisions")).toContain("Native summary title"),
    );
    expect(find("focal-graph-wiring").getAttribute("data-invented-judgment")).toBe("false");
    expect(host.querySelector('[data-testid="task-journey-graph"]')).toBeNull();
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

// dec_9C43012EBB2754D7112F618F0D CH1–CH3: regression inputs use the actual page.
describe("Agenda inline actions", () => {
  it("keeps archived recent delivery in quiet FYI, excluding it from active Outbox", () => {
    const archived = projection("received", "done", AT);
    archived.placement = { ...archived.placement, packageDisposition: "archived" };
    seedTasks([archived, projection("next", "done", AT)]);
    render();
    chip("出件验收");
    expect(selected()).toBe("next");
    expect(find("agenda-quiet-fyi").textContent).toContain("received");
    expect(find("agenda-archive")).toBeTruthy();
    expect(find("agenda-followup-title")).toBeTruthy();
  });
  it("renders worker ruling options inside the selected Inbox card", () => {
    render(
      agenda({
        awaitingRuling: [
          {
            taskId: "blocked",
            title: "Needs ruling",
            work: null,
            pinned: false,
            dispatchId: "dispatch_old",
            executionId: "exe_old",
            attention: "question",
            question: "Choose scope?",
            options: ["Keep scope", "Expand scope"],
            rulingPath: "artifacts/ruling.md",
            askedAt: AT,
            blockingAssessment: { state: "clear" } as never,
          },
        ],
      }),
    );
    expect(find("agenda-current-card").textContent).toContain("Choose scope?");
    expect(find("agenda-ruling-option-0").textContent).toBe("Keep scope");
  });
});

const applied = (extra: object = {}) =>
  ({
    schema: "command-receipt/v2",
    ok: true,
    outcome: "applied",
    opId: "op-one",
    proof: { durable: true, canonicalVisible: true, committedRevision: 5, appliedCut: 5 },
    ...extra,
  }) as never;
const ruling = (patch: object = {}) =>
  ({
    taskId: "blocked",
    title: "Needs ruling",
    work: null,
    pinned: false,
    dispatchId: "dispatch_old",
    executionId: "exe_old",
    attention: "question",
    question: "Choose scope?",
    options: ["Keep scope"],
    rulingPath: "artifacts/ruling.md",
    askedAt: AT,
    blockingAssessment: { state: "clear" },
    ...patch,
  }) as never;
function runtime() {
  const spawn = vi
    .spyOn(runtimeCommandClient, "spawn")
    .mockResolvedValue(applied({ runtimeSessionId: "session_new", dispatchId: "dispatch_new" }));
  vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue({
    status: "ready",
    sessions: [{ runtimeSessionId: "session_new" }],
  } as never);
  return spawn;
}
function toggle() {
  act(() => find("agenda-current-card").querySelector<HTMLButtonElement>('[role="switch"]')!.click());
}
function resumeRead() {
  vi.mocked(harnessClient.getTaskDispatches).mockResolvedValue({
    ok: true,
    status: "ready",
    dispatches: [
      {
        taskId: "task_question",
        dispatchId: "dispatch_old",
        startedAt: AT,
        resume: { dispatchId: "dispatch_old", agentId: "sol" },
      },
    ],
    page: { cursor: null, nextCursor: null, limit: 500 },
  } as never);
}

describe("Agenda durable answer then outside-write continuation", () => {
  it.each([true, false])("awaits resumes only after applied, autoWake=%s", async (autoWake) => {
    resumeRead();
    const spawn = runtime();
    let resolve!: (value: never) => void;
    vi.spyOn(harnessClient, "retireRelation").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(agenda({ awaitingYou: [ask("answer")] }));
    await settle(() => expect(find("agenda-current-card").querySelector('[role="switch"]')).not.toBeNull());
    if (!autoWake) toggle();
    input(find("awaits-answer-comment"), "Proceed");
    click("awaits-answer-submit");
    expect(spawn).not.toHaveBeenCalled();
    await act(async () => {
      resolve(applied());
    });
    await settle(() => expect(find("awaits-answer-feedback").getAttribute("data-state")).toBe("success"));
    if (autoWake)
      await settle(() =>
        expect(spawn).toHaveBeenCalledWith("repo", expect.objectContaining({ dispatchId: "dispatch_old" })),
      );
    else expect(spawn).not.toHaveBeenCalled();
  });
  it("does not replay an applied answer when wake fails, and exposes a wake-only retry", async () => {
    resumeRead();
    const spawn = runtime().mockRejectedValueOnce(new Error("provider offline"));
    const retire = vi.spyOn(harnessClient, "retireRelation").mockResolvedValue(applied());
    render(agenda({ awaitingYou: [ask("answer")] }));
    await settle(() => expect(harnessClient.getTaskDispatches).toHaveBeenCalled());
    input(find("awaits-answer-comment"), "Proceed");
    click("awaits-answer-submit");
    await settle(() => expect(find("agenda-continuation-feedback").textContent).toContain("provider offline"));
    expect(find("awaits-answer-feedback").getAttribute("data-state")).toBe("success");
    click("agenda-wake-retry");
    await settle(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(retire).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    "ruling records before NEW dispatch and never resumes old Execution, autoRun=%s",
    async (autoRun) => {
      const spawn = runtime();
      let resolve!: (value: never) => void;
      const answer = vi.spyOn(harnessClient, "resolveTaskEscalation").mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      render(agenda({ awaitingRuling: [ruling()] }));
      click("agenda-ruling-option-0");
      if (!autoRun) toggle();
      click("agenda-ruling-submit");
      expect(answer).toHaveBeenCalledWith({
        repoId: "repo",
        taskId: "blocked",
        dispatchId: "dispatch_old",
        answer: "Keep scope",
      });
      expect(spawn).not.toHaveBeenCalled();
      await act(async () => {
        resolve(applied());
      });
      await settle(() => expect(host.textContent).toContain("答复已落库"));
      if (autoRun) {
        await settle(() => expect(spawn).toHaveBeenCalled());
        expect(spawn.mock.calls[0][1]).toEqual({ taskId: "blocked", dispatchKey: expect.any(String) });
        await settle(() => expect(host.querySelector('[title="session/session_new"]')).not.toBeNull());
      } else expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("keeps a failed ruling continuation retry separate from the persisted answer", async () => {
    const spawn = runtime().mockRejectedValueOnce(new Error("offline"));
    const answer = vi.spyOn(harnessClient, "resolveTaskEscalation").mockResolvedValue(applied());
    render(agenda({ awaitingRuling: [ruling()] }));
    click("agenda-ruling-option-0");
    click("agenda-ruling-submit");
    await settle(() => expect(find("agenda-wake-retry")).toBeTruthy());
    click("agenda-wake-retry");
    await settle(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(answer).toHaveBeenCalledTimes(1);
  });
  it("closes incident receipts but never offers dismissal for a guard refusal", async () => {
    const dismiss = vi.spyOn(harnessClient, "dismissRuntimeIncident").mockResolvedValue(applied());
    render(agenda({ awaitingRuling: [ruling({ rulingPath: undefined, options: [] })] }));
    click("agenda-incident-dismiss");
    await settle(() => expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "dispatch_old" })));
    render(agenda({ awaitingRuling: [ruling({ attention: "guard", options: [], dispatchId: "guard" })] }));
    act(() => find("agenda-row-guard").querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[data-testid="agenda-incident-dismiss"]')).toBeNull();
  });
  it("offers same-round resume and fresh restart only on the selected restart card", async () => {
    resumeRead();
    const spawn = runtime();
    render(
      agenda({
        awaitingRestart: [{ taskId: "task_question", title: "Restart", updatedAt: AT, next: "restart" } as never],
      }),
    );
    await settle(() => expect(find("agenda-resume")).toBeTruthy());
    click("agenda-resume");
    await settle(() =>
      expect(spawn).toHaveBeenCalledWith("repo", expect.objectContaining({ dispatchId: "dispatch_old" })),
    );
    expect(find("agenda-restart")).toBeTruthy();
  });
});

describe("Agenda delivery acceptance", () => {
  it.each([false, true])("archives selected delivery or its whole Work, batch=%s", async (batch) => {
    const a = projection("a", "done", AT),
      b = projection("b", "done", AT),
      other = projection("other", "done", AT);
    seedTasks([a, b, other]);
    client.setQueryData(taskQueryKeys.works("repo"), {
      ok: true,
      status: "ready",
      works: [{ taskId: "work", title: "Work", memberTaskIds: ["a", "b"] }],
    });
    vi.mocked(harnessClient.getTasks).mockImplementation(
      async () => client.getQueryData(taskQueryKeys.list("repo")) as TaskListSuccess,
    );
    const archive = vi.spyOn(harnessClient, "archiveTasks").mockImplementation(async ({ taskIds }) => {
      for (const row of [a, b])
        if (taskIds.includes(row.taskId)) row.placement = { ...row.placement, packageDisposition: "archived" };
      seedTasks([{ ...a }, { ...b }, other]);
      return applied();
    });
    render();
    chip("出件验收");
    click(batch ? "agenda-archive-work" : "agenda-archive");
    await settle(() =>
      expect(archive).toHaveBeenCalledWith({
        repoId: "repo",
        taskIds: batch ? ["a", "b"] : ["a"],
        reason: expect.any(String),
      }),
    );
    await settle(() => expect(selected()).toBe(batch ? "other" : "b"));
    expect(find("agenda-quiet-fyi").textContent).toContain("a");
  });
  it("consents to the reviewed execution and sends rework reason with canonical cut", async () => {
    const row = projection("review", "in_review");
    row.snapshot = {
      ...row.snapshot,
      reviews: [
        {
          reviewId: "review_one",
          executionId: "exe_reviewed",
          reviewedAt: AT,
          reason: "Approved",
          evidenceChecked: [],
          verdict: "approved",
        } as never,
      ],
    };
    seedTasks([row]);
    const consent = vi.spyOn(harnessClient, "consentReview").mockResolvedValue(applied());
    const rework = vi.spyOn(taskReworkClient, "rework").mockResolvedValue(applied());
    vi.spyOn(taskReworkClient, "read").mockResolvedValue({
      reworkTargets: [{ executionId: "exe_reviewed", submissionDigest: "sha256:cut" }],
      task: row.snapshot.task,
    });
    render();
    chip("出件验收");
    await settle(() => expect(find("agenda-rework").hasAttribute("disabled")).toBe(true));
    click("agenda-consent");
    await settle(() =>
      expect(consent).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: "exe_reviewed", reviewId: "review_one" }),
      ),
    );
    seedTasks([row]);
    input(find("agenda-rework-reason"), "Fix regression");
    click("agenda-rework");
    await settle(() =>
      expect(rework).toHaveBeenCalledWith("repo", "review", {
        executionId: "exe_reviewed",
        submissionDigest: "sha256:cut",
        reason: "Fix regression",
      }),
    );
  });
  it("creates a follow-up under the same Work and links the new task", async () => {
    const row = projection("done", "done", AT);
    seedTasks([row]);
    client.setQueryData(taskQueryKeys.works("repo"), {
      ok: true,
      status: "ready",
      works: [{ taskId: "work", title: "Work", memberTaskIds: ["done"] }],
    });
    vi.spyOn(harnessClient, "getCatalogSnapshot").mockResolvedValue({
      defaults: { presetId: "standard", verticalId: "software", locale: "zh-CN" },
    } as never);
    vi.spyOn(harnessClient, "getCatalogPreset").mockResolvedValue({
      resolved: { documents: [{ slot: "task.plan", body: "## Brief" }] },
    } as never);
    const create = vi
      .spyOn(harnessClient, "createTask")
      .mockResolvedValue(applied({ taskId: "followup", packagePath: "tasks/followup" }));
    vi.mocked(harnessClient.getTasks).mockResolvedValue({
      ...client.getQueryData<TaskListSuccess>(taskQueryKeys.list("repo"))!,
    });
    render();
    chip("出件验收");
    input(find("agenda-followup-title"), "Check deployment");
    await settle(() => expect(find("agenda-followup").hasAttribute("disabled")).toBe(false));
    click("agenda-followup");
    await settle(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          parentTaskId: "work",
          title: "Check deployment",
          plan: expect.stringContaining("Check deployment"),
        }),
      ),
    );
    await settle(() => expect(host.querySelector('[title="task/followup"]')).not.toBeNull());
  });
});

describe("Agenda Decision judgment", () => {
  it.each([true, false])(
    "accepts in place and exposes only planned derived children, hasChild=%s",
    async (hasChild) => {
      const row = projection("child", "planned");
      row.placement = { ...row.placement, spawningDecisionIds: hasChild ? ["dec_native"] : [] };
      seedTasks([row]);
      vi.spyOn(harnessClient, "showDecision").mockResolvedValue({
        status: "ready",
        hint: null,
        decision: {
          schema: "decision-row/v1",
          decisionId: "dec_native",
          path: "decisions/decision-dec_native/decision.md",
          title: "Choose API",
          state: "proposed",
          question: "Use canonical actions?",
          riskTier: "low",
          urgency: "low",
          vertical: "software",
          preset: "standard",
          decisionClass: "ordinary",
          appliesTo: { modules: [], productLines: [] },
          proposer: { principal: { personId: "person_owner" }, executor: null },
          arbiter: null,
          proposedAt: AT,
          decidedAt: null,
          workspaceRevision: 1,
          chosen: [{ id: "CH1", text: "Use existing canonical action" }],
          rejected: [],
          claims: [],
          judgmentConsents: [],
          body: null,
          capabilities: [],
          claimsOpen: true,
        },
      } as never);
      const accept = vi
        .spyOn(harnessClient, "acceptDecision")
        .mockResolvedValue(
          applied({ path: "decisions/decision-dec_native/decision.md", commitSha: null, documentSha256: "digest" }),
        );
      render(
        agenda({
          awaitingDecision: [
            { decisionId: "dec_native", title: "Choose API", riskTier: "low", urgency: "low", proposedAt: AT },
          ],
        }),
      );
      await settle(() => expect(find("decision-judge-accept")).toBeTruthy());
      expect(host.querySelector('[data-testid="agenda-unlocked-tasks"]')).toBeNull();
      click("decision-judge-accept");
      const textareas = find("decision-judgment-panel").querySelectorAll<HTMLTextAreaElement>("textarea");
      input(textareas[0], "Approved");
      input(textareas[1], "Owner judgment");
      click("decision-judge-submit");
      await settle(() =>
        expect(accept).toHaveBeenCalledWith(
          expect.objectContaining({
            decisionId: "dec_native",
            rationale: "Approved",
            judgmentOnlyRationale: "Owner judgment",
          }),
        ),
      );
      if (hasChild) await settle(() => expect(find("agenda-unlock-child")).toBeTruthy());
      else expect(host.querySelector('[data-testid="agenda-unlocked-tasks"]')).toBeNull();
      expect(harnessClient.showDecision).toHaveBeenCalledWith({
        repoId: "repo",
        decisionId: "dec_native",
        includeBody: true,
      });
    },
  );
});

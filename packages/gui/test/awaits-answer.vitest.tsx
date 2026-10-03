// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AwaitsAnswerPanel } from "../src/renderer/components/AwaitsAnswerPanel.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, GuiActionResult } from "../src/api/renderer-dto.ts";
import type { AwaitsPanelSubject } from "../src/renderer/awaits-answer.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 「等你答复」面板的判据(happy-dom):四类请求各有人话标签、问题原文与对应控件;
 * 提交 = 以 retireRelation 退役该 awaits 边,答复按「选项:意见」写进 reason 并带当前修订;
 * 版本冲突提示刷新后重试,不伪造成功。
 */
const REPO_ID = "awaits-answer-probe";
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function ask(askKind: AgendaAwaitsRow["askKind"], question: string): AgendaAwaitsRow {
  return {
    relationId: `rel_${askKind}`,
    relationRevision: 7,
    sourceRef: "task/task_asking",
    title: "等你答复的任务",
    status: "planned",
    personId: "person_me",
    askKind,
    question,
    askedAt: "2026-09-28T10:00:00.000Z",
    askedBy: "codex-sol",
  };
}

function receipt(patch: Partial<GuiActionResult> & Record<string, unknown>): GuiActionResult {
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "relation-unrelate",
    outcome: "applied",
    opId: "op_answer",
    proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: true, worktreeVisible: null },
    ...patch,
  } as unknown as GuiActionResult;
}

async function mountPanel(subject: AwaitsPanelSubject) {
  const container = document.createElement("div"),
    onClose = vi.fn(),
    onNavigateEntity = vi.fn();
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AwaitsAnswerPanel, { repoId: REPO_ID, subject, onClose, onNavigateEntity }),
      ),
    );
  });
  expect(container.querySelector('[data-testid="awaits-answer-panel"]')).toBeNull();
  return { container: document.body, onClose, onNavigateEntity };
}

const byTestId = (container: HTMLElement, testId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function click(element: HTMLElement | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(container: HTMLElement, value: string): void {
  const textarea = byTestId(container, "awaits-answer-comment") as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    byTestId(container, "awaits-answer-submit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("awaits answer panel", () => {
  it.each([
    ["acceptance", "请你验收", ["pass", "fail"]],
    ["reopen", "要不要重开", ["reopen", "keepClosed"]],
    ["consent", "请你同意", ["agree", "disagree"]],
    ["question", "提问", []],
  ] as const)("shows the %s ask with its own controls", async (askKind, label, choices) => {
    const { container } = await mountPanel({ mode: "answer", row: ask(askKind, `原话:${askKind}`) });
    expect(byTestId(container, "awaits-answer-kind")?.textContent).toBe(label);
    expect(byTestId(container, "awaits-answer-question")?.textContent).toBe(`原话:${askKind}`);
    expect(byTestId(container, "awaits-answer-panel")?.textContent).toContain("提问方:codex-sol");
    for (const choice of ["pass", "fail", "reopen", "keepClosed", "agree", "disagree"])
      expect(byTestId(container, `awaits-answer-choice-${choice}`) !== null).toBe(
        (choices as readonly string[]).includes(choice),
      );
    // 没选选项(或 question 没写字)之前不能提交。
    expect((byTestId(container, "awaits-answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("retires the edge with the chosen verdict and comment at the current revision", async () => {
    const retire = vi.spyOn(harnessClient, "retireRelation").mockResolvedValue(receipt({}));
    const { container } = await mountPanel({ mode: "answer", row: ask("acceptance", "请上手验收总览页") });
    click(byTestId(container, "awaits-answer-choice-fail"));
    type(container, "按钮错位");
    expect(byTestId(container, "awaits-answer-preview")?.textContent).toContain("不通过:按钮错位");
    await submit(container);
    expect(retire).toHaveBeenCalledWith({
      repoId: REPO_ID,
      relationId: "rel_acceptance",
      reason: "不通过:按钮错位",
      expectedVersion: 7,
    });
    expect(byTestId(container, "awaits-answer-feedback")?.dataset.state).toBe("success");
    expect(byTestId(container, "awaits-answer-submit")).toBeNull();
  });

  it("sends a free-text answer for a question and the bare verdict when no comment is given", async () => {
    const retire = vi.spyOn(harnessClient, "retireRelation").mockResolvedValue(receipt({}));
    const question = await mountPanel({ mode: "answer", row: ask("question", "切到新读面吗?") });
    type(question.container, "  切,下周一起  ");
    await submit(question.container);
    expect(retire).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "切,下周一起" }));
    const consent = await mountPanel({ mode: "answer", row: ask("consent", "同意吗?") });
    click(byTestId(consent.container, "awaits-answer-choice-agree"));
    await submit(consent.container);
    expect(retire).toHaveBeenLastCalledWith(expect.objectContaining({ relationId: "rel_consent", reason: "同意" }));
  });

  it("asks for a refresh on a revision conflict instead of reporting success", async () => {
    vi.spyOn(harnessClient, "retireRelation").mockResolvedValue(
      receipt({ ok: false, outcome: "op_rejected", code: "revision_conflict" }),
    );
    const { container, onClose } = await mountPanel({ mode: "answer", row: ask("reopen", "要重开吗?") });
    click(byTestId(container, "awaits-answer-choice-keepClosed"));
    type(container, "已经修好");
    await submit(container);
    const feedback = byTestId(container, "awaits-answer-feedback");
    expect(feedback?.dataset.state).toBe("conflict");
    expect(feedback?.textContent).toContain("请刷新后重试");
    click(byTestId(container, "awaits-answer-refresh"));
    expect(onClose).toHaveBeenCalled();
  });

  it("reports a rejected write as an error with its code", async () => {
    vi.spyOn(harnessClient, "retireRelation").mockResolvedValue(
      receipt({ ok: false, outcome: "op_rejected", code: "entity_not_found" }),
    );
    const { container } = await mountPanel({ mode: "answer", row: ask("question", "还在吗?") });
    type(container, "在");
    await submit(container);
    const feedback = byTestId(container, "awaits-answer-feedback");
    expect(feedback?.dataset.state).toBe("error");
    expect(feedback?.textContent).toContain("entity_not_found");
  });

  it("shows the answer and the source link read-only for the asker's follow-up", async () => {
    const { container, onNavigateEntity } = await mountPanel({
      mode: "answered",
      row: {
        relationId: "rel_done",
        sourceRef: "decision/dec_asked",
        title: "已答复的决策",
        status: "proposed",
        personId: "person_me",
        askKind: "consent",
        question: "同意吗?",
        answer: "不同意:先补证据",
        answeredAt: "2026-09-28T11:00:00.000Z",
        answeredBy: "person_me",
      },
    });
    expect(byTestId(container, "awaits-answer-answer")?.textContent).toBe("不同意:先补证据");
    expect(byTestId(container, "awaits-answer-submit")).toBeNull();
    const openSource = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("打开来源"),
    );
    // 再次提问:给出与 `ha agenda` 同一条 relate 命令,指回同一个被问的人。
    expect(byTestId(container, "awaits-answer-reask")?.textContent).toContain(
      "ha relation relate --source-ref decision/dec_asked --target-ref person/person_me --type awaits",
    );
    click(openSource ?? null);
    expect(onNavigateEntity).toHaveBeenCalledWith("decision/dec_asked");
  });
});

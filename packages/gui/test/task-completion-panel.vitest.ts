// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { harnessClient } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { useTaskActions } from "../src/renderer/task-actions.ts";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  byTestId,
  child,
  cleanupMountedDetail,
  clickTab,
  decision,
  flushEffects,
  installBridge,
  mount,
  mounted,
  parent,
  prepareDetailEnvironment,
  task,
} from "./task-detail.fixtures.ts";

beforeAll(prepareDetailEnvironment);

afterEach(async () => {
  vi.restoreAllMocks();
  setActiveLocale("zh-CN");
  await cleanupMountedDetail();
});

describe("Task completion panel", () => {
  it("shows the panel for an in_review task and waits while the review blocker stands", async () => {
    installBridge({
      completionAction: "ha task dispatch-review task-w3",
      completionBlocker: { code: "review_pending", gate: "review" },
    });
    await mount();
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    // 评审未记录(blocker.code = review_pending)时没有任何可点按钮:评审员只查验,
    // 结论回流前既不能同意也不能结项;返工由 changes_requested 自动驱动。
    expect(panel.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-complete"]')?.disabled).toBe(true);
    expect(panel.textContent).toContain("完成销账独立评审尚未批准当前 cut");
  });

  it("shows each previous finding's reverify route and who the cut waits on", async () => {
    installBridge({
      completionAction: "ha task review-consent task-w3 --dispose review-w2",
      completionBlocker: { code: "review_pending", gate: "consent" },
      reviewReverify: {
        route: "owner-verify",
        findings: [{ reviewId: "review-w2", findingId: "F-count", reverify: "owner-verify", adopted: true }],
      },
    });
    await mount();
    await clickTab("收口");
    expect(byTestId("task-review-reverify").textContent).toBe("review-w2/F-count · 复核方式 owner-verify · 已采纳");
    expect(byTestId("task-completion-next").textContent).toContain("task owner");
  });

  it("routes the owner-verdict button once the read reports the consent blocker", async () => {
    installBridge({
      completionAction: "ha task review-consent task-w3",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    const consents: string[] = [];
    await mount({
      task: { ...task, consentTarget: { reviewId: "review-projected", executionId: "execution-current-cut" } },
      onConsentReview: (reviewId) => (consents.push(reviewId), Promise.resolve()),
    });
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    const consent = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-consent"]');
    const complete = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-complete"]');
    expect(consent?.disabled).toBe(false);
    // 机械结项在终审批准前保持不可点。
    expect(complete?.disabled).toBe(true);
    await act(async () => {
      consent!.click();
    });
    expect(consents).toEqual(["review-projected"]);
  });

  it("keeps button behavior identical when the action prose changes", async () => {
    // 面板阶段只认结构化 blocker.code;action 文案换成完全不同的措辞,按钮状态必须不变。
    installBridge({
      completionAction: "请中心按评审流程处理这个任务的收口",
      completionBlocker: { code: "review_pending", gate: "review" },
    });
    await mount();
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    // review 阶段没有可点按钮,prose 变化不产生任何可点面。
    expect(panel.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-complete"]')?.disabled).toBe(true);
  });

  it("hides the panel outside in_review", async () => {
    installBridge();
    await mount({
      task: {
        ...task,
        coordinationStatus: "active",
        ...projectedTaskFields("active", { can: ["progress", "submit"] }),
      },
    });
    await clickTab("收口");
    expect(document.querySelector('[data-testid="task-completion-panel"]')).toBeNull();
  });

  it("renders guidance only when the blocker is neither review nor consent", async () => {
    installBridge();
    await mount();
    await clickTab("收口");
    // blocker 不在 review/consent 阶段(默认 gate_witness_missing)时,面板只给指引,不给按钮。
    expect(document.querySelector('[data-testid="task-completion-submit"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
  });

  it("renders buttons and guidance correctly under en-US locale", async () => {
    setActiveLocale("en-US");
    try {
      // The triage/return buttons retired with the manual adjudicate commands; consent and
      // complete remain the owner's only explicit actions.
      await cleanupMountedDetail();
      installBridge({
        completionBlocker: { code: "consent_missing", gate: "consent" },
      });
      await mount();
      await clickTab("Closeout");
      const panel = byTestId("task-completion-panel");
      expect(panel.textContent).toContain("Closeout Settlement");
      expect(panel.textContent).toContain("Independent review approved");
      const consentBtn = byTestId("task-completion-consent");
      const completeConsent = byTestId("task-completion-complete");
      expect(consentBtn.textContent?.trim()).toBe("Approve Final Review");
      expect(completeConsent.textContent?.trim()).toBe("Complete Task");
      expect(completeConsent.getAttribute("data-tip")).toBe("Approve final review first before mechanical closeout");
    } finally {
      setActiveLocale("zh-CN");
    }
  });

  it("renders a role=alert diagnostic block when consent or complete is rejected and disables buttons while pending", async () => {
    installBridge({
      completionAction: "ha task review-consent task-w3",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    const consentTask = {
      ...task,
      ...projectedTaskFields("in_review", { can: ["complete"] }),
      consentTarget: { reviewId: "review-projected", executionId: "execution-current-cut" },
    };
    await mount({
      task: consentTask,
      mutationFeedback: {
        state: "error",
        kind: "consent",
        opId: "op-consent-err",
        code: "human_confirmation_required",
        hint: "Consent requires a personal session and a client granted the consent scope.",
      },
      onConsentReview: () => Promise.resolve(),
      onComplete: () => Promise.resolve(),
    });
    await clickTab("收口");
    const consentError = byTestId("task-completion-error");
    expect(consentError.getAttribute("role")).toBe("alert");
    expect(consentError.textContent).toContain("human_confirmation_required");
    expect(consentError.textContent).toContain("client granted the consent scope");

    await cleanupMountedDetail();
    installBridge({
      completionAction: "ha task complete task-w3",
      completionBlocker: null,
    });
    await mount({
      task: consentTask,
      mutationFeedback: {
        state: "error",
        kind: "complete",
        opId: "op-complete-err",
        code: "consent_missing",
        hint: "Review consent is required before completing this task.",
      },
      onConsentReview: () => Promise.resolve(),
      onComplete: () => Promise.resolve(),
    });
    await clickTab("收口");
    const completeError = byTestId("task-completion-error");
    expect(completeError.getAttribute("role")).toBe("alert");
    expect(completeError.textContent).toContain("consent_missing");
    expect(completeError.textContent).toContain("Review consent is required");

    await cleanupMountedDetail();
    installBridge({
      completionAction: "ha task review-consent task-w3",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    await mount({
      task: consentTask,
      mutationFeedback: {
        state: "pending",
        kind: "consent",
        opId: "awaiting-receipt",
        hint: "正在记录终审批准…",
      },
      onConsentReview: () => Promise.resolve(),
      onComplete: () => Promise.resolve(),
    });
    await clickTab("收口");
    expect((byTestId("task-completion-consent") as HTMLButtonElement).disabled).toBe(true);
    // Scoped by action kind: an in-flight consent feedback never disables the independent complete button.
    expect((byTestId("task-completion-complete") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-testid="task-completion-error"]')).toBeNull();
  });

  it("F-3: real click-to-rejection renders role=alert and consent canonical_not_visible never locks out complete after projection catches up", async () => {
    const bridge = installBridge({
      completionAction: "ha task review-consent task-w3",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    const consentReview = vi
      .spyOn(harnessClient, "consentReview")
      .mockResolvedValueOnce({
        schema: "command-receipt/v2",
        ok: false,
        outcome: "op_rejected",
        opId: "op-detail-reject",
        error: {
          code: "human_confirmation_required",
          hint: "Consent requires a personal session and a client granted the consent scope.",
        },
      } as never)
      .mockResolvedValueOnce({
        schema: "command-receipt/v2",
        ok: true,
        outcome: "applied",
        opId: "op-detail-invisible",
        proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: false },
      } as never);
    const completeTask = vi.spyOn(harnessClient, "completeTask").mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      outcome: "applied",
      opId: "op-detail-complete",
      proof: { committedRevision: 10, appliedCut: 10, durable: true, canonicalVisible: true },
    } as never);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    mounted.push({ root, client });

    function HarnessDetail({ currentTask }: { readonly currentTask: TaskRow }) {
      const actions = useTaskActions("repo-a");
      return createElement(TaskDetailView, {
        task: currentTask,
        tasks: [parent, currentTask, child],
        relations: [],
        decisions: [decision],
        onBack: () => undefined,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
        onNavigateEntity: () => undefined,
        mutationFeedback: actions.feedback.get(currentTask.taskId),
        onConsentReview: (reviewId) => actions.consentReview(currentTask, reviewId),
        onComplete: () => actions.completeTask(currentTask),
        projectName: "Harness",
      });
    }

    const waitingConsentTask: TaskRow = {
      ...task,
      ...projectedTaskFields("in_review", { can: [] }),
      consentTarget: { reviewId: "review-projected", executionId: "execution-current-cut" },
    };
    const renderTask = async (nextTask: TaskRow) => {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, { client }, createElement(HarnessDetail, { currentTask: nextTask })),
        );
      });
      await flushEffects();
    };

    await renderTask(waitingConsentTask);
    await clickTab("收口");

    // 1. Click consent -> real op_rejected receipt renders role=alert with code + hint.
    await act(async () => {
      byTestId("task-completion-consent").click();
    });
    await flushEffects();
    expect(consentReview).toHaveBeenCalledTimes(1);
    const alert = byTestId("task-completion-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("human_confirmation_required");
    expect(alert.textContent).toContain("client granted the consent scope");

    // 2. Retry consent -> applied with canonicalVisible:false (settles to pending/canonical_not_visible).
    await act(async () => {
      byTestId("task-completion-consent").click();
    });
    await flushEffects();
    expect(consentReview).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="task-completion-error"]')).toBeNull();
    // Consent button itself is not locked by canonical_not_visible either.
    expect((byTestId("task-completion-consent") as HTMLButtonElement).disabled).toBe(false);

    // 3. Projection catches up: blocker clears and complete capability becomes available.
    bridge.getTaskCompletion.mockResolvedValue({
      ok: true,
      taskId: "task-w3",
      factRetirement: null,
      reviewReverify: null,
      completionNext: null,
      completionBlocker: null,
    });
    await client.invalidateQueries();
    await renderTask({
      ...waitingConsentTask,
      ...projectedTaskFields("in_review", { can: ["complete"] }),
    });
    const completeBtn = byTestId("task-completion-complete") as HTMLButtonElement;
    expect(completeBtn.disabled).toBe(false);
    await act(async () => {
      completeBtn.click();
    });
    await flushEffects();
    expect(completeTask).toHaveBeenCalledTimes(1);
  });
});

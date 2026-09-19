// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  byTestId,
  cleanupMountedDetail,
  clickTab,
  installBridge,
  mount,
  prepareDetailEnvironment,
  task,
} from "./task-detail.fixtures.ts";

beforeAll(prepareDetailEnvironment);

afterEach(cleanupMountedDetail);

describe("Task completion panel", () => {
  it("shows the panel for an in_review task and waits while the review blocker stands", async () => {
    installBridge({
      completionAction: "ha task adjudicate task-w3 --forward --note-file <path>",
      completionBlocker: { code: "review_missing", gate: "review" },
    });
    await mount();
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    // 评审未记录(blocker.code = review_missing)时没有任何可点按钮:评审员只查验,
    // 结论回流 owner 裁决前既不能同意也不能结项。
    expect(panel.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-complete"]')?.disabled).toBe(true);
    expect(panel.textContent).toContain("独立评审尚未记录结论");
  });

  it("routes the owner-verdict button once the read reports the consent blocker", async () => {
    installBridge({
      completionAction: "ha task review-verdict task-w3",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    const consents: string[] = [];
    await mount({ onConsentReview: (reviewId) => (consents.push(reviewId), Promise.resolve()) });
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
    expect(consents).toEqual(["review-w3"]);
  });

  it("keeps button behavior identical when the action prose changes", async () => {
    // 面板阶段只认结构化 blocker.code;action 文案换成完全不同的措辞,按钮状态必须不变。
    installBridge({
      completionAction: "请中心按评审流程处理这个任务的收口",
      completionBlocker: { code: "review_missing", gate: "review" },
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
    // blocker 不在 review/consent 阶段(默认 closeout_placeholder)时,面板只给指引,不给按钮。
    expect(document.querySelector('[data-testid="task-completion-submit"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
  });
});

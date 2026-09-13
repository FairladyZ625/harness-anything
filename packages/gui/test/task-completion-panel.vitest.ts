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
  it("shows the panel for an in_review task and keeps consent disabled while the review blocker stands", async () => {
    installBridge({
      completionAction: "ha task complete task-w3",
      completionBlocker: { code: "review_missing", gate: "review" },
    });
    const calls: boolean[] = [];
    await mount({ onComplete: (consent) => (calls.push(consent), Promise.resolve()) });
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    const submit = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-submit"]');
    const consent = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-consent"]');
    expect(submit).toBeInstanceOf(HTMLButtonElement);
    expect(consent).toBeInstanceOf(HTMLButtonElement);
    // 评审未批准(blocker.code = review_missing)时,同意完成不可点。
    expect(consent?.disabled).toBe(true);
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit!.click();
    });
    expect(calls).toEqual([false]);
  });

  it("routes the consent button once the read reports the consent blocker", async () => {
    installBridge({
      completionAction: "ha task complete task-w3 --consent",
      completionBlocker: { code: "consent_missing", gate: "consent" },
    });
    const calls: boolean[] = [];
    await mount({ onComplete: (consent) => (calls.push(consent), Promise.resolve()) });
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    const submit = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-submit"]');
    const consent = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-consent"]');
    expect(consent?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
    await act(async () => {
      consent!.click();
    });
    expect(calls).toEqual([true]);
  });

  it("keeps button behavior identical when the action prose changes", async () => {
    // 面板阶段只认结构化 blocker.code;action 文案换成完全不同的措辞,按钮状态必须不变。
    installBridge({
      completionAction: "请中心按评审流程处理这个任务的收口",
      completionBlocker: { code: "review_missing", gate: "review" },
    });
    const calls: boolean[] = [];
    await mount({ onComplete: (consent) => (calls.push(consent), Promise.resolve()) });
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    const submit = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-submit"]');
    const consent = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-consent"]');
    expect(submit?.disabled).toBe(false);
    expect(consent?.disabled).toBe(true);
    await act(async () => {
      submit!.click();
    });
    expect(calls).toEqual([false]);
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

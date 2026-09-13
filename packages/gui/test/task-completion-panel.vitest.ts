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
  it("shows the panel for an in_review task and keeps consent disabled until the review is approved", async () => {
    installBridge({ completionAction: "ha task complete task-w3" });
    const calls: boolean[] = [];
    await mount({ onComplete: (consent) => (calls.push(consent), Promise.resolve()) });
    await clickTab("收口");
    const panel = byTestId("task-completion-panel");
    const submit = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-submit"]');
    const consent = panel.querySelector<HTMLButtonElement>('[data-testid="task-completion-consent"]');
    expect(submit).toBeInstanceOf(HTMLButtonElement);
    expect(consent).toBeInstanceOf(HTMLButtonElement);
    // 评审未批准(read 只给出无 --consent 的 complete 命令)时,同意完成不可点。
    expect(consent?.disabled).toBe(true);
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit!.click();
    });
    expect(calls).toEqual([false]);
  });

  it("routes the consent button once the canonical read proposes the --consent command", async () => {
    installBridge({ completionAction: "ha task complete task-w3 --consent" });
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

  it("renders guidance only when the proposed action is not a completion command", async () => {
    installBridge();
    await mount();
    await clickTab("收口");
    // completionNext 的 action 不是 complete 命令时,面板只给指引,不给按钮。
    expect(document.querySelector('[data-testid="task-completion-submit"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-completion-consent"]')).toBeNull();
  });
});

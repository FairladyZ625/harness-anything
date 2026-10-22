// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { agendaRowsOf, GROUP_BUCKET } from "../src/renderer/model/agenda-rows.ts";

describe("unsubmitted delivery agenda row", () => {
  it("appears in attention, links to its task, and has both locale strings", () => {
    const agenda = {
      awaitingYou: [],
      answeredForYou: [],
      awaitingRework: [],
      awaitingAdjudication: [],
      underReview: [],
      awaitingDecisionReview: [],
      decisionReviewInProgress: [],
      awaitingDecision: [],
      attentionItems: [
        {
          ref: "task/task_unsubmitted",
          title: "SSH transport",
          kind: "unsubmitted-delivery",
          region: "mine",
          workTaskId: "task_unsubmitted",
          attention: { score: 80, reasons: [] },
        },
      ],
    } as unknown as AgendaSuccess;

    expect(GROUP_BUCKET.unsubmitted).toBe("attn");
    for (const [locale, expectedHint] of [
      ["en-US", "The worker stopped without submitting"],
      ["zh-CN", "执行者退出时未提交"],
    ] as const) {
      setActiveLocale(locale);
      expect(agendaRowsOf(agenda)).toContainEqual(
        expect.objectContaining({
          id: "task/task_unsubmitted",
          title: "SSH transport",
          group: "unsubmitted",
          target: "task/task_unsubmitted",
          hint: expect.stringContaining(expectedHint),
        }),
      );
    }
  });
});

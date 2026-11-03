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
      awaitingRestart: [],
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

  it("folds a released-lease task into the restart row instead of an unsubmitted duplicate", () => {
    const agenda = {
      awaitingYou: [],
      answeredForYou: [],
      awaitingRestart: [
        {
          taskId: "task_restart",
          title: "Stopped worker",
          status: "active",
          pinned: false,
          updatedAt: "2026-11-03T00:00:00.000Z",
          leaseExecutionId: null,
          activeExecutionIds: ["exe_restart"],
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
          next: "ha task start task_restart",
        },
      ],
      awaitingRework: [],
      awaitingAdjudication: [],
      underReview: [],
      awaitingDecisionReview: [],
      decisionReviewInProgress: [],
      awaitingDecision: [],
      attentionItems: [
        {
          ref: "task/task_restart",
          title: "Stopped worker",
          kind: "unsubmitted-delivery",
          region: "mine",
          workTaskId: "task_restart",
          attention: { score: 80, reasons: [] },
        },
      ],
    } as unknown as AgendaSuccess;

    expect(GROUP_BUCKET.restart).toBe("attn");
    for (const [locale, expectedHint] of [
      ["en-US", "next: ha task start task_restart"],
      ["zh-CN", "下一步 ha task start task_restart"],
    ] as const) {
      setActiveLocale(locale);
      const rows = agendaRowsOf(agenda);
      expect(rows.filter(({ id }) => id === "task_restart")).toEqual([
        expect.objectContaining({
          id: "task_restart",
          group: "restart",
          target: "taskreview/task_restart",
          hint: expect.stringContaining(expectedHint),
        }),
      ]);
      expect(rows.some(({ group }) => group === "unsubmitted")).toBe(false);
    }
  });
});

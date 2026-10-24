// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { useTaskActions } from "../src/renderer/task-actions.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const receipt = (over: Partial<GuiActionResult> = {}): GuiActionResult =>
  ({
    schema: "command-receipt/v2",
    ok: true,
    command: "task-review-consent",
    outcome: "applied",
    opId: "op-consent-1",
    revision: 9,
    proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: true, worktreeVisible: false },
    ...over,
  }) as unknown as GuiActionResult;

const review = (executionId: string, reviewId: string) =>
  ({
    schema: "review/v1",
    reviewId,
    taskId: "task-consent",
    executionId,
    verdict: "approved",
    actor: { principal: { personId: "person-reviewer" } },
    capabilityRef: "capability/1",
    reason: "Independent review passed.",
    evidenceChecked: ["tests"],
    commitSha: null,
    iteration: 0,
    contentDigest: `sha256:${"a".repeat(64)}`,
    submissionDigest: `sha256:${"b".repeat(64)}`,
    reviewedAt: "2026-10-24T00:00:00.000Z",
  }) as NonNullable<TaskRow["reviews"]>[number];

describe("useTaskActions consent write channel", () => {
  it("states the execution of the reviewed cut explicitly; a released lease is never the consent target", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // In review the settlement already released the lease, so the old lease-derived id is absent.
    const task = {
      taskId: "task-consent",
      title: "Consent me",
      projectId: "repo-a",
      coordinationStatus: "in_review",
      canonicalStatus: "in_review",
      rawStatus: "in_review/review",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "not_required",
      engine: "local",
      source: "local-document",
      lastKnownAt: "2026-10-24T00:00:00.000Z",
      gates: [],
      docs: [],
      reviews: [review("execution-reviewed-cut", "review-final")],
    } as TaskRow;
    const consent = vi.fn(async () => receipt());
    vi.spyOn(harnessClient, "consentReview").mockImplementation(consent);

    let actions: ReturnType<typeof useTaskActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useTaskActions("repo-a");
              return null;
            }),
          }),
        );
      });
      let settled: Awaited<ReturnType<ReturnType<typeof useTaskActions>["consentReview"]>> | undefined;
      await act(async () => {
        settled = await actions!.consentReview(task, "review-final");
      });
      expect(consent).toHaveBeenCalledWith({
        repoId: "repo-a",
        taskId: "task-consent",
        executionId: "execution-reviewed-cut",
        reviewId: "review-final",
      });
      expect(settled?.state).toBe("success");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

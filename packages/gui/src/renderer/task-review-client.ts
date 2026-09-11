import type { CiObservatoryRead, EntityActionExplanationRead, GuiActionResult } from "../api/renderer-dto.ts";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";

export interface TaskReviewRepoScope {
  readonly repoId: string;
}

export const taskReviewClient = {
  async reviewTaskExecution(
    payload: TaskReviewRepoScope & {
      readonly taskId: string;
      readonly executionId: string;
      readonly reviewId: string;
      readonly verdict: "approved" | "changes_requested" | "dismissed";
      readonly reason: string;
      readonly evidenceChecked: readonly string[];
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.review", payload, "reviewTaskExecution"));
  },
  async consentTaskReview(
    payload: TaskReviewRepoScope & {
      readonly taskId: string;
      readonly executionId: string;
      readonly reviewId: string;
      readonly consentId: string;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.consent", payload, "consentTaskReview"));
  },
  async completeTask(
    payload: TaskReviewRepoScope & { readonly taskId: string; readonly executionId: string; readonly ci?: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.complete", payload, "completeTask"));
  },
  async explainTaskActions(
    payload: TaskReviewRepoScope & { readonly taskId: string },
  ): Promise<EntityActionExplanationRead> {
    return (await invoke(
      "repo.entity.actions.explain",
      {
        repoId: payload.repoId,
        schema: "entity-action-explain-request/v1",
        mode: "object",
        entityKind: null,
        refs: [`task/${payload.taskId}`],
      },
      "explainEntityActions",
    )) as EntityActionExplanationRead;
  },
  async getCiObservatory(payload: TaskReviewRepoScope & { readonly window?: number }): Promise<CiObservatoryRead> {
    return (await invoke("repo.ci.observatory.read", payload, "getCiObservatory")) as CiObservatoryRead;
  },
};

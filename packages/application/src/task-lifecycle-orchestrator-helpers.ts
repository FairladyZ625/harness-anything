import { Effect } from "effect";
import type { ArtifactStore, TaskId } from "@harness-anything/kernel";
import { evaluateReviewGate, isReviewPlaceholderMarkdown, parseReviewMarkdown } from "./task-lifecycle-gates.ts";
import type { TaskLifecycleFailure, TaskLifecycleResult, TaskLifecycleWarning } from "./task-lifecycle-orchestrator.ts";

export function taskFailure(taskId: string, code: string, hint: string): TaskLifecycleFailure {
  return { ok: false, taskId, error: { code, hint } };
}

export function readTaskDocument(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  documentPath: string
): Effect.Effect<string | null> {
  return artifactStore.readTaskPackage(taskId as TaskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === documentPath)?.body ?? null),
    Effect.catchAll(() => Effect.succeed(null))
  );
}

export function legacyReviewCompatibility(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  reviewerId: string,
  now: (() => string) | undefined
): Effect.Effect<{
  readonly blocker: TaskLifecycleFailure | null;
  readonly warnings: ReadonlyArray<TaskLifecycleWarning>;
}> {
  return Effect.gen(function* () {
    const reviewBody = yield* readTaskDocument(artifactStore, taskId, "review.md");
    if (reviewBody === null || isReviewPlaceholderMarkdown(reviewBody)) return { blocker: null, warnings: [] };

    const parsed = parseReviewMarkdown(reviewBody);
    if (parsed.issues.length > 0) {
      return {
        blocker: {
          ok: false,
          taskId,
          issues: parsed.issues,
          error: {
            code: "review_schema_invalid",
            hint: "Legacy review.md contains malformed material findings; repair or migrate them before typed completion."
          }
        },
        warnings: []
      };
    }
    if (parsed.findings.length === 0) return { blocker: null, warnings: [] };

    const gate = evaluateReviewGate({
      taskId,
      reviewerId,
      submittedAt: now ? now() : new Date().toISOString(),
      findings: parsed.findings
    });
    return {
      blocker: null,
      warnings: gate.ok ? [] : [releaseBlockingFindingsWarning(
        "Open release-blocking findings remain in legacy review.md; owner approval continued without blocking typed completion.",
        gate.issues
      )]
    };
  });
}

export function reviewTask(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  reviewerId: string,
  now: (() => string) | undefined
): Effect.Effect<TaskLifecycleResult> {
  return Effect.gen(function* () {
    const parsed = parseReviewMarkdown((yield* readTaskDocument(artifactStore, taskId, "review.md")) ?? "");
    if (parsed.issues.length > 0) {
      return {
        ok: false,
        taskId,
        issues: parsed.issues,
        error: {
          code: "review_schema_invalid",
          hint: "review.md material findings table failed validation."
        }
      };
    }

    const gate = evaluateReviewGate({
      taskId,
      reviewerId,
      submittedAt: now ? now() : new Date().toISOString(),
      findings: parsed.findings
    });
    return gate.ok
      ? { ok: true, taskId, report: gate, reviewContract: gate.contract }
      : {
          ok: true,
          taskId,
          report: gate,
          reviewContract: gate.contract,
          warnings: [releaseBlockingFindingsWarning(
            "Open release-blocking findings remain; owner review continued and the findings are visible in this receipt.",
            gate.issues
          )]
        };
  });
}

export function terminalStatusDemotionWarning(taskId: string): TaskLifecycleWarning {
  return {
    severity: "warning",
    code: "terminal_status_requires_task_complete",
    message: `Direct terminal status transition bypassed the owner approval path. Preferred path: ha task complete ${taskId} --approve. If the task is already terminal and more work is required, run ha task supersede ${taskId} --title <follow-up-title>.`,
    revivalCondition: ownerValidationRevivalCondition
  };
}

const ownerValidationRevivalCondition = "Reinstate a hard rejection only after a third independent user, external auditor, or writer outside direct owner review exists and a real incident is documented.";

function releaseBlockingFindingsWarning(
  message: string,
  issues: ReadonlyArray<{
    readonly code?: string;
    readonly findingId?: string;
    readonly message?: string;
  }>
): TaskLifecycleWarning {
  return {
    severity: "warning",
    code: "release_blocking_findings",
    message,
    revivalCondition: ownerValidationRevivalCondition,
    issues
  };
}

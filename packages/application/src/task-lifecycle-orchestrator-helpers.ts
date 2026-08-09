import { Effect } from "effect";
import type { ArtifactStore, DomainStatus, TaskId } from "@harness-anything/kernel";
import { evaluateReviewGate, isReviewPlaceholderMarkdown, parseReviewMarkdown } from "./task-lifecycle-gates.ts";
import type { TaskLifecycleFailure, TaskLifecycleResult, TaskLifecycleWarning } from "./task-lifecycle-orchestrator.ts";

export function taskFailure(taskId: string, code: string, hint: string): TaskLifecycleFailure {
  return { ok: false, taskId, error: { code, hint } };
}

export function terminalStatusFailure(taskId: string, status: DomainStatus): TaskLifecycleFailure {
  return taskFailure(
    taskId,
    "terminal_status_requires_task_complete",
    status === "done"
      ? `Direct done is blocked because completion consent is recorded only by the typed completion transaction. Run \`ha task show ${taskId} --json\` to confirm the current state. If the task is not terminal, inspect \`ha task complete --help\` and prepare the required approval packet before retrying completion. If it is already terminal and follow-up work is needed, inspect \`ha task supersede --help\` before creating replacement work.`
      : `Direct cancellation is blocked unless it is an audited recovery. Run \`ha task show ${taskId} --json\` to confirm the current state. If the task is not terminal and cancellation is still intended, inspect \`ha task transition --help\` and supply a truthful audited reason. If it is already terminal and follow-up work is needed, inspect \`ha task supersede --help\` before creating replacement work.`
  );
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
            hint: "Typed completion was rejected because legacy review.md contains malformed material findings. Open `harness/tasks/<task-package>/review.md`, repair the reported table cells, then rerun `ha task complete <task-id> --approve --from-file approval.json`."
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
          hint: "Task review was rejected because review.md material findings failed schema validation. Open `harness/tasks/<task-package>/review.md`, repair the reported table cells, then rerun `ha task review <task-id>`."
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

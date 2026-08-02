import { Effect, Schema } from "effect";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  assertReviewEvidenceBelongsToExecution,
  renderCodeDocReconciliationDraft
} from "@harness-anything/application";
import {
  executionDeclaration,
  makeMarkdownArtifactStore,
  type ExecutionRecord
} from "@harness-anything/kernel";
import { normalizeReviewExecutionSelection } from "../../cli/review-execution-normalizer.ts";
import type { CliTaskCompleteAction, ParsedCommand } from "../../cli/types.ts";

export type TaskCompleteCommand = ParsedCommand & {
  readonly action: CliTaskCompleteAction;
};

export async function taskCompleteCodeDocAlreadyCurrent(
  command: TaskCompleteCommand,
  sha: string
): Promise<boolean> {
  const taskPackage = await Effect.runPromise(makeMarkdownArtifactStore({
    rootDir: command.rootDir,
    ...(command.layoutOverrides ? { layoutOverrides: command.layoutOverrides } : {})
  }).readTaskPackage(command.action.taskId));
  return isCodeDocReconciliationCurrent({
    taskId: command.action.taskId,
    documents: taskPackage.documents,
    sha,
    paths: command.action.approval?.paths ?? [],
    ...(command.action.approval?.prRef ? { prRef: command.action.approval.prRef } : {})
  });
}

export async function taskCompleteApprovalPreflightIssues(
  command: TaskCompleteCommand
): Promise<ReadonlyArray<{
  readonly code: "write_rejected";
  readonly message: string;
  readonly nextCommand: string;
  readonly disposition: "blocked";
}>> {
  if (!command.action.approval) return [];
  const artifactStore = makeMarkdownArtifactStore({
    rootDir: command.rootDir,
    ...(command.layoutOverrides ? { layoutOverrides: command.layoutOverrides } : {})
  });
  const reviewStep = taskCompleteApprovalReviewStep(command);
  const normalized = await normalizeReviewExecutionSelection(reviewStep, artifactStore);
  if (normalized.action.kind !== "task-review-execution") return [];
  const nextCommand = `ha task complete ${command.action.taskId} --approve --from-file approval.json --dry-run`;
  if (normalized.action.executionSelectionError || !normalized.action.executionId) {
    return [{
      code: "write_rejected",
      message: normalized.action.executionSelectionError ?? "task review-execution requires a selected Execution.",
      nextCommand,
      disposition: "blocked"
    }];
  }
  try {
    const task = await Effect.runPromise(artifactStore.readTaskPackage(command.action.taskId));
    const executionId = normalized.action.executionId;
    const document = task.documents.find((candidate) => candidate.path === `executions/${executionId}.md`);
    if (!document) throw new Error(`execution not found: ${executionId}`);
    const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
      executionDeclaration.documentCodec.decode(document.body)
    ) as ExecutionRecord;
    assertReviewEvidenceBelongsToExecution(execution, normalized.action.evidenceChecked);
    return [];
  } catch (error) {
    return [{
      code: "write_rejected",
      message: error instanceof Error ? error.message : String(error),
      nextCommand,
      disposition: "blocked"
    }];
  }
}

export function taskCompleteFacadeSteps(
  command: TaskCompleteCommand,
  sha: string,
  docSyncPaths: ReadonlyArray<string> = [],
  options: {
    readonly codeDocAlreadyCurrent?: boolean;
    readonly reviewAlreadyReady?: boolean;
  } = {}
): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  const approval = action.approval;
  const codeDocCanSkip = options.codeDocAlreadyCurrent === true
    && docSyncPaths.length === 0;
  return [
    ...(docSyncPaths.length > 0 ? [completeChild(command, {
      kind: "doc-sync",
      mode: "submit",
      paths: docSyncPaths
    }), completeChild(command, { kind: "materializer-run", dryRun: false, currentSessionOnly: true })] : []),
    ...(approval && options.reviewAlreadyReady !== true ? [taskCompleteApprovalReviewStep(command)] : []),
    ...(!codeDocCanSkip ? [completeChild(command, {
      kind: "task-code-doc-reconcile",
      taskId: action.taskId,
      sha,
      paths: approval?.paths ?? [],
      ...(approval?.prRef ? { prRef: approval.prRef } : {}),
      force: true
    })] : []),
    completeChild(command, {
      kind: "task-complete",
      taskId: action.taskId,
      ...(approval?.executionId ? { executionId: approval.executionId } : {}),
      ciGate: action.ciGate,
      reviewerId: action.reviewerId,
      evidenceMode: action.evidenceMode,
      ...(action.evidenceMode === "commit-anchor" ? { commitRef: sha, judgment: action.judgment } : {})
    })
  ];
}

function taskCompleteApprovalReviewStep(command: TaskCompleteCommand): ParsedCommand {
  const approval = command.action.approval!;
  return completeChild(command, {
    kind: "task-review-execution",
    taskId: command.action.taskId,
    ...(approval.executionId ? { executionId: approval.executionId } : {}),
    verdict: "approved",
    findings: approval.findings,
    evidenceChecked: approval.evidenceChecked,
    rationale: approval.rationale,
    archiveWarningsAcknowledged: approval.archiveWarningsAcknowledged,
    ...(approval.consentId ? { consentId: approval.consentId } : {}),
    ...(approval.consentUtterance ? { consentUtterance: approval.consentUtterance } : {}),
    ...(approval.consentStandingPolicyDecisionId ? { consentStandingPolicyDecisionId: approval.consentStandingPolicyDecisionId } : {}),
    ...(approval.consentAssertedRationale ? { consentAssertedRationale: approval.consentAssertedRationale } : {}),
    ...(approval.consentActions ? { consentActions: approval.consentActions } : {})
  });
}

export function isCodeDocReconciliationCurrent(input: {
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly sha: string;
  readonly paths?: ReadonlyArray<string>;
  readonly prRef?: string;
}): boolean {
  const existing = input.documents.find(
    (document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT
  );
  if (!existing) return false;
  const draft = renderCodeDocReconciliationDraft(input);
  return draft.recordIds.length > 0 && existing.body === draft.body;
}

function completeChild(command: ParsedCommand, action: ParsedCommand["action"]): ParsedCommand {
  return { ...command, action };
}

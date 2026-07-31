import { Effect } from "effect";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  renderCodeDocReconciliationDraft
} from "@harness-anything/application";
import { makeMarkdownArtifactStore } from "@harness-anything/kernel";
import type { ParsedCommand } from "../../cli/types.ts";

export type TaskCompleteCommand = ParsedCommand & {
  readonly action: Extract<
    ParsedCommand["action"],
    { readonly kind: "task-complete" }
  >;
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

export function taskCompleteFacadeSteps(
  command: TaskCompleteCommand,
  sha: string,
  docSyncPaths: ReadonlyArray<string> = [],
  options: { readonly codeDocAlreadyCurrent?: boolean } = {}
): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  const approval = action.approval;
  return [
    ...(docSyncPaths.length > 0 ? [completeChild(command, {
      kind: "doc-sync",
      mode: "submit",
      paths: docSyncPaths
    }), completeChild(command, { kind: "materializer-run", dryRun: false, currentSessionOnly: true })] : []),
    ...(approval ? [completeChild(command, {
      kind: "task-review-execution",
      taskId: action.taskId,
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
    })] : []),
    ...(!options.codeDocAlreadyCurrent ? [completeChild(command, {
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

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AuthorityHostAttribution,
  DaemonDocSyncHostServices,
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  TaskHolderExecutor
} from "@harness-anything/application";
import {
  resolveHarnessLayout,
  sha256Text,
  taskPackagePath,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { DocSyncServiceContext } from "../protocol/doc-sync-service-context.ts";
import type { RepoWriteOperationLookupResult } from "../runtime/repo-write-protocol.ts";
import type { HarnessDaemonRuntime } from "../runtime/repo-runtime.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import { buildDocSyncReport } from "./doc-sync-service.ts";
import { makeDocSyncSubmitHandler } from "./doc-sync-submit-handler.ts";
import {
  taskCompleteErrorMessage,
  taskCompleteMaterializationFailure,
  type TaskCompleteAutoMaterializationResult,
  type TaskCompleteAutoMaterializer,
  type TaskCompletePrepublishFailure
} from "./task-complete-auto-materialization-orchestration.ts";
import { waitForTaskCompleteCanonicalSettlement } from "./task-complete-auto-materialization-settlement.ts";

export {
  dispatchTaskCompleteWithAutoMaterialization,
  type TaskCompleteAutoMaterializationResult,
  type TaskCompleteAutoMaterializer,
  type TaskCompleteMaterializationFailureFile,
  type TaskCompletePrepublishFailure
} from "./task-complete-auto-materialization-orchestration.ts";
export {
  defaultTaskCompleteSettlementTimeoutMs,
  waitForTaskCompleteCanonicalSettlement
} from "./task-complete-auto-materialization-settlement.ts";

export interface TaskCompleteMaterializationSnapshot {
  readonly path: string;
  readonly baseBlobSha256: string | null;
  readonly body: string;
  readonly bodySha256: string;
  readonly mediaType: string;
  readonly size: number;
  readonly pathClass: string | null;
}

export function verifyTaskCompleteMaterializationSnapshot(
  snapshots: ReadonlyArray<TaskCompleteMaterializationSnapshot>,
  readBody: (filePath: string) => string
): {
  readonly path: string;
  readonly expectedBodySha256: string;
  readonly actualBodySha256: string | null;
} | undefined {
  for (const snapshot of snapshots) {
    let actualBodySha256: string | null;
    try {
      actualBodySha256 = sha256Text(readBody(snapshot.path));
    } catch {
      actualBodySha256 = null;
    }
    if (actualBodySha256 !== snapshot.bodySha256) {
      return {
        path: snapshot.path,
        expectedBodySha256: snapshot.bodySha256,
        actualBodySha256
      };
    }
  }
  return undefined;
}


export function makeTaskCompleteDocumentMaterializationServices(options: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly repoId: string;
  readonly runtime: HarnessDaemonRuntime;
  readonly hostServices: DaemonDocSyncHostServices;
  readonly actorAttribution: (
    actor: AuthenticatedActor,
    executor: TaskHolderExecutor | null
  ) => AuthorityHostAttribution;
  readonly supervisor?: RepoWriteProcessSupervisor;
}) {
  const docSyncSubmit = makeDocSyncSubmitHandler({
    rootDir: options.rootDir,
    layoutOverrides: options.layoutOverrides,
    runtime: options.runtime,
    hostServices: options.hostServices,
    actorAttribution: options.actorAttribution,
    ...(options.supervisor ? { supervisor: options.supervisor } : {})
  });
  const supervisor = options.supervisor;
  return {
    docSyncSubmit,
    ...(supervisor ? {
      autoMaterializeTaskComplete: makeTaskCompleteAutoMaterializer({
        rootDir: options.rootDir,
        layoutOverrides: options.layoutOverrides,
        repoId: options.repoId,
        hostServices: options.hostServices,
        submit: docSyncSubmit,
        lookup: (receiptId) => supervisor.lookup(receiptId)
      })
    } : {})
  };
}

export function makeTaskCompleteAutoMaterializer(options: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly repoId: string;
  readonly hostServices: DaemonDocSyncHostServices;
  readonly submit: (
    request: DocSyncSubmitRequestV1,
    context?: DocSyncServiceContext
  ) => Promise<DocSyncSubmitResultV1>;
  readonly lookup?: (receiptId: string) => Promise<RepoWriteOperationLookupResult>;
}): TaskCompleteAutoMaterializer {
  const rootInput = options.layoutOverrides
    ? { rootDir: options.rootDir, layoutOverrides: options.layoutOverrides }
    : { rootDir: options.rootDir };
  return async (input) => {
    const layout = resolveHarnessLayout(rootInput);
    const packageRoot = portable(path.relative(
      layout.authoredRoot,
      taskPackagePath(rootInput, input.taskId as import("@harness-anything/kernel").TaskId)
    ));
    const requested = new Map(input.prepublishFailures.map((entry) => [entry.path, entry]));
    let report: ReturnType<typeof buildDocSyncReport>;
    try {
      report = buildDocSyncReport(rootInput, options.hostServices);
    } catch (error) {
      return taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_preflight_failed",
        input.prepublishFailures,
        error instanceof Error ? error.message : String(error)
      );
    }
    const selectedPaths = report.dirtyFiles
      .map((entry) => entry.path)
      .filter((entryPath) => requested.has(entryPath)
        && (entryPath === packageRoot || entryPath.startsWith(`${packageRoot}/`)));
    if (selectedPaths.length === 0) {
      return taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_no_candidate",
        input.prepublishFailures,
        "doc sync found no eligible dirty change for the prepublish path"
      );
    }
    if (!report.baseLedgerSha) {
      return taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_preflight_failed",
        input.prepublishFailures,
        "Doc sync submit requires an initialized authored Git repository."
      );
    }
    const snapshots: TaskCompleteMaterializationSnapshot[] = [];
    for (const selectedPath of selectedPaths) {
      const candidate = report.candidateBlobs.find((entry) => entry.path === selectedPath);
      if (!candidate?.newBlobSha256) {
        const diagnostic = report.unresolvedTouches.find((entry) => entry.path === selectedPath)?.reason
          ?? report.forbiddenTouches.find((entry) => entry.path === selectedPath)?.hunks[0]?.summary
          ?? "doc sync did not classify the dirty path as an eligible candidate";
        return taskCompleteMaterializationFailure(
          "task_complete_auto_materialization_preflight_failed",
          selectedFailures(input.prepublishFailures, [selectedPath]),
          diagnostic
        );
      }
      const body = readFileSync(path.join(layout.authoredRoot, selectedPath), "utf8");
      const bodySha256 = sha256Text(body);
      if (bodySha256 !== candidate.newBlobSha256) {
        return taskCompleteMaterializationFailure(
          "task_complete_auto_materialization_working_tree_changed",
          selectedFailures(input.prepublishFailures, [selectedPath]),
          "Working tree content changed while the automatic publication snapshot was being captured."
        );
      }
      snapshots.push({
        path: selectedPath,
        baseBlobSha256: candidate.baseBlobSha256,
        body,
        bodySha256,
        mediaType: candidate.mediaType,
        size: candidate.size,
        pathClass: candidate.pathClass
      });
    }
    const artifactRoot = `${packageRoot}/artifacts/`;
    const groups: ReadonlyArray<{
      readonly intent: DocSyncSubmitRequestV1["payload"]["declaredIntent"];
      readonly snapshots: ReadonlyArray<TaskCompleteMaterializationSnapshot>;
    }> = [
      { intent: "manual-artifact", snapshots: snapshots.filter((entry) => entry.path.startsWith(artifactRoot)) },
      { intent: "prose-edit", snapshots: snapshots.filter((entry) => !entry.path.startsWith(artifactRoot)) }
    ];
    const appliedPaths: string[] = [];
    for (const group of groups) {
      if (group.snapshots.length === 0) continue;
      const submitted = await submitMaterializationGroup(
        options,
        input,
        layout.authoredRoot,
        report.baseLedgerSha,
        group
      );
      if (!submitted.ok) return submitted.failure;
      appliedPaths.push(...submitted.paths);
    }
    return { ok: true, paths: appliedPaths };
  };
}

async function submitMaterializationGroup(
  options: Parameters<typeof makeTaskCompleteAutoMaterializer>[0],
  input: Parameters<TaskCompleteAutoMaterializer>[0],
  authoredRoot: string,
  baseLedgerSha: string,
  group: {
    readonly intent: DocSyncSubmitRequestV1["payload"]["declaredIntent"];
    readonly snapshots: ReadonlyArray<TaskCompleteMaterializationSnapshot>;
  }
): Promise<
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | { readonly ok: false; readonly failure: TaskCompleteAutoMaterializationResult }
> {
  let request: DocSyncSubmitRequestV1;
  try {
    const changed = verifyTaskCompleteMaterializationSnapshot(
      group.snapshots,
      (filePath) => readFileSync(path.join(authoredRoot, filePath), "utf8")
    );
    if (changed) {
      return {
        ok: false,
        failure: taskCompleteMaterializationFailure(
          "task_complete_auto_materialization_working_tree_changed",
          selectedFailures(input.prepublishFailures, [changed.path]),
          `Working tree content changed after snapshot capture for ${changed.path}.`
        )
      };
    }
    request = taskCompleteDocSyncRequest(options.repoId, baseLedgerSha, group, input);
  } catch (error) {
    return {
      ok: false,
      failure: taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_preflight_failed",
        selectedFailures(input.prepublishFailures, group.snapshots.map((entry) => entry.path)),
        taskCompleteErrorMessage(error)
      )
    };
  }
  let result: DocSyncSubmitResultV1;
  try {
    result = await options.submit(request, {
      actor: input.actor,
      executor: input.executor,
      authorityConnection: input.authorityConnection
    });
  } catch (error) {
    return {
      ok: false,
      failure: taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_submit_failed",
        selectedFailures(input.prepublishFailures, group.snapshots.map((entry) => entry.path)),
        taskCompleteErrorMessage(error)
      )
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      failure: rejectedResultFailure(
        result,
        input.prepublishFailures,
        group.snapshots.map((entry) => entry.path)
      )
    };
  }
  const settlement = await waitForTaskCompleteCanonicalSettlement(result, options.lookup);
  if (!settlement.settled) {
    return {
      ok: false,
      failure: taskCompleteMaterializationFailure(
        settlement.code,
        selectedFailures(input.prepublishFailures, group.snapshots.map((entry) => entry.path)),
        settlement.reason,
        {
          fix: settlement.fix,
          argv: settlement.recoveryArgv ?? ["ha", "daemon", "logs", "--json"],
          ...(settlement.receiptId && settlement.statusCommand ? {
            receiptId: settlement.receiptId,
            statusCommand: settlement.statusCommand
          } : {})
        }
      )
    };
  }
  return { ok: true, paths: result.appliedChanges.map((entry) => entry.path) };
}

function taskCompleteDocSyncRequest(
  repoId: string,
  baseLedgerSha: string,
  group: {
    readonly intent: DocSyncSubmitRequestV1["payload"]["declaredIntent"];
    readonly snapshots: ReadonlyArray<TaskCompleteMaterializationSnapshot>;
  },
  input: Parameters<TaskCompleteAutoMaterializer>[0]
): DocSyncSubmitRequestV1 {
  const changes = group.snapshots.map((snapshot) => ({
    path: snapshot.path,
    baseBlobSha256: snapshot.baseBlobSha256,
    newBlobSha256: snapshot.bodySha256,
    mediaType: snapshot.mediaType,
    size: snapshot.size,
    declaredBearing: "task-document",
    declaredZoneClass: "task-authored-prose-or-stage",
    ...(snapshot.pathClass ? { declaredPathClass: snapshot.pathClass } : {}),
    content: { kind: "inline" as const, body: snapshot.body }
  }));
  const intentMaterial = JSON.stringify({
    baseLedgerSha,
    changes: changes.map(({ path: changePath, baseBlobSha256, newBlobSha256 }) => ({
      path: changePath,
      baseBlobSha256,
      newBlobSha256
    }))
  });
  return {
    repo: { repoId },
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
    session: input.currentSession,
    payload: {
      baseLedgerSha,
      intentId: `intent_${sha256Text(intentMaterial).slice(0, 24)}`,
      declaredIntent: group.intent,
      changes
    }
  };
}

function rejectedResultFailure(
  result: Exclude<DocSyncSubmitResultV1, { readonly ok: true }>,
  prepublishFailures: ReadonlyArray<TaskCompletePrepublishFailure>,
  selectedPaths: ReadonlyArray<string>
): TaskCompleteAutoMaterializationResult {
  const diagnostics = "conflicts" in result
    ? [
        ...(result.conflicts ?? []).map((entry) => ({ path: entry.path, reason: `${entry.code}: ${entry.message}` })),
        ...(result.unresolvedTouches ?? []).map((entry) => ({ path: entry.path, reason: entry.reason })),
        ...(result.forbiddenTouches ?? []).map((entry) => ({
          path: entry.path,
          reason: entry.hunks.map((hunk) => hunk.summary).join("; ") || result.reason
        }))
      ]
    : [];
  const files = selectedFailures(prepublishFailures, selectedPaths).map((entry) => ({
    ...entry,
    reason: diagnostics.find((diagnostic) => diagnostic.path === entry.path)?.reason ?? result.reason
  }));
  const recovery = "outcomeUnknown" in result && result.outcomeUnknown
    ? {
        fix: `Do not resubmit this unknown result. Run \`${result.outcomeUnknown.statusCommand}\` before retrying task completion.`,
        argv: ["ha", "receipt", "status", result.outcomeUnknown.receiptId, "--json"],
        receiptId: result.outcomeUnknown.receiptId,
        statusCommand: result.outcomeUnknown.statusCommand
      }
    : undefined;
  return taskCompleteMaterializationFailure(
    `task_complete_auto_materialization_${result.code}`,
    files,
    result.reason,
    recovery,
    true
  );
}

function selectedFailures(
  failures: ReadonlyArray<TaskCompletePrepublishFailure>,
  selectedPaths: ReadonlyArray<string>
): ReadonlyArray<TaskCompletePrepublishFailure> {
  const selected = new Set(selectedPaths);
  return failures.filter((entry) => selected.has(entry.path));
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

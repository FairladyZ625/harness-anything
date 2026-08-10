import path from "node:path";
import type {
  AuthorityHostAttribution,
  CommandReceiptEnvelope,
  DaemonDocSyncHostServices,
  DaemonHostCommand,
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  TaskHolderExecutor
} from "@harness-anything/application";
import {
  resolveHarnessLayout,
  taskPackagePath,
  type CurrentSessionRef,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";
import type { DocSyncServiceContext } from "../protocol/doc-sync-service-context.ts";
import type { RepoWriteOperationLookupResult } from "../runtime/repo-write-protocol.ts";
import type { HarnessDaemonRuntime } from "../runtime/repo-runtime.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import {
  buildDocSyncReport,
  buildDocSyncSubmitRequest
} from "./doc-sync-service.ts";
import { makeDocSyncSubmitHandler } from "./doc-sync-submit-handler.ts";

const settlementPollIntervalMs = 25;
const settlementPollLimit = 200;

export interface TaskCompletePrepublishFailure {
  readonly path: string;
  readonly reason: string;
}

export type TaskCompleteAutoMaterializationResult =
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly code: string;
      readonly hint: string;
      readonly files: ReadonlyArray<TaskCompletePrepublishFailure & { readonly fix: string }>;
    };

export type TaskCompleteAutoMaterializer = (input: {
  readonly taskId: string;
  readonly currentSession: CurrentSessionRef;
  readonly actor: AuthenticatedActor;
  readonly executor: TaskHolderExecutor | null;
  readonly authorityConnection: Extract<AuthorityConnectionDispatch, { readonly available: true }>;
  readonly prepublishFailures: ReadonlyArray<TaskCompletePrepublishFailure>;
}) => Promise<TaskCompleteAutoMaterializationResult>;

export async function dispatchTaskCompleteWithAutoMaterialization(input: {
  readonly command: DaemonHostCommand;
  readonly currentSession: CurrentSessionRef;
  readonly actor: AuthenticatedActor;
  readonly executor: TaskHolderExecutor | null;
  readonly authorityConnection: Extract<AuthorityConnectionDispatch, { readonly available: true }>;
  readonly autoMaterialize?: TaskCompleteAutoMaterializer;
  readonly dispatch: () => Promise<CommandReceiptEnvelope>;
}): Promise<CommandReceiptEnvelope> {
  const taskId = taskCompleteTaskId(input.command);
  const enabled = input.command.action.kind === "task-complete"
    && input.command.action.dryRun !== true
    && input.autoMaterialize !== undefined
    && taskId !== undefined;
  const materializeAndRetry = async (
    prepublishFailures: ReadonlyArray<TaskCompletePrepublishFailure>
  ): Promise<CommandReceiptEnvelope> => {
    const materialized = await runAutoMaterializer(input, taskId!, prepublishFailures);
    if (!materialized.ok) return materializationFailureReceipt(input.command.action.kind, materialized);
    input.authorityConnection.assertActive();
    try {
      const retried = await input.dispatch();
      if (!retried.ok) {
        const remaining = taskCompletePrepublishFailures(retried);
        if (remaining.length > 0) return incompleteMaterializationFailure(input.command.action.kind, remaining);
      }
      return retried;
    } catch (error) {
      const remaining = taskCompletePrepublishFailuresFromText(taskCompleteErrorMessage(error));
      if (remaining.length > 0) return incompleteMaterializationFailure(input.command.action.kind, remaining);
      throw error;
    }
  };
  let receipt: CommandReceiptEnvelope;
  try {
    receipt = await input.dispatch();
  } catch (error) {
    const failures = enabled ? taskCompletePrepublishFailuresFromText(taskCompleteErrorMessage(error)) : [];
    if (failures.length > 0) return materializeAndRetry(failures);
    throw error;
  }
  if (!enabled || receipt.ok) return receipt;
  const failures = taskCompletePrepublishFailures(receipt);
  return failures.length > 0 ? materializeAndRetry(failures) : receipt;
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

async function runAutoMaterializer(
  input: Parameters<typeof dispatchTaskCompleteWithAutoMaterialization>[0],
  taskId: string,
  failures: ReadonlyArray<TaskCompletePrepublishFailure>
): Promise<TaskCompleteAutoMaterializationResult> {
  try {
    return await input.autoMaterialize!({
      taskId,
      currentSession: input.currentSession,
      actor: input.actor,
      executor: input.executor,
      authorityConnection: input.authorityConnection,
      prepublishFailures: failures
    });
  } catch (error) {
    const fix = docSyncFix();
    const files = failures.map((entry) => ({ ...entry, reason: taskCompleteErrorMessage(error), fix }));
    return {
      ok: false,
      code: "task_complete_auto_materialization_failed",
      hint: `Automatic task document publication failed. Run \`ha doc status --json\`, repair the named file, then run \`ha doc sync --submit\`. ${failureHint(files)}`,
      files
    };
  }
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
    const artifactRoot = `${packageRoot}/artifacts/`;
    const groups: ReadonlyArray<{
      readonly intent: DocSyncSubmitRequestV1["payload"]["declaredIntent"];
      readonly paths: ReadonlyArray<string>;
    }> = [
      { intent: "manual-artifact", paths: selectedPaths.filter((entry) => entry.startsWith(artifactRoot)) },
      { intent: "prose-edit", paths: selectedPaths.filter((entry) => !entry.startsWith(artifactRoot)) }
    ];
    const appliedPaths: string[] = [];
    for (const group of groups) {
      if (group.paths.length === 0) continue;
      const submitted = await submitMaterializationGroup(options, input, rootInput, group);
      if (!submitted.ok) return submitted.failure;
      appliedPaths.push(...submitted.paths);
    }
    return { ok: true, paths: appliedPaths };
  };
}

async function submitMaterializationGroup(
  options: Parameters<typeof makeTaskCompleteAutoMaterializer>[0],
  input: Parameters<TaskCompleteAutoMaterializer>[0],
  rootInput: { readonly rootDir: string; readonly layoutOverrides?: HarnessLayoutOverrides },
  group: {
    readonly intent: DocSyncSubmitRequestV1["payload"]["declaredIntent"];
    readonly paths: ReadonlyArray<string>;
  }
): Promise<
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | { readonly ok: false; readonly failure: TaskCompleteAutoMaterializationResult }
> {
  let request: DocSyncSubmitRequestV1;
  try {
    const docSyncRequest = buildDocSyncSubmitRequest(
      rootInput,
      options.repoId,
      group.paths,
      input.executor,
      options.hostServices,
      input.currentSession
    );
    request = group.intent === docSyncRequest.payload.declaredIntent
      ? docSyncRequest
      : { ...docSyncRequest, payload: { ...docSyncRequest.payload, declaredIntent: group.intent } };
  } catch (error) {
    return {
      ok: false,
      failure: taskCompleteMaterializationFailure(
        "task_complete_auto_materialization_preflight_failed",
        selectedFailures(input.prepublishFailures, group.paths),
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
        selectedFailures(input.prepublishFailures, group.paths),
        taskCompleteErrorMessage(error)
      )
    };
  }
  if (!result.ok) {
    return { ok: false, failure: rejectedResultFailure(result, input.prepublishFailures, group.paths) };
  }
  const settlement = await waitForCanonicalSettlement(result, options.lookup);
  if (!settlement.settled) {
    return {
      ok: false,
      failure: taskCompleteMaterializationFailure(
        settlement.code,
        selectedFailures(input.prepublishFailures, group.paths),
        settlement.reason,
        settlement.fix
      )
    };
  }
  return { ok: true, paths: result.appliedChanges.map((entry) => entry.path) };
}

async function waitForCanonicalSettlement(
  result: Extract<DocSyncSubmitResultV1, { readonly ok: true }>,
  lookup: ((receiptId: string) => Promise<RepoWriteOperationLookupResult>) | undefined
): Promise<
  | { readonly settled: true }
  | { readonly settled: false; readonly code: string; readonly reason: string; readonly fix: string }
> {
  const settlement = result.settlement;
  if (result.settlementMode === "synchronous-canonical-final/v1"
    || settlement?.canonicalVisibility === "visible") return { settled: true };
  if (settlement?.canonicalVisibility === "failed") {
    return {
      settled: false,
      code: "task_complete_auto_materialization_settlement_failed",
      reason: `${settlement.failure.code}: ${settlement.failure.message}`,
      fix: `Run \`${settlement.statusQuery.command}\` and follow the reported recovery guidance before retrying task completion.`
    };
  }
  if (!settlement || !lookup) {
    return {
      settled: false,
      code: "task_complete_auto_materialization_settlement_unavailable",
      reason: "doc sync returned no proof of canonical settlement",
      fix: docSyncFix()
    };
  }
  let state = "accepted";
  for (let attempt = 0; attempt < settlementPollLimit; attempt += 1) {
    const observed = await lookup(settlement.receiptId);
    state = observed.state;
    if (observed.state === "committed") return { settled: true };
    if (observed.state === "rejected" || observed.state === "settlement-failed"
      || observed.state === "failed" || observed.state === "unknown") {
      return {
        settled: false,
        code: "task_complete_auto_materialization_settlement_failed",
        reason: `doc sync settlement ended in ${observed.state}`,
        fix: `Run \`${settlement.statusQuery.command}\` and repair the reported settlement before retrying task completion.`
      };
    }
    await waitBeforeTaskCompleteSettlementPoll(settlementPollIntervalMs);
  }
  return {
    settled: false,
    code: "task_complete_auto_materialization_settlement_pending",
    reason: `doc sync settlement remained ${state} after ${settlementPollIntervalMs * settlementPollLimit}ms`,
    fix: `Run \`${settlement.statusQuery.command}\` and wait for canonical visibility before retrying task completion.`
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
  const fix = "outcomeUnknown" in result && result.outcomeUnknown
    ? `Run \`${result.outcomeUnknown.statusCommand}\` and resolve the reported write outcome before retrying task completion.`
    : docSyncFix();
  return taskCompleteMaterializationFailure(
    `task_complete_auto_materialization_${result.code}`,
    files,
    result.reason,
    fix,
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

function taskCompleteMaterializationFailure(
  code: string,
  files: ReadonlyArray<TaskCompletePrepublishFailure>,
  reason: string,
  fix = docSyncFix(),
  preserveFileReasons = false
): Extract<TaskCompleteAutoMaterializationResult, { readonly ok: false }> {
  const detailed = files.map((entry) => ({
    ...entry,
    reason: preserveFileReasons ? entry.reason : reason,
    fix
  }));
  return {
    ok: false,
    code,
    hint: failureHint(detailed),
    files: detailed
  };
}

function taskCompleteTaskId(command: DaemonHostCommand): string | undefined {
  const action = command.action as DaemonHostCommand["action"] & { readonly taskId?: unknown };
  return typeof action.taskId === "string" && action.taskId ? action.taskId : undefined;
}

function taskCompletePrepublishFailures(receipt: CommandReceiptEnvelope): ReadonlyArray<TaskCompletePrepublishFailure> {
  if (receipt.ok) return [];
  return taskCompletePrepublishFailuresFromText(`${receipt.summary}\n${receipt.error?.hint ?? ""}`);
}

function taskCompletePrepublishFailuresFromText(text: string): ReadonlyArray<TaskCompletePrepublishFailure> {
  if (!text.includes("AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:")) return [];
  const failures: TaskCompletePrepublishFailure[] = [];
  const pattern = /(tasks\/[^(,\n]+?) \(([^)]+)\)/gu;
  for (const match of text.matchAll(pattern)) {
    const pathValue = match[1]?.trim();
    const reason = match[2]?.trim();
    if (pathValue && reason && !failures.some((entry) => entry.path === pathValue)) {
      failures.push({ path: pathValue, reason });
    }
  }
  return failures;
}

function incompleteMaterializationFailure(
  command: string,
  remaining: ReadonlyArray<TaskCompletePrepublishFailure>
): CommandReceiptEnvelope {
  const fix = docSyncFix();
  const files = remaining.map((entry) => ({ ...entry, fix }));
  return materializationFailureReceipt(command, {
    ok: false,
    code: "task_complete_auto_materialization_incomplete",
    hint: `Task document publication failed to materialize every file after retry. Run \`ha doc status --json\`, repair the named file, then run \`ha doc sync --submit\`. ${failureHint(files)}`,
    files
  });
}

function materializationFailureReceipt(
  command: string,
  failure: Extract<TaskCompleteAutoMaterializationResult, { readonly ok: false }>
): CommandReceiptEnvelope {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command,
    action: "run",
    summary: failure.hint,
    error: { code: failure.code, hint: failure.hint },
    details: {
      data: {
        schema: "task-complete-auto-materialization-failure/v1",
        files: failure.files
      }
    },
    meta: {
      generatedAt: new Date().toISOString(),
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function failureHint(files: ReadonlyArray<TaskCompletePrepublishFailure & { readonly fix: string }>): string {
  return `Task completion could not automatically materialize its document package. ${files.map((entry) =>
    `file=${entry.path}; reason=${entry.reason}; fix=${entry.fix}`
  ).join(" | ")}`;
}

function docSyncFix(): string {
  return "Run `ha doc status --json`, repair the named file, then run `ha doc sync --submit` and retry task completion.";
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function waitBeforeTaskCompleteSettlementPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function taskCompleteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

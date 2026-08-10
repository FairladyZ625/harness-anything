import type {
  CommandReceiptEnvelope,
  DaemonHostCommand,
  TaskHolderExecutor
} from "@harness-anything/application";
import type { CurrentSessionRef } from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";

export interface TaskCompletePrepublishFailure {
  readonly path: string;
  readonly reason: string;
}

export interface TaskCompleteMaterializationFailureFile extends TaskCompletePrepublishFailure {
  readonly fix: string;
  readonly fixArgv: ReadonlyArray<string>;
}

export type TaskCompleteAutoMaterializationResult =
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly code: string;
      readonly hint: string;
      readonly files: ReadonlyArray<TaskCompleteMaterializationFailureFile>;
      readonly reason?: string;
      readonly recovery?: {
        readonly receiptId: string;
        readonly statusCommand: string;
        readonly argv: ReadonlyArray<string>;
      };
    };

export type TaskCompleteAutoMaterializer = (input: {
  readonly taskId: string;
  readonly currentSession: CurrentSessionRef;
  readonly actor: AuthenticatedActor;
  readonly executor: TaskHolderExecutor | null;
  readonly authorityConnection: Extract<AuthorityConnectionDispatch, { readonly available: true }>;
  readonly prepublishFailures: ReadonlyArray<TaskCompletePrepublishFailure>;
}) => Promise<TaskCompleteAutoMaterializationResult>;

export interface TaskCompleteAutoMaterializationDispatchInput {
  readonly repoId: string;
  readonly command: DaemonHostCommand;
  readonly currentSession: CurrentSessionRef;
  readonly actor: AuthenticatedActor;
  readonly executor: TaskHolderExecutor | null;
  readonly authorityConnection: Extract<AuthorityConnectionDispatch, { readonly available: true }>;
  readonly autoMaterialize?: TaskCompleteAutoMaterializer;
  readonly dispatch: () => Promise<CommandReceiptEnvelope>;
}

export async function dispatchTaskCompleteWithAutoMaterialization(
  input: TaskCompleteAutoMaterializationDispatchInput
): Promise<CommandReceiptEnvelope> {
  const taskId = taskCompleteTaskId(input.command);
  const enabled = input.command.action.kind === "task-complete"
    && input.command.action.dryRun !== true
    && input.autoMaterialize !== undefined
    && taskId !== undefined;
  const first = await dispatchTaskCompleteAttempt(input.dispatch);
  if (!enabled) return unwrapTaskCompleteAttempt(first);
  const firstPrepublish = taskCompletePrepublishObservation(first);
  if (!firstPrepublish.matched) return unwrapTaskCompleteAttempt(first);
  return withTaskCompleteMaterializationFlight(`${input.repoId}\0${taskId}`, async () => {
    input.authorityConnection.assertActive();
    const revalidated = await dispatchTaskCompleteAttempt(input.dispatch);
    const prepublish = taskCompletePrepublishObservation(revalidated);
    if (!prepublish.matched) return unwrapTaskCompleteAttempt(revalidated);
    if (!prepublish.valid) {
      return invalidPrepublishDetailsReceipt(input.command.action.kind, prepublish.reason);
    }
    const materialized = await runAutoMaterializer(input, taskId, prepublish.files);
    if (!materialized.ok) {
      if (materialized.code === "task_complete_auto_materialization_no_candidate") {
        input.authorityConnection.assertActive();
        const afterNoCandidate = await dispatchTaskCompleteAttempt(input.dispatch);
        const remaining = taskCompletePrepublishObservation(afterNoCandidate);
        if (!remaining.matched) return unwrapTaskCompleteAttempt(afterNoCandidate);
        if (!remaining.valid) {
          return invalidPrepublishDetailsReceipt(input.command.action.kind, remaining.reason);
        }
        return materializationFailureReceipt(input.command.action.kind,
          materialized.files.length > 0
            ? materialized
            : taskCompleteMaterializationFailure(materialized.code, remaining.files, materialized.hint));
      }
      return materializationFailureReceipt(input.command.action.kind, materialized);
    }
    input.authorityConnection.assertActive();
    const retried = await dispatchTaskCompleteAttempt(input.dispatch);
    const remaining = taskCompletePrepublishObservation(retried);
    if (!remaining.matched) return unwrapTaskCompleteAttempt(retried);
    if (!remaining.valid) {
      return invalidPrepublishDetailsReceipt(input.command.action.kind, remaining.reason);
    }
    return incompleteMaterializationFailure(input.command.action.kind, remaining.files);
  });
}

type TaskCompleteDispatchAttempt =
  | { readonly receipt: CommandReceiptEnvelope }
  | { readonly error: unknown };

type TaskCompletePrepublishObservation =
  | { readonly matched: false }
  | { readonly matched: true; readonly valid: true; readonly files: ReadonlyArray<TaskCompletePrepublishFailure> }
  | { readonly matched: true; readonly valid: false; readonly reason: string };

const taskCompleteMaterializationFlights = new Map<string, Promise<void>>();

async function withTaskCompleteMaterializationFlight<T>(key: string, action: () => Promise<T>): Promise<T> {
  const predecessor = taskCompleteMaterializationFlights.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => owned);
  taskCompleteMaterializationFlights.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (taskCompleteMaterializationFlights.get(key) === tail) {
      taskCompleteMaterializationFlights.delete(key);
    }
  }
}

async function dispatchTaskCompleteAttempt(
  dispatch: () => Promise<CommandReceiptEnvelope>
): Promise<TaskCompleteDispatchAttempt> {
  try {
    return { receipt: await dispatch() };
  } catch (error) {
    return { error };
  }
}

function unwrapTaskCompleteAttempt(attempt: TaskCompleteDispatchAttempt): CommandReceiptEnvelope {
  if ("receipt" in attempt) return attempt.receipt;
  throw attempt.error;
}

async function runAutoMaterializer(
  input: TaskCompleteAutoMaterializationDispatchInput,
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
    const reason = `Unexpected automatic publication failure: ${taskCompleteErrorMessage(error)}`;
    const recovery = orchestrationInternalRecovery();
    return taskCompleteMaterializationFailure(
      "task_complete_auto_materialization_internal",
      failures,
      reason,
      { fix: recovery.fix, argv: recovery.argv }
    );
  }
}

export function taskCompleteMaterializationFailure(
  code: string,
  files: ReadonlyArray<TaskCompletePrepublishFailure>,
  reason: string,
  recovery?: {
    readonly fix: string;
    readonly argv: ReadonlyArray<string>;
    readonly receiptId?: string;
    readonly statusCommand?: string;
  },
  preserveFileReasons = false
): Extract<TaskCompleteAutoMaterializationResult, { readonly ok: false }> {
  const detailed = files.map((entry) => ({
    ...entry,
    reason: preserveFileReasons ? entry.reason : reason,
    ...(recovery
      ? { fix: recovery.fix, fixArgv: recovery.argv }
      : docSyncRecovery(entry.path))
  }));
  return {
    ok: false,
    code,
    hint: failureHint(detailed),
    files: detailed,
    reason,
    ...(recovery?.receiptId && recovery.statusCommand ? {
      recovery: {
        receiptId: recovery.receiptId,
        statusCommand: recovery.statusCommand,
        argv: recovery.argv
      }
    } : {})
  };
}

function taskCompleteTaskId(command: DaemonHostCommand): string | undefined {
  const action = command.action as DaemonHostCommand["action"] & { readonly taskId?: unknown };
  return typeof action.taskId === "string" && action.taskId ? action.taskId : undefined;
}

function taskCompletePrepublishObservation(attempt: TaskCompleteDispatchAttempt): TaskCompletePrepublishObservation {
  const receipt = "receipt" in attempt ? attempt.receipt : undefined;
  if (receipt?.ok) return { matched: false };
  const errorRecord = "error" in attempt && taskCompleteRecord(attempt.error) ? attempt.error : undefined;
  const code = receipt?.error?.code ?? taskCompleteStringField(errorRecord, "code");
  const text = receipt
    ? `${receipt.summary}\n${receipt.error?.hint ?? ""}`
    : taskCompleteErrorMessage("error" in attempt ? attempt.error : "");
  const matched = code === "task_complete_prepublish_not_materialized"
    || text.includes("AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:");
  if (!matched) return { matched: false };
  const structured = receipt?.details?.data
    ?? receipt?.error?.context
    ?? errorRecord?.details;
  const decoded = decodeTaskCompletePrepublishDetails(structured);
  if (decoded) return { matched: true, valid: true, files: decoded };
  const legacy = taskCompletePrepublishFailuresFromText(text);
  if (legacy.length > 0) return { matched: true, valid: true, files: legacy };
  return {
    matched: true,
    valid: false,
    reason: "The structured prepublish details were missing or invalid, and the compatibility text did not contain a parseable file list."
  };
}

function decodeTaskCompletePrepublishDetails(value: unknown): ReadonlyArray<TaskCompletePrepublishFailure> | undefined {
  if (!taskCompleteRecord(value)
    || value.schema !== "task-complete-prepublish-failure/v1"
    || value.code !== "task_complete_prepublish_not_materialized"
    || !Array.isArray(value.files)
    || value.files.length === 0) return undefined;
  const files: TaskCompletePrepublishFailure[] = [];
  for (const entry of value.files) {
    if (!taskCompleteRecord(entry)
      || typeof entry.path !== "string" || entry.path.length === 0
      || typeof entry.reason !== "string" || entry.reason.length === 0) return undefined;
    files.push({ path: entry.path, reason: entry.reason });
  }
  return files;
}

function taskCompletePrepublishFailuresFromText(text: string): ReadonlyArray<TaskCompletePrepublishFailure> {
  const marker = "AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:";
  if (!text.includes(marker)) return [];
  const failures: TaskCompletePrepublishFailure[] = [];
  const reasons = [
    "missing from HEAD",
    "content differs from expected",
    "no canonical publication changed this path to its current content",
    "attributed publication missing from first-parent history"
  ].join("|");
  const pattern = new RegExp(`(?:^|, )(.+?) \\((${reasons})\\)(?=, |\\n|$)`, "gu");
  for (const payload of text.split(marker).slice(1).map((entry) => entry.split("\n", 1)[0] ?? "")) {
    for (const match of payload.matchAll(pattern)) {
      const pathValue = match[1]?.trim();
      const reason = match[2]?.trim();
      if (pathValue && reason && !failures.some((entry) => entry.path === pathValue)) {
        failures.push({ path: pathValue, reason });
      }
    }
  }
  return failures;
}

function incompleteMaterializationFailure(
  command: string,
  remaining: ReadonlyArray<TaskCompletePrepublishFailure>
): CommandReceiptEnvelope {
  return materializationFailureReceipt(command, taskCompleteMaterializationFailure(
    "task_complete_auto_materialization_incomplete",
    remaining,
    "The file remained unpublished after automatic materialization and completion revalidation.",
    undefined,
    true
  ));
}

function invalidPrepublishDetailsReceipt(command: string, reason: string): CommandReceiptEnvelope {
  return materializationFailureReceipt(command, {
    ok: false,
    code: "task_complete_auto_materialization_prepublish_details_invalid",
    hint: `Task completion requires valid structured prepublish failure details. ${reason} Run \`ha daemon logs --json\` and retry task completion after the daemon and writer are on compatible versions.`,
    reason,
    files: []
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
        files: failure.files,
        ...(failure.reason ? { reason: failure.reason } : {}),
        ...(failure.recovery ? { recovery: failure.recovery } : {})
      }
    },
    meta: {
      generatedAt: new Date().toISOString(),
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function failureHint(files: ReadonlyArray<TaskCompleteMaterializationFailureFile>): string {
  return `Task completion could not automatically materialize its document package. ${files.map((entry) =>
    `file=${entry.path}; reason=${entry.reason}; fix=${entry.fix}`
  ).join(" | ")}`;
}

function docSyncRecovery(filePath: string): Pick<TaskCompleteMaterializationFailureFile, "fix" | "fixArgv"> {
  const fixArgv = ["ha", "doc", "sync", "--submit", "--path", filePath];
  return {
    fix: `Run \`${renderShellCommand(fixArgv)}\` after repairing this file, then retry task completion.`,
    fixArgv
  };
}

function orchestrationInternalRecovery() {
  const argv = ["ha", "daemon", "logs", "--json"];
  return {
    argv,
    fix: `Run \`${renderShellCommand(argv)}\` and inspect the internal daemon failure before retrying task completion.`
  };
}

function renderShellCommand(argv: ReadonlyArray<string>): string {
  return argv.map((entry) => /^[A-Za-z0-9_./:-]+$/u.test(entry)
    ? entry
    : `'${entry.replaceAll("'", `'\\''`)}'`
  ).join(" ");
}

function taskCompleteRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskCompleteStringField(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

export function taskCompleteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

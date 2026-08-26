import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import { readRuntimeBatch } from "./cli-runtime-batch-input.ts";
import { runRuntimeFacadeCommand } from "./cli-runtime-command.ts";
import type { RuntimeBatchDeclaration, RuntimeBatchEntry, RuntimeBatchResult } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError, runCommandThroughDaemon } from "./daemon/client.ts";

export async function runRuntimeBatch(
  command: ThinCommand,
  writeActivity: (text: string) => void,
): Promise<JsonObject> {
  let declaration: RuntimeBatchDeclaration;
  try {
    declaration = readRuntimeBatch(command);
  } catch (error) {
    consumeKnownError(error);
    return runtimeRejected(
      "runtime-batch",
      "batch_file_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  return runRuntimeBatchDeclaration(command, declaration, writeActivity);
}

export async function runRuntimeBatchDeclaration(
  command: ThinCommand,
  declaration: RuntimeBatchDeclaration,
  writeActivity: (text: string) => void,
): Promise<JsonObject> {
  const results: RuntimeBatchResult[] = [];
  let next = 0;
  const releasedTaskIds = new Set<string>();
  const reacquisitions = new Map<string, Promise<JsonObject>>();
  const reacquireReleasedTask = async (taskId: string): Promise<JsonObject | null> => {
    if (!releasedTaskIds.has(taskId)) return null;
    let pending = reacquisitions.get(taskId);
    if (!pending) {
      pending = runCommandThroughDaemon({
        ...command,
        method: "repo.task.run",
        action: { kind: "task-start", taskId },
      });
      reacquisitions.set(taskId, pending);
    }
    const receipt = await pending;
    if (reacquisitions.get(taskId) === pending) reacquisitions.delete(taskId);
    if (receipt.ok === true && receipt.outcome === "applied") {
      releasedTaskIds.delete(taskId);
      return null;
    }
    return receipt;
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= declaration.dispatches.length) return;
      const entry = declaration.dispatches[index]!;
      let receipt: JsonObject;
      try {
        const reacquireFailure = entry.task ? await reacquireReleasedTask(entry.task) : null;
        receipt =
          reacquireFailure ??
          (await runRuntimeFacadeCommand(
            {
              ...command,
              method: "repo.agentRuntime.spawn",
              action: runtimeBatchSpawnAction(entry),
            },
            writeActivity,
          ));
      } catch (error) {
        consumeKnownError(error);
        receipt = runtimeRejected(
          "runtime-run",
          "batch_dispatch_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      results[index] = runtimeBatchResult(index, entry, receipt);
      if (entry.task && runtimeBatchTaskDispatchSettled(receipt)) releasedTaskIds.add(entry.task);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(declaration.maxConcurrency, declaration.dispatches.length) }, () => worker()),
  );
  const failed = results.filter((result) => result.status !== "succeeded"),
    unknown = results.some((result) => result.status === "unknown"),
    outcome = failed.length === 0 ? "succeeded" : unknown ? "unknown" : "partial_failure";
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-batch",
    outcome,
    dispatches: results,
    maxConcurrency: declaration.maxConcurrency,
    summary: `runtime-batch: ${results.length - failed.length} succeeded, ${failed.length} failed`,
    exitCode: failed.length ? 1 : 0,
  };
}

export function runtimeBatchTaskDispatchSettled(receipt: JsonObject): boolean {
  if (
    receipt.ok !== true ||
    !["succeeded", "failed", "unknown", "cancelled"].includes(String(receipt.outcome)) ||
    typeof receipt.runtimeSessionId !== "string"
  )
    return false;
  const session = receipt.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return true;
  const attemptChain = (session as Record<string, unknown>).attemptChain;
  if (!attemptChain || typeof attemptChain !== "object" || Array.isArray(attemptChain)) return true;
  const attempts = (attemptChain as Record<string, unknown>).attempts;
  if (!Array.isArray(attempts)) return true;
  const attempt = attempts.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).runtimeSessionId === receipt.runtimeSessionId,
  ) as Record<string, unknown> | undefined;
  return attempt?.fallbackState !== "scheduled" && attempt?.fallbackState !== "dispatched";
}

export function runtimeBatchSpawnAction(entry: RuntimeBatchEntry): ThinCommand["action"] {
  return {
    kind: "runtime-run",
    runtimeInstanceId: entry.instance,
    ...(entry.agent ? { agentId: entry.agent } : {}),
    ...(entry.to ? { targetAgentId: entry.to } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
    ...(entry.prompt ? { prompt: entry.prompt } : { promptFile: entry.promptFile }),
    cwd:
      typeof entry.cwd === "object"
        ? entry.cwd
        : entry.cwd && entry.cwd !== "."
          ? { scope: "repo-relative", path: entry.cwd }
          : { scope: "repo-root" },
    taskId: entry.task ?? null,
    noStream: true,
  };
}

export function runtimeBatchResult(index: number, entry: RuntimeBatchEntry, receipt: JsonObject): RuntimeBatchResult {
  const spawn =
      receipt.spawn && typeof receipt.spawn === "object" ? (receipt.spawn as Record<string, unknown>) : receipt,
    error = receipt.error && typeof receipt.error === "object" ? (receipt.error as Record<string, unknown>) : undefined,
    result =
      receipt.result && typeof receipt.result === "object" ? (receipt.result as Record<string, unknown>) : undefined,
    outcome = typeof receipt.outcome === "string" ? receipt.outcome : null,
    status =
      receipt.ok !== true
        ? "rejected"
        : outcome === "succeeded"
          ? "succeeded"
          : outcome === "unknown"
            ? "unknown"
            : "failed";
  return {
    index,
    instance: entry.instance,
    agent: entry.agent ?? null,
    to: entry.to ?? null,
    status,
    outcome,
    dispatchId: typeof spawn.dispatchId === "string" ? spawn.dispatchId : null,
    runtimeSessionId:
      typeof receipt.runtimeSessionId === "string"
        ? receipt.runtimeSessionId
        : typeof spawn.runtimeSessionId === "string"
          ? spawn.runtimeSessionId
          : null,
    code:
      typeof receipt.code === "string"
        ? receipt.code
        : typeof error?.code === "string"
          ? error.code
          : status === "failed" || status === "unknown"
            ? "runtime_failed"
            : null,
    reason:
      typeof receipt.reason === "string"
        ? receipt.reason
        : typeof error?.hint === "string"
          ? error.hint
          : typeof receipt.nextAction === "string"
            ? receipt.nextAction
            : typeof receipt.summary === "string"
              ? receipt.summary
              : null,
    reportPath: null,
    resultText: typeof result?.text === "string" ? result.text : null,
  };
}

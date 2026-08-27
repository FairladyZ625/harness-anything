import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import { readRuntimeBatch } from "./cli-runtime-batch-input.ts";
import { runRuntimeFacadeCommand } from "./cli-runtime-command.ts";
import type { RuntimeBatchDeclaration, RuntimeBatchEntry, RuntimeBatchResult } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError, runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

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
  const spawn = (entry: RuntimeBatchEntry, idempotencyKey: string): Promise<JsonObject> =>
    runRuntimeFacadeCommand(
      {
        ...command,
        method: "repo.agentRuntime.spawn",
        action: { ...runtimeBatchSpawnAction(entry), idempotencyKey },
      },
      writeActivity,
    );
  // Concurrent task-bound entries share one execution lease, and the first of them to reach a
  // terminal dispatch state releases it. The batch cannot predict when that lands, so a dispatch
  // spawns first and only a runtime_task_lease_required rejection reacquires the lease and
  // resubmits once under the same idempotency key — the rejected spawn wrote no ledger event, so
  // the resubmit is not a duplicate dispatch. The resubmit, not the reacquisition receipt, decides
  // the entry: a lease a sibling worker just reacquired is already the lease this spawn needs, and
  // a lease that stayed out of reach rejects again naming the holder that has to release it.
  const leaseAwareSpawn = async (entry: RuntimeBatchEntry): Promise<JsonObject> => {
    const idempotencyKey = `runtime-batch-${randomUUID()}`,
      first = await spawn(entry, idempotencyKey);
    if (!entry.task || !rejectedWith(first, "runtime_task_lease_required")) return first;
    await runCommandThroughDaemon({
      ...command,
      method: "repo.task.run",
      action: { kind: "task-start", taskId: entry.task },
    });
    return spawn(entry, idempotencyKey);
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= declaration.dispatches.length) return;
      const entry = declaration.dispatches[index]!;
      let receipt: JsonObject;
      try {
        receipt = await leaseAwareSpawn(entry);
      } catch (error) {
        consumeKnownError(error);
        receipt = runtimeRejected(
          "runtime-run",
          "batch_dispatch_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      results[index] = runtimeBatchResult(index, entry, receipt);
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

export function rejectedWith(receipt: JsonObject, code: string): boolean {
  const error = receipt.error && typeof receipt.error === "object" ? (receipt.error as Record<string, unknown>) : null;
  return receipt.ok !== true && (receipt.code === code || error?.code === code);
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

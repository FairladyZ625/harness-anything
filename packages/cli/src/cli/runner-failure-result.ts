import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "@harness-anything/application";
import {
  isIndeterminateFlushControlOutcome,
  type ArtifactStoreError,
  type EngineError,
  type WriteControl
} from "@harness-anything/kernel";
import type { ArtifactStore } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { toCliError } from "./error-mapper.ts";
import { actionTaskId } from "./parse-args.ts";
import { receiptCommandKind } from "./receipt-command-kind.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function commandFailureResult(
  command: ParsedCommand,
  error: ArtifactStoreError | EngineError | WriteControl
): CliResult {
  const base = {
    ok: false as const,
    command: receiptCommandKind(command.action),
    taskId: actionTaskId(command.action)
  };
  if (!isIndeterminateFlushControlOutcome(error)) {
    return { ...base, error: toCliError(error) };
  }
  return {
    ...base,
    report: {
      schema: "write-outcome-indeterminate/v1",
      status: "indeterminate",
      flush: error.report
    },
    error: cliError(
      CliErrorCode.WriteOutcomeIndeterminate,
      `Write outcome is unknown for ${error.report.operationIds.join(",")}. Run 'ha daemon logs --errors --json', compare those IDs with canonical Git state, and do not retry the original write blindly.`,
      { operationIds: error.report.operationIds, cause: error.report.cause }
    )
  };
}

export function commandFailureResultWithDispositionGuidance(
  command: ParsedCommand,
  error: ArtifactStoreError | EngineError | WriteControl,
  artifactStore: Pick<ArtifactStore, "readTaskPackage">
): Effect.Effect<CliResult> {
  const taskId = actionTaskId(command.action);
  const dispositionCommand = command.action.kind === "task-archive" || command.action.kind === "task-delete";
  if (!dispositionCommand
    || !taskId
    || error._tag !== "WriteRejected"
    || error.code !== "task_lease_required"
    || error.context?.taskLeaseHolder !== "none") {
    return Effect.succeed(commandFailureResult(command, error));
  }
  return readTaskLifecyclePolicy(artifactStore, taskId).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.map((policy) => commandFailureResult(command, policy?.status === "planned"
      ? {
          ...error,
          context: {
            ...error.context,
            taskStatus: policy.status,
            taskLeaseRecovery: "dispose"
          }
        }
      : error))
  );
}

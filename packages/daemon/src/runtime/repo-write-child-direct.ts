import type {
  RepoWriteCommandDto,
  RepoWriteParentMessage,
  RepoWriteJsonObject
} from "./repo-write-protocol.ts";
import type { WriteError } from "@harness-anything/kernel";
import { failureReceipt } from "../protocol/receipt-envelope.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { RepoWriteChildResponseWriter } from "./repo-write-child-response-writer.ts";
import type { RepoWriteExecutionSequencer } from "./repo-write-execution-sequencer.ts";
import {
  createRepoWriteTelemetryDelivery,
  reportCurrentRepoWriteTelemetry,
  runWithRepoWriteTelemetry
} from "./repo-write-telemetry-context.ts";

export interface RepoWriteDirectInput {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
}

export interface RepoWriteChildDirectOptions {
  readonly message: Extract<RepoWriteParentMessage, { kind: "direct" }>;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly execute: (input: RepoWriteDirectInput) => unknown | Promise<unknown>;
  readonly responses: RepoWriteChildResponseWriter;
  readonly sequencer: RepoWriteExecutionSequencer;
  readonly requestIds: Set<string>;
  readonly requestIdOwnedByDurableLane: (requestId: string) => boolean;
  readonly admissionOpen: boolean;
  readonly retainedRequestCount: number;
  readonly activeAdmissions: number;
  readonly maxRetainedOperations: number;
  readonly maxAdmissions: number;
  readonly boundaryError?: string;
  readonly admit: () => void;
  readonly release: () => void;
}

export async function executeRepoWriteChildDirect(
  options: RepoWriteChildDirectOptions
): Promise<void> {
  const { message } = options;
  if (options.boundaryError) {
    await options.responses.notStarted(
      message.requestId,
      options.boundaryError,
      "direct request rejected by capsule boundary"
    );
    return;
  }
  if (options.requestIds.has(message.requestId)
    || options.requestIdOwnedByDurableLane(message.requestId)) {
    await options.responses.directUnknown(
      message.requestId,
      "DUPLICATE_REQUEST",
      "volatile direct requestId was already admitted"
    );
    return;
  }
  if (!options.admissionOpen) {
    await options.responses.notStarted(
      message.requestId,
      "ADMISSION_CLOSED",
      "writer admission is closed"
    );
    return;
  }
  if (options.retainedRequestCount >= options.maxRetainedOperations) {
    await options.responses.notStarted(
      message.requestId,
      "RETAINED_HISTORY_FULL",
      "writer request history reached its fail-closed generation bound"
    );
    return;
  }
  if (options.activeAdmissions >= options.maxAdmissions) {
    await options.responses.notStarted(
      message.requestId,
      "ADMISSION_FULL",
      "writer admission limit reached"
    );
    return;
  }

  options.requestIds.add(message.requestId);
  options.admit();
  let telemetry: ReturnType<typeof createRepoWriteTelemetryDelivery> | undefined;
  try {
    await options.responses.telemetry(message.requestId, "queue", 0);
    telemetry = createRepoWriteTelemetryDelivery(
      (phase, elapsedMs, details) =>
        options.responses.telemetry(message.requestId, phase, elapsedMs, details)
    );
    const receipt = await runWithRepoWriteTelemetry(
      telemetry.report,
      () => options.sequencer.run(() => {
        reportCurrentRepoWriteTelemetry("compile");
        return options.execute({
          repoId: options.repoId,
          workspaceId: options.workspaceId,
          generation: options.generation,
          requestId: message.requestId,
          command: message.command
        });
      })
    );
    await telemetry.flush();
    telemetry.close();
    await options.responses.directResult(message.requestId, receipt);
  } catch (error) {
    await telemetry?.flush();
    telemetry?.close();
    if (isExpectedDirectWriteRejection(error)) {
      await options.responses.directResult(
        message.requestId,
        directWriteRejectionReceipt(message.command.commandName, error)
      );
      return;
    }
    await options.responses.directUnknown(
      message.requestId,
      "DIRECT_EXECUTION_OUTCOME_UNKNOWN",
      error
    );
  } finally {
    options.release();
  }
}

function isExpectedDirectWriteRejection(error: unknown): error is Extract<WriteError, { readonly _tag: "WriteRejected" }> {
  return typeof error === "object"
    && error !== null
    && (error as { readonly _tag?: unknown })._tag === "WriteRejected"
    && typeof (error as { readonly reason?: unknown }).reason === "string";
}

function directWriteRejectionReceipt(
  commandName: string,
  error: Extract<WriteError, { readonly _tag: "WriteRejected" }>
): RepoWriteJsonObject {
  const context = jsonObjectForReceipt({
    ...(error.context ?? {}),
    ...(error.taskId ? { taskId: error.taskId } : {})
  });
  return failureReceipt(
    commandName,
    error.code ?? "write_rejected",
    error.reason,
    {},
    context
  ) as unknown as RepoWriteJsonObject;
}

function jsonObjectForReceipt(value: Readonly<Record<string, unknown>>): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

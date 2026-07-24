import type {
  RepoWriteCommandDto,
  RepoWriteParentMessage
} from "./repo-write-protocol.ts";
import type { RepoWriteChildResponseWriter } from "./repo-write-child-response-writer.ts";
import type { RepoWriteExecutionSequencer } from "./repo-write-execution-sequencer.ts";

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
  try {
    const receipt = await options.sequencer.run(() =>
      options.execute({
        repoId: options.repoId,
        workspaceId: options.workspaceId,
        generation: options.generation,
        requestId: message.requestId,
        command: message.command
      })
    );
    await options.responses.directResult(message.requestId, receipt);
  } catch (error) {
    await options.responses.directUnknown(
      message.requestId,
      "DIRECT_EXECUTION_OUTCOME_UNKNOWN",
      error
    );
  } finally {
    options.release();
  }
}

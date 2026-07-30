import type { CliResult } from "../../cli/types.ts";

interface ExecutionSubmitCleanup {
  readonly status: "released" | "retained" | "unknown";
  readonly diagnostics: ReadonlyArray<{
    readonly phase: "release" | "verification";
    readonly message: string;
  }>;
}

export function executionSubmitSuccessResult(input: {
  readonly taskId: string;
  readonly executionId: string;
  readonly leaseReleased: boolean;
  readonly cleanup: ExecutionSubmitCleanup;
  readonly unavailableBindings: ReadonlyArray<unknown>;
}): CliResult {
  return {
    ok: true,
    command: "status-set",
    taskId: input.taskId,
    executionId: input.executionId,
    status: "in_review",
    report: {
      schema: "execution-submit-result/v1",
      executionId: input.executionId,
      leaseReleased: input.leaseReleased,
      cleanup: input.cleanup,
      unavailableBindings: input.unavailableBindings
    },
    ...(input.cleanup.diagnostics.length === 0 ? {} : {
      warnings: input.cleanup.diagnostics.map((diagnostic) => ({
        code: "execution_submit_cleanup_warning",
        phase: diagnostic.phase,
        message: diagnostic.message
      }))
    })
  };
}

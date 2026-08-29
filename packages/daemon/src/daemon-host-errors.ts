import { normalizeDomainError, type WriteReceipt } from "../../kernel/src/index.ts";
import { type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { type RepoTaskAction } from "./repo-cell.ts";

export function rejectHostAction(action: RepoTaskAction, errorCode: string, nextAction: string): WriteReceipt {
  return {
    outcome: "op_rejected",
    opId: `rejected:${action.kind}`,
    code: errorCode,
    origin: "daemon",
    evidence: `rejection:${errorCode}`,
    nextAction,
  };
}

export function rejectPresetRun(runId: string, code: string, nextAction: string) {
  return {
    schema: "preset-run-receipt/v1" as const,
    runId,
    outcome: "op_rejected" as const,
    phase: "op_rejected" as const,
    phases: ["op_rejected"] as const,
    code,
    nextAction,
  };
}

export function hostCodedError(errorCode: string, text: string): Error {
  const error = new Error(text) as Error & { code: string };
  error.code = errorCode;
  return error;
}

export function recoverableRunId(action: RepoTaskAction): string | undefined {
  return action.kind === "preset-run-status" && typeof action.runId === "string" ? action.runId : undefined;
}

export function code(error: unknown): string {
  const normalized = normalizeDomainError(error);
  switch (normalized._tag) {
    case "LeaseConflictError":
    case "TaskNotFoundError":
    case "InvalidWritePlanError":
    case "ProtocolVersionMismatchError":
    case "OtherCodedError":
      return normalized.code;
    case "UnclassifiedError":
      return "daemon_error";
  }
}

export function makeWarmingSettlement(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function daemonErrorMessage(error: unknown): string {
  return normalizeDomainError(error).message;
}

export function attachBudgetError(repoId: string, timeoutMs: number): Error {
  const error = new Error(
    [
      "Repository ",
      `${repoId}`,
      " did not finish attaching within ",
      `${timeoutMs}`,
      "ms; the daemon moved on and keeps the repo unavailable until the attach ",
      "settles or a later probe reopens it.",
    ].join(""),
  ) as Error & { code: string };
  error.code = "repo_attach_timeout";
  return error;
}

export function failedConfigureVerify(
  receipt: RepoBootstrapReceipt,
  repoId: string,
  rootDir: string,
  registryChanged: boolean,
  error: unknown,
  steps: readonly string[],
  failedAt = ["publication-readback", "canonical-layout", "daemon-l2-readiness", "task-bootstrap-dry-run"].find(
    (step) => !steps.includes(step),
  ),
) {
  const hint = `init Configure-Verify smoke failed: ${daemonErrorMessage(error)}`,
    next = `${receipt.next} # Repair the reported config or scaffold error, then rerun init.`;
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: "init",
    repoId,
    rootDir,
    registryChanged,
    ...receipt,
    outcome: "partial",
    summary: hint,
    next,
    code: "configure_verify_failed",
    error: { code: "configure_verify_failed", hint },
    nextAction: next,
    configureVerify: { ok: false, steps, failedAt, causeCode: code(error) },
  };
}

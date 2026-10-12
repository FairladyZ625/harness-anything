import { createHash } from "node:crypto";
import type { WriteSource } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";

export interface PersistedRuntimeExecutionPrincipal {
  readonly personId: string;
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly role: "implementation" | "reviewer";
  readonly reviewDecisionId?: string;
  readonly reviewTaskId?: string;
  readonly source: WriteSource;
  readonly expiresAt: string;
}

export function recordRuntimeExecutionPrincipal(
  rootDir: string,
  repoId: string,
  runtimeSessionId: string,
  credential: string,
  personId: string,
  expiresAt: string,
): void {
  const header = readDispatchStreamHeaders(rootDir).find((entry) => entry.runtimeSessionId === runtimeSessionId);
  if (!header?.taskId || !header.executionId || !header.binding)
    throw new Error(`Task-bound runtime dispatch stream for ${runtimeSessionId} is unavailable.`);
  appendRuntimeWorkerRecord(rootDir, header.dispatchId, {
    kind: "execution_principal",
    grantFingerprint: executionCredentialDigest(credential),
    personId,
    repoId,
    runtimeSessionId,
    dispatchId: header.dispatchId,
    taskId: header.taskId,
    executionId: header.executionId,
    role: header.role === "reviewer" ? "reviewer" : "implementation",
    ...(header.reviewTarget?.kind === "decision" ? { reviewDecisionId: header.reviewTarget.decisionId } : {}),
    ...(header.reviewTarget?.kind === "task" ? { reviewTaskId: header.reviewTarget.taskId } : {}),
    source: header.binding.source,
    expiresAt,
  });
}

export function readRuntimeExecutionPrincipal(
  rootDir: string,
  credential: string,
  now = Date.now(),
): PersistedRuntimeExecutionPrincipal | null {
  const digest = executionCredentialDigest(credential);
  for (const header of readDispatchStreamHeaders(rootDir)) {
    const record = readDispatchStreamSummary(rootDir, header.dispatchId)?.records.find(
      (entry) => entry.kind === "execution_principal" && entry.grantFingerprint === digest,
    );
    if (!record) continue;
    if (!isPersistedPrincipal(record) || Date.parse(record.expiresAt) <= now) return null;
    return record;
  }
  return null;
}

function isPersistedPrincipal(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PersistedRuntimeExecutionPrincipal {
  return (
    typeof value.personId === "string" &&
    typeof value.repoId === "string" &&
    typeof value.runtimeSessionId === "string" &&
    typeof value.dispatchId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.executionId === "string" &&
    (value.role === "implementation" || value.role === "reviewer") &&
    (value.reviewDecisionId === undefined || typeof value.reviewDecisionId === "string") &&
    (value.reviewTaskId === undefined || typeof value.reviewTaskId === "string") &&
    (value.source === "local" || (typeof value.source === "object" && value.source !== null)) &&
    typeof value.expiresAt === "string"
  );
}

function executionCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

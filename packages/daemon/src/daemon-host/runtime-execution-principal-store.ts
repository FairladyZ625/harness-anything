import { createHash } from "node:crypto";
import type { RuntimeExecutionPrincipal } from "./runtime-execution-credential.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";

export type PersistedRuntimeExecutionPrincipal = RuntimeExecutionPrincipal;

export function recordRuntimeExecutionPrincipal(
  rootDir: string,
  repoId: string,
  runtimeSessionId: string,
  credential: string,
  personId: string,
  expiresAt: string,
  surfaces: readonly string[],
): void {
  const header = readDispatchStreamHeaders(rootDir).find((entry) => entry.runtimeSessionId === runtimeSessionId);
  if (!header?.binding) throw new Error(`Runtime dispatch stream for ${runtimeSessionId} is unavailable.`);
  appendRuntimeWorkerRecord(rootDir, header.dispatchId, {
    kind: "execution_principal",
    grantFingerprint: executionCredentialDigest(credential),
    personId,
    repoId,
    runtimeSessionId,
    dispatchId: header.dispatchId,
    taskId: header.taskId,
    executionId: header.executionId ?? null,
    role: header.taskId
      ? header.role === "reviewer"
        ? "reviewer"
        : header.role === "coordinator"
          ? "coordinator"
          : "implementation"
      : header.role === "read-only"
        ? "read-only"
        : "session",
    ...(header.reviewTarget?.kind === "decision" ? { reviewDecisionId: header.reviewTarget.decisionId } : {}),
    ...(header.reviewTarget?.kind === "task" ? { reviewTaskId: header.reviewTarget.taskId } : {}),
    source: header.binding.source,
    surfaces,
    expiresAt,
  });
}

export type RuntimeExecutionPrincipalInspection =
  | { readonly kind: "valid"; readonly principal: PersistedRuntimeExecutionPrincipal }
  | { readonly kind: "expired"; readonly principal: PersistedRuntimeExecutionPrincipal }
  | { readonly kind: "unknown" };

export function inspectRuntimeExecutionPrincipal(
  rootDir: string,
  credential: string,
  now = Date.now(),
): RuntimeExecutionPrincipalInspection {
  const digest = executionCredentialDigest(credential);
  for (const header of readDispatchStreamHeaders(rootDir)) {
    const record = readDispatchStreamSummary(rootDir, header.dispatchId)?.records.find(
      (entry) => entry.kind === "execution_principal" && entry.grantFingerprint === digest,
    );
    if (!record) continue;
    if (!isPersistedPrincipal(record)) return { kind: "unknown" };
    const expiresMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= now) return { kind: "expired", principal: record };
    return { kind: "valid", principal: record };
  }
  return { kind: "unknown" };
}

export function findPersistedRuntimeExecutionPrincipal(
  rootDir: string,
  runtimeSessionId: string,
  dispatchId: string,
): PersistedRuntimeExecutionPrincipal | null {
  const records = readDispatchStreamSummary(rootDir, dispatchId)?.records ?? [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind !== "execution_principal" || !isPersistedPrincipal(record)) continue;
    if (record.runtimeSessionId === runtimeSessionId && record.dispatchId === dispatchId) return record;
  }
  return null;
}

export function readRuntimeExecutionPrincipal(
  rootDir: string,
  credential: string,
  now = Date.now(),
): PersistedRuntimeExecutionPrincipal | null {
  const inspected = inspectRuntimeExecutionPrincipal(rootDir, credential, now);
  return inspected.kind === "valid" ? inspected.principal : null;
}

function isPersistedPrincipal(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PersistedRuntimeExecutionPrincipal {
  return (
    typeof value.personId === "string" &&
    typeof value.repoId === "string" &&
    typeof value.runtimeSessionId === "string" &&
    typeof value.dispatchId === "string" &&
    (value.role === "session" || value.role === "read-only"
      ? value.taskId === null && value.executionId === null
      : (value.role === "implementation" || value.role === "coordinator" || value.role === "reviewer") &&
        typeof value.taskId === "string" &&
        typeof value.executionId === "string") &&
    (value.reviewDecisionId === undefined || typeof value.reviewDecisionId === "string") &&
    (value.reviewTaskId === undefined || typeof value.reviewTaskId === "string") &&
    (value.surfaces === undefined ||
      (Array.isArray(value.surfaces) && value.surfaces.every((surface) => typeof surface === "string"))) &&
    (value.source === "local" || (typeof value.source === "object" && value.source !== null)) &&
    typeof value.expiresAt === "string"
  );
}

function executionCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

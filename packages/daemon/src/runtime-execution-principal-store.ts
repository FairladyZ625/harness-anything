import { createHash } from "node:crypto";
import { validActorPrincipal, type ActorPrincipal, type WriteSource } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";

export interface PersistedRuntimeExecutionPrincipal {
  readonly principal: ActorPrincipal;
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly role: "implementation" | "reviewer";
  readonly source: WriteSource;
  readonly expiresAt: string;
}

export function recordRuntimeExecutionPrincipal(
  rootDir: string,
  repoId: string,
  runtimeSessionId: string,
  credential: string,
  principal: ActorPrincipal,
  expiresAt: string,
): void {
  const header = readDispatchStreamHeaders(rootDir).find((entry) => entry.runtimeSessionId === runtimeSessionId);
  if (!header?.taskId || !header.executionId || !header.binding)
    throw new Error(`Task-bound runtime dispatch stream for ${runtimeSessionId} is unavailable.`);
  appendRuntimeWorkerRecord(rootDir, header.dispatchId, {
    kind: "execution_principal",
    grantFingerprint: executionCredentialDigest(credential),
    principal,
    repoId,
    runtimeSessionId,
    dispatchId: header.dispatchId,
    taskId: header.taskId,
    executionId: header.executionId,
    role: header.role === "reviewer" ? "reviewer" : "implementation",
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
    validActorPrincipal(value.principal) &&
    typeof value.repoId === "string" &&
    typeof value.runtimeSessionId === "string" &&
    typeof value.dispatchId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.executionId === "string" &&
    (value.role === "implementation" || value.role === "reviewer") &&
    (value.source === "local" || (typeof value.source === "object" && value.source !== null)) &&
    typeof value.expiresAt === "string"
  );
}

function executionCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

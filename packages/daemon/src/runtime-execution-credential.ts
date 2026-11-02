import { stableStringify, executionCredentialRejected, type RuntimeExecutionPrincipal } from "@harness-anything/kernel";
import type { KeycloakCenterCredential } from "./transport/auth-context.ts";
export { runtimeExecutionLifetimeMs, executionCredentialRejected } from "@harness-anything/kernel";
export type { RuntimeExecutionPrincipal } from "@harness-anything/kernel";

function executionProvider(center: KeycloakCenterCredential, fetchPort?: typeof fetch) {
  if (fetchPort !== undefined && center.provider.withFetchPort) return center.provider.withFetchPort(fetchPort);
  return center.provider;
}

export function issueRuntimeExecutionCredential(
  center: KeycloakCenterCredential,
  principal: RuntimeExecutionPrincipal,
  fetchPort?: typeof fetch,
): Promise<string> {
  return executionProvider(center, fetchPort).issueExecutionCredential(center.accessToken, principal);
}
export function authenticateRuntimeExecutionCredential(
  center: KeycloakCenterCredential,
  credential: string,
  fetchPort?: typeof fetch,
): Promise<RuntimeExecutionPrincipal> {
  return executionProvider(center, fetchPort)
    .authenticateExecutionCredential(center.accessToken, credential)
    .catch(executionCredentialRecovery);
}
export function readRuntimeExecutionPrincipal(
  center: KeycloakCenterCredential,
  dispatchId: string,
  fetchPort?: typeof fetch,
): Promise<RuntimeExecutionPrincipal> {
  return executionProvider(center, fetchPort)
    .readExecutionPrincipal(center.accessToken, dispatchId)
    .catch(executionCredentialRecovery);
}

function executionCredentialRecovery(error: unknown): never {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "execution_credential_rejected" &&
    error.message === executionCredentialRejected("revoked").message
  )
    error.message +=
      " If the task was submitted, its write lease has ended: ask the CEO to sync the remaining documents " +
      "or return the task for rework. Do not retry document writes with this credential.";
  throw error;
}
/** A queued publication must still match its provider's current execution identity. */
export async function verifyRuntimeExecutionPrincipal(
  center: KeycloakCenterCredential,
  principal: RuntimeExecutionPrincipal,
  fetchPort?: typeof fetch,
): Promise<void> {
  const current = await readRuntimeExecutionPrincipal(center, principal.dispatchId, fetchPort);
  if (stableStringify(current) !== stableStringify(principal)) throw executionCredentialRejected();
}

/** Preserve the existing node-held lease; local workers hold their runtime's agent lease. */
export function runtimeExecutionActor(p: RuntimeExecutionPrincipal) {
  return {
    principal: { personId: p.personId },
    executor:
      p.source !== "local" && p.role === "implementation"
        ? null
        : { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
  };
}

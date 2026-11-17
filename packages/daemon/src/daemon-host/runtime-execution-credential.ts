import {
  stableStringify,
  executionCredentialRejected,
  type AuthorizationProvider,
  type RuntimeExecutionPrincipal,
} from "@harness-anything/kernel";
import { isKeycloakTransportFailure, keycloakUnavailableFailure } from "./keycloak-transport-failure.ts";
export { runtimeExecutionLifetimeMs, executionCredentialRejected } from "@harness-anything/kernel";
export type { RuntimeExecutionPrincipal } from "@harness-anything/kernel";

type RuntimeExecutionCredentialAuthority = {
  readonly provider: AuthorizationProvider;
  readonly accessToken: string;
};

function executionProvider(center: RuntimeExecutionCredentialAuthority, fetchPort?: typeof fetch) {
  if (fetchPort !== undefined && center.provider.withFetchPort) return center.provider.withFetchPort(fetchPort);
  return center.provider;
}

export function issueRuntimeExecutionCredential(
  center: RuntimeExecutionCredentialAuthority,
  principal: RuntimeExecutionPrincipal,
  fetchPort?: typeof fetch,
): Promise<string> {
  return executionProvider(center, fetchPort).issueExecutionCredential(center.accessToken, principal);
}
export function authenticateRuntimeExecutionCredential(
  center: RuntimeExecutionCredentialAuthority,
  credential: string,
  fetchPort?: typeof fetch,
): Promise<RuntimeExecutionPrincipal> {
  return executionProvider(center, fetchPort)
    .authenticateExecutionCredential(center.accessToken, credential)
    .catch(executionCredentialRecovery);
}
/**
 * The runtime credential entry used before any repository action. A cold center token is a
 * pre-execution identity lookup: its transport failure is retryable, unlike an Admin write whose
 * response may already have applied.
 */
export async function authenticateRuntimeExecutionPrincipal(
  center: () => Promise<RuntimeExecutionCredentialAuthority>,
  credential: string,
  fetchPort?: typeof fetch,
): Promise<RuntimeExecutionPrincipal> {
  try {
    return await authenticateRuntimeExecutionCredential(await center(), credential, fetchPort);
  } catch (error) {
    if (!isKeycloakTransportFailure(error)) throw error;
    throw keycloakUnavailableFailure(error, "authenticating the runtime execution credential");
  }
}
export function readRuntimeExecutionPrincipal(
  center: RuntimeExecutionCredentialAuthority,
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
  center: RuntimeExecutionCredentialAuthority,
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

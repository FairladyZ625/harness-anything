import { stableStringify, type WriteSource } from "@harness-anything/kernel";
import { randomBytes } from "node:crypto";
import type { KeycloakCenterCredential } from "./transport/auth-context.ts";

/** One dispatch, twelve hours, no renewal. Keycloak owns both the secret and its revocation. */
export const runtimeExecutionLifetimeMs = 12 * 60 * 60 * 1000;
const clientPrefix = "harness-execution-";

export interface RuntimeExecutionPrincipal {
  readonly personId: string;
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly role: "implementation" | "reviewer";
  readonly source: WriteSource;
  readonly expiresAt: string;
}

export function executionCredentialRejected(): Error {
  return Object.assign(new Error("Execution credential is expired, revoked, or outside its dispatch scope."), {
    code: "execution_credential_rejected",
  });
}

/** The center creates a role-less service account; no person's or center's token leaves the daemon. */
export async function issueRuntimeExecutionCredential(
  center: KeycloakCenterCredential,
  principal: RuntimeExecutionPrincipal,
  fetchPort: typeof fetch = fetch,
): Promise<string> {
  const clientId = `${clientPrefix}${principal.dispatchId}`,
    secret = randomBytes(32).toString("base64url");
  await adminRequest(center, "/clients", fetchPort, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      secret,
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
      defaultClientScopes: [],
      optionalClientScopes: [],
      attributes: { harness_execution: JSON.stringify(principal) },
    }),
  });
  return `${clientId}:${secret}`;
}

/** Authenticate anew on every request. Never accept metadata from the worker or cache a grant. */
export async function authenticateRuntimeExecutionCredential(
  center: KeycloakCenterCredential,
  credential: string,
  fetchPort: typeof fetch = fetch,
): Promise<RuntimeExecutionPrincipal> {
  const match = /^(harness-execution-[A-Za-z0-9._-]+):([A-Za-z0-9_-]{43})$/u.exec(credential);
  if (!match) throw executionCredentialRejected();
  const response = await fetchPort(
    `${center.url}/realms/${encodeURIComponent(center.realm)}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: match[1]!, client_secret: match[2]! }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw executionCredentialRejected();
  // The token proves client authentication; the center reads the authoritative scope separately.
  await response.arrayBuffer();
  return readRuntimeExecutionPrincipal(center, match[1]!, fetchPort);
}

/** A publication queued before revocation must also observe the current Keycloak client. */
export async function verifyRuntimeExecutionPrincipal(
  center: KeycloakCenterCredential,
  principal: RuntimeExecutionPrincipal,
  fetchPort: typeof fetch = fetch,
): Promise<void> {
  const current = await readRuntimeExecutionPrincipal(center, `${clientPrefix}${principal.dispatchId}`, fetchPort);
  if (stableStringify(current) !== stableStringify(principal)) throw executionCredentialRejected();
}

async function readRuntimeExecutionPrincipal(
  center: KeycloakCenterCredential,
  clientId: string,
  fetchPort: typeof fetch,
): Promise<RuntimeExecutionPrincipal> {
  const clients: unknown = await (
    await adminRequest(center, `/clients?clientId=${encodeURIComponent(clientId)}&max=2`, fetchPort)
  ).json();
  if (!Array.isArray(clients) || clients.length !== 1) throw executionCredentialRejected();
  const client = clients[0];
  if (
    client.clientId !== clientId ||
    client.enabled !== true ||
    typeof client.attributes?.harness_execution !== "string"
  )
    throw executionCredentialRejected();
  const principal: unknown = JSON.parse(client.attributes.harness_execution);
  if (!validPrincipal(principal) || `${clientPrefix}${principal.dispatchId}` !== clientId)
    throw executionCredentialRejected();
  return principal;
}

function validPrincipal(value: unknown): value is RuntimeExecutionPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const source = p.source;
  if (
    source !== "local" &&
    (!source ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      !("kind" in source) ||
      source.kind !== "node" ||
      !("nodeId" in source) ||
      typeof source.nodeId !== "string" ||
      !source.nodeId)
  )
    return false;
  return (
    ["personId", "repoId", "runtimeSessionId", "dispatchId", "taskId", "executionId"].every(
      (key) => typeof p[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(p[key]),
    ) &&
    (p.role === "implementation" || p.role === "reviewer") &&
    typeof p.expiresAt === "string" &&
    Date.parse(p.expiresAt) > Date.now() &&
    Date.parse(p.expiresAt) <= Date.now() + runtimeExecutionLifetimeMs
  );
}

async function adminRequest(
  center: KeycloakCenterCredential,
  suffix: string,
  fetchPort: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetchPort(`${center.url}/admin/realms/${encodeURIComponent(center.realm)}${suffix}`, {
    ...init,
    headers: { authorization: `Bearer ${center.accessToken}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw executionCredentialRejected();
  return response;
}

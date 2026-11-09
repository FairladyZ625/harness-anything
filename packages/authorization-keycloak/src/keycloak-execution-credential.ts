import { randomBytes } from "node:crypto";
import {
  executionCredentialRejected,
  runtimeExecutionLifetimeMs,
  type RuntimeExecutionPrincipal,
  type AuthorizationProvider,
} from "@harness-anything/kernel";

interface ExecutionCenter {
  readonly url: string;
  readonly realm: string;
  readonly accessToken: string;
  readonly provider: Pick<AuthorizationProvider, "readNode">;
  /** The policy adapter's one Admin REST boundary, including its 401 refresh policy. */
  readonly request: (path: string, init?: RequestInit, allowNotFound?: boolean) => Promise<Response>;
}
const clientPrefix = "harness-execution-";

/**
 * The execution credential API historically exposed a rejected transport directly. Keep that
 * observable error while the provider owns the request, refresh, and HTTP-status policy.
 */
function executionCredentialRequest(
  center: ExecutionCenter,
  path: string,
  init?: RequestInit,
  allowNotFound?: boolean,
): Promise<Response> {
  return center.request(path, init, allowNotFound).catch((error: unknown) => {
    if (
      error instanceof Error &&
      (error as Error & { readonly code?: unknown }).code === "daemon_error" &&
      error.message.startsWith("Keycloak Admin REST ") &&
      "cause" in error
    )
      throw error.cause;
    throw error;
  });
}

/** The center creates a role-less service account; no person's or center's token leaves the daemon. */
export async function issueRuntimeExecutionCredential(
  center: ExecutionCenter,
  principal: RuntimeExecutionPrincipal,
): Promise<string> {
  const clientId = `${clientPrefix}${principal.dispatchId}`,
    secret = randomBytes(32).toString("base64url");
  await executionCredentialRequest(center, "/clients", {
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
  center: ExecutionCenter,
  credential: string,
  fetchPort: typeof fetch = fetch,
): Promise<RuntimeExecutionPrincipal> {
  const match = /^(harness-execution-[A-Za-z0-9._-]+):([A-Za-z0-9_-]{43})$/u.exec(credential);
  if (!match) throw executionCredentialRejected("authentication");
  const principal = await readRuntimeExecutionPrincipal(center, match[1]!.slice(clientPrefix.length));
  const response = await fetchPort(
    `${center.url}/realms/${encodeURIComponent(center.realm)}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: match[1]!, client_secret: match[2]! }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw executionCredentialRejected("authentication");
  // The token proves client authentication; scope comes from the authoritative client above.
  await response.arrayBuffer();
  return principal;
}

export async function readRuntimeExecutionPrincipal(
  center: ExecutionCenter,
  dispatchId: string,
): Promise<RuntimeExecutionPrincipal> {
  const clientId = `${clientPrefix}${dispatchId}`;
  const clients: unknown = await (
    await executionCredentialRequest(center, `/clients?clientId=${encodeURIComponent(clientId)}&max=2`)
  ).json();
  if (!Array.isArray(clients) || clients.length !== 1) throw executionCredentialRejected("revoked");
  const client = clients[0];
  if (client.enabled !== true) throw executionCredentialRejected("revoked");
  if (client.clientId !== clientId || typeof client.attributes?.harness_execution !== "string")
    throw executionCredentialRejected();
  const principal: unknown = JSON.parse(client.attributes.harness_execution);
  if (!validPrincipal(principal) || `${clientPrefix}${principal.dispatchId}` !== clientId)
    throw executionCredentialRejected();
  if (Date.parse(principal.expiresAt) <= Date.now()) throw executionCredentialRejected("expired");
  if (typeof principal.source === "object" && principal.source.kind === "node") {
    const node = await center.provider.readNode(center.accessToken, principal.source.nodeId);
    if (node?.personId !== principal.personId) throw executionCredentialRejected();
  }
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
    ["personId", "repoId", "runtimeSessionId", "dispatchId"].every(
      (key) => typeof p[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(p[key]),
    ) &&
    (p.role === "implementation" || p.role === "reviewer" || p.role === "read-only" || p.role === "session") &&
    (p.role === "read-only" || p.role === "session"
      ? p.taskId === null && p.executionId === null
      : typeof p.taskId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(p.taskId) &&
        typeof p.executionId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(p.executionId)) &&
    (p.reviewTaskId === undefined || typeof p.reviewTaskId === "string") &&
    (p.surfaces === undefined ||
      (Array.isArray(p.surfaces) && p.surfaces.every((surface) => typeof surface === "string"))) &&
    typeof p.expiresAt === "string" &&
    Date.parse(p.expiresAt) <= Date.now() + runtimeExecutionLifetimeMs
  );
}

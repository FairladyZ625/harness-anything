import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import type { IdentityAuthenticationContext } from "@harness-anything/kernel";

export async function verifyFleetReplica<T extends IdentityAuthenticationContext>(input: {
  readonly auth: T;
  readonly url: string;
  readonly issuerUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly adminAccessToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: number;
  readonly readNode: (nodeId: string) => Promise<
    | {
        readonly personId: string;
        readonly state: string;
        readonly revocation: string;
      }
    | undefined
  >;
}): Promise<(T & IdentityAuthenticationContext) | null> {
  const token = input.auth.humanAccessToken,
    node = input.auth.nodePrincipal;
  if (!token || !node) return null;
  const realmPath = `/realms/${encodeURIComponent(input.realm)}`,
    expectedClientId = `harness-node-${node.nodeId}`,
    reject = () =>
      Object.assign(new Error("The Fleet replica credential was rejected by the identity authority."), {
        code: "fleet_replica_credential_rejected",
      }),
    request = async (url: string, init: RequestInit): Promise<Response> => {
      try {
        return await input.fetch(url, init);
      } catch (cause) {
        throw Object.assign(new Error("Keycloak could not be reached to verify the Fleet replica credential."), {
          code: "daemon_error",
          cause,
        });
      }
    };
  const response = await request(`${input.url}${realmPath}/protocol/openid-connect/token/introspect`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, token }),
  });
  if (!response.ok) return null;
  const claims = (await response.json()) as Record<string, unknown>;
  if (claims.active !== true || claims.azp !== expectedClientId) {
    if (typeof claims.azp === "string" && claims.azp.startsWith("harness-node-")) throw reject();
    return null;
  }
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1_000 : 0;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= input.now ||
    claims.iss !== `${input.issuerUrl}${realmPath}` ||
    ![claims.aud].flat().includes(input.clientId) ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0
  )
    throw reject();
  const clientResponse = await request(
    `${input.url}/admin${realmPath}/clients?clientId=${encodeURIComponent(expectedClientId)}`,
    { redirect: "error", headers: { authorization: `Bearer ${input.adminAccessToken}` } },
  );
  if (!clientResponse.ok) throw reject();
  const clients = (await clientResponse.json()) as readonly {
      readonly id?: unknown;
      readonly clientId?: unknown;
      readonly enabled?: unknown;
      readonly serviceAccountsEnabled?: unknown;
      readonly fullScopeAllowed?: unknown;
    }[],
    client = clients.find((candidate) => candidate.clientId === expectedClientId);
  if (
    typeof client?.id !== "string" ||
    client.id.length === 0 ||
    client.enabled !== true ||
    client.serviceAccountsEnabled !== true ||
    client.fullScopeAllowed !== false
  )
    throw reject();
  // UserRepresentation has no owning-client field; this endpoint binds the subject to this client.
  const userResponse = await request(
    `${input.url}/admin${realmPath}/clients/${encodeURIComponent(client.id)}/service-account-user`,
    {
      redirect: "error",
      headers: { authorization: `Bearer ${input.adminAccessToken}` },
    },
  );
  if (!userResponse.ok) throw reject();
  const user = (await userResponse.json()) as {
    readonly id?: unknown;
    readonly enabled?: boolean;
  };
  if (user.id !== claims.sub || user.enabled !== true) throw reject();
  const current = await input.readNode(node.nodeId).catch((cause: unknown) =>
    Promise.reject(
      Object.assign(new Error("Keycloak could not be reached to verify the Fleet node registration."), {
        code: "daemon_error",
        cause,
      }),
    ),
  );
  if (!current || current.personId !== node.personId || current.state !== "active" || current.revocation !== "complete")
    throw reject();
  return {
    ...input.auth,
    fleetReplicaPrincipal: { nodeId: node.nodeId, personId: current.personId, expiresAt },
  };
}

/** The resource server independently checks a transient human token against its own authority. */
export async function verifyFleetHuman<T extends IdentityAuthenticationContext>(input: {
  readonly auth: T;
  readonly url: string;
  readonly issuerUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly expectedAzps?: readonly { readonly clientId: string; readonly personId?: string }[];
  readonly clientSecret: string;
  readonly adminAccessToken: string;
  readonly fetch: typeof fetch;
  readonly now: number;
}): Promise<T & IdentityAuthenticationContext> {
  const token = input.auth.humanAccessToken;
  const reject = () =>
    Object.assign(new Error("The command requires an active personal Keycloak access token issued for this center."), {
      code: "human_confirmation_required",
    });
  if (!token) throw reject();
  const realmPath = `/realms/${encodeURIComponent(input.realm)}`;
  const response = await input.fetch(`${input.url}${realmPath}/protocol/openid-connect/token/introspect`, {
    method: "POST",
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, token }),
  });
  if (!response.ok) throw reject();
  const claims = (await response.json()) as Record<string, unknown>;
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1_000 : 0;
  if (
    claims.active !== true ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= input.now ||
    claims.iss !== `${input.issuerUrl}${realmPath}` ||
    typeof claims.azp !== "string" ||
    claims.azp.length === 0 ||
    (claims.azp.startsWith("harness-node-") && claims.azp !== `harness-node-${input.auth.nodePrincipal?.nodeId}`) ||
    (input.expectedAzps !== undefined &&
      !input.expectedAzps.some(
        (expected) =>
          claims.azp === expected.clientId &&
          (expected.personId === undefined || claims.harness_person_id === expected.personId),
      )) ||
    ![claims.aud].flat().includes(input.clientId) ||
    typeof claims.sub !== "string" ||
    typeof claims.harness_person_id !== "string" ||
    claims.harness_person_id.length === 0
  )
    throw reject();
  const userResponse = await input.fetch(`${input.url}/admin${realmPath}/users/${encodeURIComponent(claims.sub)}`, {
    headers: { authorization: `Bearer ${input.adminAccessToken}` },
  });
  if (!userResponse.ok) throw reject();
  const user = (await userResponse.json()) as {
    readonly enabled?: boolean;
    readonly serviceAccountClientId?: string;
    readonly attributes?: Readonly<Record<string, readonly string[]>>;
  };
  if (
    user.enabled !== true ||
    user.serviceAccountClientId ||
    user.attributes?.harness_person_id?.[0] !== claims.harness_person_id
  )
    throw reject();
  return {
    ...input.auth,
    oidcPrincipal: {
      provider: new KeycloakPolicyAdapter(
        { url: input.url, realm: input.realm, resourceServerClientId: input.clientId },
        input.fetch,
      ),
      personId: claims.harness_person_id,
      subject: claims.sub,
      azp: claims.azp,
      scopes: typeof claims.scope === "string" ? claims.scope.split(/\s+/u).filter(Boolean) : [],
      expiresAt,
      accessToken: token,
      authority: { url: input.url, realm: input.realm, clientId: input.clientId },
    },
  };
}

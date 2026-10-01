import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

/** The resource server independently checks a transient human token against its own authority. */
export async function verifyFleetHuman(input: {
  readonly auth: DaemonAuthenticationContext;
  readonly url: string;
  readonly issuerUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly adminAccessToken: string;
  readonly fetch: typeof fetch;
  readonly now: number;
}): Promise<DaemonAuthenticationContext> {
  const token = input.auth.humanAccessToken,
    node = input.auth.nodePrincipal;
  if (!token) return input.auth;
  const reject = () =>
    Object.assign(new Error("The command requires the current node owner's active interactive Keycloak session."), {
      code: "human_confirmation_required",
    });
  if (!node) throw reject();
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
    expiresAt <= input.now ||
    claims.iss !== `${input.issuerUrl}${realmPath}` ||
    claims.azp !== `harness-node-${node.nodeId}` ||
    ![claims.aud].flat().includes(input.clientId) ||
    typeof claims.sub !== "string" ||
    claims.harness_person_id !== node.personId
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
  if (user.enabled !== true || user.serviceAccountClientId || user.attributes?.harness_person_id?.[0] !== node.personId)
    throw reject();
  return {
    ...input.auth,
    oidcPrincipal: {
      personId: node.personId,
      subject: claims.sub,
      expiresAt,
      accessToken: token,
      authority: { url: input.url, realm: input.realm, clientId: input.clientId },
    },
  };
}

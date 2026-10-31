import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import type { IdentityAuthenticationContext } from "@harness-anything/kernel";

/** The resource server independently checks a transient human token against its own authority. */
export async function verifyFleetHuman<T extends IdentityAuthenticationContext>(input: {
  readonly auth: T;
  readonly url: string;
  readonly issuerUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly expectedAzps: readonly { readonly clientId: string; readonly personId?: string }[];
  readonly clientSecret: string;
  readonly adminAccessToken: string;
  readonly fetch: typeof fetch;
  readonly now: number;
}): Promise<T & IdentityAuthenticationContext> {
  const token = input.auth.humanAccessToken,
    node = input.auth.nodePrincipal;
  const reject = () =>
    Object.assign(new Error("The command requires the current node owner's active interactive Keycloak session."), {
      code: "human_confirmation_required",
    });
  if (!token || !node) throw reject();
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
    !input.expectedAzps.some(
      (expected) =>
        claims.azp === expected.clientId &&
        (expected.personId === undefined || claims.harness_person_id === expected.personId),
    ) ||
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
    nodePrincipal: { ...node, personId: claims.harness_person_id },
    oidcPrincipal: {
      provider: new KeycloakPolicyAdapter(
        { url: input.url, realm: input.realm, resourceServerClientId: input.clientId },
        input.fetch,
      ),
      personId: claims.harness_person_id,
      subject: claims.sub,
      expiresAt,
      accessToken: token,
      authority: { url: input.url, realm: input.realm, clientId: input.clientId },
    },
  };
}

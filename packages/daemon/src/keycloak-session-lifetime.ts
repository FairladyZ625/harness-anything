/**
 * The session lifetime: how long a signed-in session survives without being used. Keycloak holds
 * the only copy, as the realm's SSO session idle timeout; the daemon reads and writes it there and
 * keeps none of its own. Access tokens stay short-lived and are renewed against this session.
 */
export const sessionLifetimeBounds = Object.freeze({
  defaultSeconds: 6 * 60 * 60,
  // The access token itself lives five minutes; a shorter session would end before its first renewal.
  minimumSeconds: 5 * 60,
  // Keycloak requires an absolute session length. A year never ends a session that is in use.
  maximumSeconds: 365 * 24 * 60 * 60,
});

export interface KeycloakRealmAdmin {
  readonly url: string;
  readonly realm: string;
  readonly accessToken: string;
}

/** The realm fields a session lifetime of `seconds` stands for. */
export function sessionLifetimeRealmSettings(seconds: number): {
  readonly ssoSessionIdleTimeout: number;
  readonly ssoSessionMaxLifespan: number;
} {
  return { ssoSessionIdleTimeout: seconds, ssoSessionMaxLifespan: sessionLifetimeBounds.maximumSeconds };
}

export async function readSessionLifetime(admin: KeycloakRealmAdmin, fetchPort: typeof fetch): Promise<number> {
  return (await readRealm(admin, fetchPort)).ssoSessionIdleTimeout;
}

export async function writeSessionLifetime(
  admin: KeycloakRealmAdmin,
  seconds: number,
  fetchPort: typeof fetch,
): Promise<void> {
  const response = await realmRequest(admin, fetchPort, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionLifetimeRealmSettings(seconds)),
  });
  if (!response.ok) throw rejected(response);
}

/**
 * A realm import only takes effect the first time, so a realm created before the session lifetime
 * existed still runs Keycloak's own half-hour idle timeout. The absolute session length is the
 * witness: only this module sets it, so a realm that lacks it has never been given a session
 * lifetime and receives the default. A realm that carries it keeps whatever lifetime was set.
 */
export async function alignSessionLifetime(admin: KeycloakRealmAdmin, fetchPort: typeof fetch): Promise<void> {
  if ((await readRealm(admin, fetchPort)).ssoSessionMaxLifespan === sessionLifetimeBounds.maximumSeconds) return;
  await writeSessionLifetime(admin, sessionLifetimeBounds.defaultSeconds, fetchPort);
}

async function readRealm(
  admin: KeycloakRealmAdmin,
  fetchPort: typeof fetch,
): Promise<{ readonly ssoSessionIdleTimeout: number; readonly ssoSessionMaxLifespan: number }> {
  const response = await realmRequest(admin, fetchPort, {});
  if (!response.ok) throw rejected(response);
  const realm = (await response.json()) as Record<string, unknown>;
  if (typeof realm.ssoSessionIdleTimeout !== "number" || typeof realm.ssoSessionMaxLifespan !== "number")
    throw Object.assign(new Error("Keycloak did not disclose the realm's session settings to the center."), {
      code: "keycloak_admin_rejected",
    });
  return { ssoSessionIdleTimeout: realm.ssoSessionIdleTimeout, ssoSessionMaxLifespan: realm.ssoSessionMaxLifespan };
}

function realmRequest(admin: KeycloakRealmAdmin, fetchPort: typeof fetch, init: RequestInit): Promise<Response> {
  return fetchPort(`${admin.url}/admin/realms/${encodeURIComponent(admin.realm)}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${admin.accessToken}` },
  });
}

function rejected(response: Response): Error {
  return Object.assign(new Error(`Keycloak Admin REST returned HTTP ${response.status} for the realm settings.`), {
    code: "keycloak_admin_rejected",
  });
}

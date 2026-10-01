import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { managedRbacListenerUrl, managedRbacSessionStore, type ManagedRbacListener } from "./managed-rbac-service.ts";

interface RbacConfig {
  readonly url: string;
  readonly realm: string;
  readonly listener?: ManagedRbacListener;
}

interface PendingLogin {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

interface StoredSession {
  readonly schema: "harness-oidc-session/v2";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly personId: string;
  /** When the access token lapses; a use at or near this moment renews it first. */
  readonly expiresAt: number;
  /** When Keycloak ends the session unless it is used again: one session lifetime after its last renewal. */
  readonly sessionExpiresAt: number;
  readonly roles: readonly string[];
}

/** What one use of the session finds. `unavailable` is set when Keycloak could not be asked to renew it. */
interface SessionUse {
  readonly session: StoredSession | undefined;
  readonly unavailable?: Error;
}

/** A use this close to the access token's end renews it, so the token a request carries outlives the request. */
const renewalMarginMs = 30_000;

export interface OidcSessionPorts {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly randomBytes: typeof randomBytes;
  readonly sessionStore: ReturnType<typeof managedRbacSessionStore>;
}

/**
 * Daemon-owned Authorization Code + PKCE session. Tokens never cross the daemon boundary.
 * The access token stays short-lived; every use renews it with the refresh token, so the session
 * ends only after it sat unused for the realm's session lifetime.
 */
export class OidcSessionService {
  readonly #rbacRoot: string;
  readonly #ports: OidcSessionPorts;
  #pending: PendingLogin | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(userRoot: string, ports: Partial<OidcSessionPorts> = {}) {
    this.#rbacRoot = path.join(userRoot, "rbac");
    this.#ports = { fetch, now: Date.now, randomBytes, sessionStore: managedRbacSessionStore(userRoot), ...ports };
  }

  begin(redirectUri: string): Record<string, unknown> {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname))
      throw coded("oidc_redirect_invalid", "OIDC callback must use a loopback HTTP address.");
    const config = this.#config(),
      verifier = this.#ports.randomBytes(32).toString("base64url"),
      state = this.#ports.randomBytes(24).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    this.#pending = { state, verifier, redirectUri: redirect.toString(), createdAt: this.#ports.now() };
    // Under a listener Keycloak serves its login pages from the listener's hostname, so the browser starts there.
    const authorizationUrl = new URL(
      `${config.listener ? managedRbacListenerUrl(config.listener) : config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/auth`,
    );
    authorizationUrl.search = new URLSearchParams({
      client_id: "harness-gui",
      redirect_uri: redirect.toString(),
      response_type: "code",
      scope: "openid profile email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { ok: true, authorizationUrl: authorizationUrl.toString(), state };
  }

  async complete(code: string, state: string): Promise<Record<string, unknown>> {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending || pending.state !== state || this.#ports.now() - pending.createdAt > 5 * 60_000)
      throw coded("oidc_state_invalid", "OIDC callback state is missing, mismatched, or expired.");
    const config = this.#config(),
      tokenUrl = `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`,
      tokenResponse = await this.#ports.fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "harness-gui",
          code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
        }),
      });
    if (!tokenResponse.ok)
      throw coded("oidc_code_rejected", `Keycloak token exchange returned HTTP ${tokenResponse.status}.`);
    const tokens = (await tokenResponse.json()) as Record<string, unknown>,
      accessToken = requiredString(tokens.access_token, "access_token"),
      userResponse = await this.#ports.fetch(
        `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/userinfo`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
    if (!userResponse.ok)
      throw coded("oidc_identity_rejected", `Keycloak userinfo returned HTTP ${userResponse.status}.`);
    const user = (await userResponse.json()) as Record<string, unknown>,
      subject = requiredString(user.sub, "sub"),
      personId = typeof user.harness_person_id === "string" ? user.harness_person_id : subject;
    this.#writeSession(this.#issued(tokens, { subject, personId }));
    return this.status();
  }

  /** `expiresAt` is when the session ends if it is not used again. */
  async status(): Promise<Record<string, unknown>> {
    const session = await this.#live();
    if (!session) return { ok: true, authenticated: false };
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.sessionExpiresAt };
  }

  /** Queued behind a renewal in flight, so a session that is being renewed stays signed out. */
  logout(): Promise<Record<string, unknown>> {
    this.#pending = undefined;
    return this.serialize(() => {
      this.#ports.sessionStore.delete();
      return Promise.resolve({ ok: true, authenticated: false });
    });
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    const token = await this.#centerToken(),
      members = await this.#adminJson("GET", "/roles/access-admin/users", token, undefined, true);
    return { ok: true, required: !Array.isArray(members) || members.length === 0 };
  }

  /**
   * Binds the signed-in person to a request. While Keycloak cannot be reached to renew the session
   * the request goes unbound: it fails closed, and the operations that bring Keycloak back still run.
   */
  async bind(auth: DaemonAuthenticationContext): Promise<DaemonAuthenticationContext> {
    const { session } = await this.#use();
    if (!session) return auth;
    const config = this.#config();
    return {
      ...auth,
      oidcPrincipal: {
        personId: session.personId,
        subject: session.subject,
        expiresAt: session.expiresAt,
        accessToken: session.accessToken,
        authority: { ...config, clientId: "harness-center" },
      },
    };
  }

  async requireRole(role: string): Promise<StoredSession> {
    const session = await this.#live();
    if (!session) throw coded("authentication_required", "Sign in with Keycloak first.");
    if (!session.roles.includes(role)) throw coded("authorization_denied", `Keycloak role ${role} is required.`);
    return session;
  }

  /**
   * The center's single write queue for Keycloak authorization state: first-administrator bootstrap
   * and every policy-group or grant mutation run one at a time, each against the state the previous left.
   * Session renewals share it, so concurrent uses of one session renew it once.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(operation);
    this.#writes = run.catch(consumeKnownError);
    return run;
  }

  async center(): Promise<{ readonly url: string; readonly realm: string; readonly accessToken: string }> {
    return { ...this.#config(), accessToken: await this.#centerToken() };
  }

  bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const token = await this.#centerToken(),
        members = await this.#adminJson("GET", "/roles/access-admin/users", token, undefined, true);
      if (Array.isArray(members) && members.length > 0)
        throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");
      await this.#ensureAccessAdminRole(token);
      const userId = await this.#createUser(token, input, false),
        role = await this.#adminJson("GET", "/roles/access-admin", token);
      await this.#adminJson("POST", `/users/${encodeURIComponent(userId)}/role-mappings/realm`, token, [role]);
      await this.#removeBootstrapAdministrator(token);
      return { ok: true, created: true, personId: input.personId };
    });
  }

  async invite(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireRole("access-admin");
    const token = await this.#centerToken(),
      userId = await this.#createUser(token, input, true);
    await this.#adminJson("PUT", `/users/${encodeURIComponent(userId)}/execute-actions-email`, token, [
      "UPDATE_PASSWORD",
    ]);
    return { ok: true, invited: true, personId: input.personId };
  }

  async #centerToken(): Promise<string> {
    const config = this.#config(),
      secretFile = path.join(this.#rbacRoot, "center-client-secret");
    if (!existsSync(secretFile))
      throw coded("rbac_admin_unavailable", "Keycloak center credentials are not configured.");
    const response = await this.#ports.fetch(
      `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "harness-center",
          client_secret: readFileSync(secretFile, "utf8").trim(),
        }),
      },
    );
    if (!response.ok)
      throw coded("rbac_admin_unavailable", `Keycloak service authentication returned HTTP ${response.status}.`);
    return requiredString(((await response.json()) as Record<string, unknown>).access_token, "access_token");
  }

  async #ensureAccessAdminRole(token: string): Promise<void> {
    const existing = await this.#adminJson("GET", "/roles/access-admin", token, undefined, true);
    if (existing !== undefined) return;
    await this.#adminJson("POST", "/roles", token, {
      name: "access-admin",
      description: "Harness account administrator",
    });
  }

  async #createUser(
    token: string,
    input: {
      readonly username: string;
      readonly email: string;
      readonly displayName: string;
      readonly personId: string;
      readonly password?: string;
    },
    invitation: boolean,
  ): Promise<string> {
    const [firstName, ...rest] = input.displayName.trim().split(/\s+/u),
      response = await this.#adminFetch("POST", "/users", token, {
        username: input.username,
        email: input.email,
        firstName,
        lastName: rest.join(" "),
        enabled: true,
        emailVerified: false,
        attributes: { harness_person_id: [input.personId] },
        requiredActions: invitation ? ["VERIFY_EMAIL", "UPDATE_PASSWORD"] : [],
        ...(input.password ? { credentials: [{ type: "password", value: input.password, temporary: false }] } : {}),
      });
    if (!response.ok)
      throw coded("account_create_rejected", `Keycloak user creation returned HTTP ${response.status}.`);
    const location = response.headers.get("location"),
      userId = location?.split("/").pop();
    if (!userId) throw coded("account_create_rejected", "Keycloak user creation omitted the user location.");
    return userId;
  }

  async #removeBootstrapAdministrator(token: string): Promise<void> {
    const users = await this.#adminJson("GET", "/users?username=harness-bootstrap&exact=true", token);
    if (!Array.isArray(users)) return;
    for (const user of users) {
      if (user && typeof user === "object" && typeof (user as Record<string, unknown>).id === "string")
        await this.#adminJson(
          "DELETE",
          `/users/${encodeURIComponent(String((user as Record<string, unknown>).id))}`,
          token,
        );
    }
    this.#ports.sessionStore.retireBootstrap();
  }

  async #adminJson(
    method: string,
    suffix: string,
    token: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<unknown> {
    const response = await this.#adminFetch(method, suffix, token, body);
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) throw coded("keycloak_admin_rejected", `Keycloak Admin REST returned HTTP ${response.status}.`);
    if (response.status === 204 || response.headers.get("content-length") === "0") return undefined;
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }

  #adminFetch(method: string, suffix: string, token: string, body?: unknown): Promise<Response> {
    const config = this.#config();
    return this.#ports.fetch(`${config.url}/admin/realms/${encodeURIComponent(config.realm)}${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  #config(): RbacConfig {
    const file = path.join(this.#rbacRoot, "config.json");
    if (!existsSync(file)) throw coded("rbac_not_configured", "Run ha bootstrap before signing in.");
    return JSON.parse(readFileSync(file, "utf8")) as RbacConfig;
  }

  /** The signed-in session holding a usable access token; fails when Keycloak could not be asked to renew it. */
  async #live(): Promise<StoredSession | undefined> {
    const { session, unavailable } = await this.#use();
    if (unavailable) throw unavailable;
    return session;
  }

  /** A use near or past the access token's end renews the session first. */
  async #use(): Promise<SessionUse> {
    const session = this.#session();
    if (!session || !this.#lapsing(session)) return { session };
    return this.serialize(async () => {
      // Uses that queued behind a renewal find the session it wrote and do not renew again.
      const current = this.#session();
      return current && this.#lapsing(current) ? this.#renew(current) : { session: current };
    });
  }

  #lapsing(session: StoredSession): boolean {
    return session.expiresAt - this.#ports.now() <= renewalMarginMs;
  }

  /** One refresh grant per use: Keycloak refusing it ends the session here, and nothing retries. */
  async #renew(session: StoredSession): Promise<SessionUse> {
    const config = this.#config(),
      response = await this.#ports
        .fetch(`${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "harness-gui",
            refresh_token: session.refreshToken,
          }),
        })
        .catch((error: unknown) => unavailable("Keycloak could not be reached to renew the session.", error));
    if (response instanceof Error) return { session: undefined, unavailable: response };
    // Keycloak answers 400 once the session sat idle past its lifetime, was signed out, or had its token revoked.
    if (response.status === 400) {
      this.#ports.sessionStore.delete();
      return { session: undefined };
    }
    if (!response.ok)
      return {
        session: undefined,
        unavailable: unavailable(`Keycloak session renewal returned HTTP ${response.status}.`),
      };
    const renewed = this.#issued((await response.json()) as Record<string, unknown>, session);
    this.#writeSession(renewed);
    return { session: renewed };
  }

  #issued(
    tokens: Record<string, unknown>,
    identity: { readonly subject: string; readonly personId: string },
  ): StoredSession {
    const accessToken = requiredString(tokens.access_token, "access_token"),
      now = this.#ports.now();
    return {
      schema: "harness-oidc-session/v2",
      accessToken,
      refreshToken: requiredString(tokens.refresh_token, "refresh_token"),
      subject: identity.subject,
      personId: identity.personId,
      expiresAt: now + requiredNumber(tokens.expires_in, "expires_in") * 1_000,
      sessionExpiresAt: now + requiredNumber(tokens.refresh_expires_in, "refresh_expires_in") * 1_000,
      roles: realmRoles(decodeJwtPayload(accessToken)),
    };
  }

  #session(): StoredSession | undefined {
    const value = this.#ports.sessionStore.read();
    return value === undefined ? undefined : (JSON.parse(value) as StoredSession);
  }
  #writeSession(session: StoredSession): void {
    this.#ports.sessionStore.write(`${JSON.stringify(session)}\n`);
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw coded("oidc_token_invalid", "Keycloak returned an invalid access token.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}
function realmRoles(claims: Record<string, unknown>): readonly string[] {
  const access = claims.realm_access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return [];
  const roles = (access as Record<string, unknown>).roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw coded("oidc_response_invalid", `Keycloak omitted ${field}.`);
  return value;
}
function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw coded("oidc_response_invalid", `Keycloak omitted ${field}.`);
  return value;
}
function unavailable(message: string, cause?: unknown): Error {
  return Object.assign(coded("oidc_session_unavailable", message), cause === undefined ? {} : { cause });
}
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

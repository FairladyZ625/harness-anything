import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { managedRbacListenerUrl, managedRbacSessionStore, type ManagedRbacListener } from "./managed-rbac-service.ts";
import { verifyFleetHuman } from "./oidc-fleet-principal.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { readFleetLoginAuthorityClient } from "./fleet/edge.ts";

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
  readonly authority: OidcLoginAuthority;
  readonly loginTarget?: string;
}

export interface OidcLoginAuthority {
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly browserUrl?: string;
}

interface PendingDeviceLogin {
  readonly authority: OidcLoginAuthority;
  readonly loginTarget?: string;
  readonly deviceCode: string;
  readonly verifier: string;
  readonly expiresAt: number;
  interval: number;
  nextPollAt: number;
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
  readonly loginTarget?: string;
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
  readonly loginAuthority?: (target: string) => Promise<OidcLoginAuthority>;
}

/**
 * Daemon-owned PKCE and Device session. Refresh tokens stay here; a short-lived access token may
 * accompany a fleet request as transient authentication metadata.
 * The access token stays short-lived; every use renews it with the refresh token, so the session
 * ends only after it sat unused for the realm's session lifetime.
 */
export class OidcSessionService {
  readonly #rbacRoot: string;
  readonly #ports: OidcSessionPorts;
  #pending: PendingLogin | undefined;
  #device: PendingDeviceLogin | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(userRoot: string, ports: Partial<OidcSessionPorts> = {}) {
    this.#rbacRoot = path.join(userRoot, "rbac");
    this.#ports = { fetch, now: Date.now, randomBytes, sessionStore: managedRbacSessionStore(userRoot), ...ports };
  }

  async begin(redirectUri: string, loginTarget?: string): Promise<Record<string, unknown>> {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname))
      throw coded("oidc_redirect_invalid", "OIDC callback must use a loopback HTTP address.");
    const authority = await this.#loginAuthority(loginTarget),
      verifier = this.#ports.randomBytes(32).toString("base64url"),
      state = this.#ports.randomBytes(24).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    this.#pending = {
      state,
      verifier,
      redirectUri: redirect.toString(),
      createdAt: this.#ports.now(),
      authority,
      ...(loginTarget ? { loginTarget } : {}),
    };
    // Under a listener Keycloak serves its login pages from the listener's hostname, so the browser starts there.
    const authorizationUrl = new URL(
      `${authority.browserUrl ?? authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/auth`,
    );
    authorizationUrl.search = new URLSearchParams({
      client_id: authority.clientId,
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
    const authority = pending.authority,
      tokenUrl = `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/token`,
      tokenResponse = await this.#ports.fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          ...clientFields(authority),
          code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
        }),
      });
    if (!tokenResponse.ok)
      throw coded("oidc_code_rejected", `Keycloak token exchange returned HTTP ${tokenResponse.status}.`);
    return this.#acceptTokens((await tokenResponse.json()) as Record<string, unknown>, authority, pending.loginTarget);
  }

  async beginDevice(loginTarget?: string): Promise<Record<string, unknown>> {
    const authority = await this.#loginAuthority(loginTarget),
      verifier = this.#ports.randomBytes(32).toString("base64url"),
      response = await this.#ports.fetch(
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/auth/device`,
        {
          method: "POST",
          body: new URLSearchParams({
            ...clientFields(authority),
            scope: "openid profile email",
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }),
        },
      );
    if (!response.ok)
      throw coded("oidc_device_rejected", `Keycloak device authorization returned HTTP ${response.status}.`);
    const device = (await response.json()) as Record<string, unknown>,
      interval = requiredNumber(device.interval, "interval"),
      expiresAt = this.#ports.now() + requiredNumber(device.expires_in, "expires_in") * 1_000;
    this.#device = {
      authority,
      deviceCode: requiredString(device.device_code, "device_code"),
      verifier,
      interval,
      expiresAt,
      nextPollAt: this.#ports.now() + interval * 1_000,
      ...(loginTarget ? { loginTarget } : {}),
    };
    return {
      ok: true,
      pending: true,
      verificationUri: requiredString(device.verification_uri, "verification_uri"),
      userCode: requiredString(device.user_code, "user_code"),
      interval,
      expiresAt,
    };
  }

  pollDevice(): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const pending = this.#device;
      if (!pending) throw coded("oidc_device_missing", "Start device login first.");
      if (this.#ports.now() >= pending.expiresAt) {
        this.#device = undefined;
        throw coded("oidc_device_expired", "Device authorization expired; start login again.");
      }
      if (this.#ports.now() < pending.nextPollAt) return { ok: true, pending: true, interval: pending.interval };
      const response = await this.#ports.fetch(
        `${pending.authority.url}/realms/${encodeURIComponent(pending.authority.realm)}/protocol/openid-connect/token`,
        {
          method: "POST",
          body: new URLSearchParams({
            ...clientFields(pending.authority),
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: pending.deviceCode,
            code_verifier: pending.verifier,
          }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        if (result.error === "authorization_pending" || result.error === "slow_down") {
          if (result.error === "slow_down") pending.interval += 5;
          pending.nextPollAt = this.#ports.now() + pending.interval * 1_000;
          return { ok: true, pending: true, interval: pending.interval };
        }
        this.#device = undefined;
        throw coded("oidc_device_rejected", `Device authorization ended: ${String(result.error)}.`);
      }
      this.#device = undefined;
      return this.#acceptTokens(result, pending.authority, pending.loginTarget);
    });
  }

  async #acceptTokens(
    tokens: Record<string, unknown>,
    authority: OidcLoginAuthority,
    loginTarget?: string,
  ): Promise<Record<string, unknown>> {
    const accessToken = requiredString(tokens.access_token, "access_token"),
      userResponse = await this.#ports.fetch(
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/userinfo`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
    if (!userResponse.ok)
      throw coded("oidc_identity_rejected", `Keycloak userinfo returned HTTP ${userResponse.status}.`);
    const user = (await userResponse.json()) as Record<string, unknown>,
      subject = requiredString(user.sub, "sub"),
      personId = typeof user.harness_person_id === "string" ? user.harness_person_id : subject;
    const session = this.#issued(tokens, { subject, personId, ...(loginTarget ? { loginTarget } : {}) });
    this.#writeSession(session);
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.sessionExpiresAt };
  }

  /** `expiresAt` is when the session ends if it is not used again. */
  async status(): Promise<Record<string, unknown>> {
    const session = await this.#live();
    if (!session) return { ok: true, authenticated: false };
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.sessionExpiresAt };
  }

  /** Read the selected edge's public authority, independently of this daemon's signed-in session. */
  async bindingHealth(loginTarget: string): Promise<Record<string, unknown>> {
    const authority = await this.#loginAuthority(loginTarget),
      response = await this.#ports.fetch(`${authority.url}/realms/${encodeURIComponent(authority.realm)}`);
    return {
      source: "fleet-center",
      mode: "external",
      ready: response.ok,
      url: authority.url,
      realm: authority.realm,
      clientId: authority.clientId,
      status: response.status,
    };
  }

  /** Queued behind a renewal in flight, so a session that is being renewed stays signed out. */
  logout(): Promise<Record<string, unknown>> {
    this.#pending = undefined;
    this.#device = undefined;
    return this.serialize(async () => {
      const session = this.#session();
      this.#ports.sessionStore.delete();
      if (session) {
        const authority = await this.#loginAuthority(session.loginTarget),
          response = await this.#ports.fetch(
            `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/revoke`,
            {
              method: "POST",
              body: new URLSearchParams({
                ...clientFields(authority),
                token: session.refreshToken,
                token_type_hint: "refresh_token",
              }),
            },
          );
        if (!response.ok)
          throw coded(
            "oidc_logout_rejected",
            `Local session cleared; Keycloak revocation returned HTTP ${response.status}.`,
          );
      }
      return { ok: true, authenticated: false };
    });
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return { ok: true, required: await this.#bootstrapRequired(await this.#centerToken()) };
  }

  /**
   * Binds the signed-in person to a request. While Keycloak cannot be reached to renew the session
   * the request goes unbound: it fails closed, and the operations that bring Keycloak back still run.
   */
  async bind(auth: DaemonAuthenticationContext): Promise<DaemonAuthenticationContext> {
    if (auth.transportKind === "fleet-tls") {
      if (!auth.humanAccessToken) return auth;
      const config = this.#config();
      return verifyFleetHuman({
        auth,
        url: config.url,
        issuerUrl: config.listener ? managedRbacListenerUrl(config.listener) : config.url,
        realm: config.realm,
        clientId: "harness-center",
        clientSecret: readFileSync(path.join(this.#rbacRoot, "center-client-secret"), "utf8").trim(),
        adminAccessToken: await this.#centerToken(),
        fetch: this.#ports.fetch,
        now: this.#ports.now(),
      });
    }
    const { session } = await this.#use();
    if (!session) return auth;
    const authority = await this.#loginAuthority(session.loginTarget);
    return {
      ...auth,
      oidcPrincipal: {
        personId: session.personId,
        subject: session.subject,
        expiresAt: session.expiresAt,
        accessToken: session.accessToken,
        authority: { url: authority.url, realm: authority.realm, clientId: "harness-center" },
      },
    };
  }

  /** Public metadata comes from the center; an edge never writes a second Keycloak configuration. */
  discovery(nodeId: string): OidcLoginAuthority | null {
    const config = this.#config(),
      url = config.listener ? managedRbacListenerUrl(config.listener) : config.url;
    if (new URL(url).protocol !== "https:") return null;
    return { url, realm: config.realm, clientId: `harness-node-${nodeId}` };
  }

  async requireRole(role: string): Promise<StoredSession> {
    return this.#requireRole(role, await this.#live());
  }

  #requireRole(role: string, session: StoredSession | undefined): StoredSession {
    if (!session) throw coded("authentication_required", "Sign in with Keycloak first.");
    if (!session.roles.includes(role)) throw coded("authorization_denied", `Keycloak role ${role} is required.`);
    return session;
  }

  /**
   * The center's single write queue for Keycloak authorization state: first-administrator bootstrap, listener changes
   * and every policy-group or grant mutation run one at a time, each against the state the previous left.
   * Session renewals share it, so concurrent uses of one session renew it once.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(operation);
    this.#writes = run.catch(consumeKnownError);
    return run;
  }

  /** D1: original-socket configuration is open until the first administrator exists. */
  configureAuthority<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (
        existsSync(path.join(this.#rbacRoot, "config.json")) &&
        !(await this.#bootstrapRequired(await this.#centerToken()))
      ) {
        // Already in the write queue: renew directly rather than enqueueing behind ourselves.
        const { session, unavailable } = await this.#useCurrent();
        if (unavailable) throw unavailable;
        this.#requireRole("access-admin", session);
      }
      return operation();
    });
  }

  async #bootstrapRequired(token: string): Promise<boolean> {
    const members = await this.#adminJson("GET", "/roles/access-admin/users", token, undefined, true);
    if (members === undefined) return true;
    if (!Array.isArray(members))
      throw coded("oidc_response_invalid", "Keycloak returned invalid administrator membership.");
    return members.length === 0;
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
      const token = await this.#centerToken();
      if (!(await this.#bootstrapRequired(token)))
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

  async #loginAuthority(target?: string): Promise<OidcLoginAuthority> {
    if (target && this.#ports.loginAuthority) return this.#ports.loginAuthority(target);
    const edge = target ? readFleetEdgeConfig(target) : null;
    if (edge) {
      const authority = await readFleetLoginAuthorityClient({
        hostname: edge.host,
        port: edge.port,
        ca: readFileSync(edge.caPath),
        servername: edge.servername,
        nodeId: edge.nodeId,
        credential: edge.credential,
        assignmentId: edge.assignmentId,
      });
      return { ...authority, clientSecret: edge.credential };
    }
    const config = this.#config();
    return {
      url: config.url,
      realm: config.realm,
      clientId: "harness-gui",
      ...(config.listener ? { browserUrl: managedRbacListenerUrl(config.listener) } : {}),
    };
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
      return this.#useCurrent();
    });
  }

  async #useCurrent(): Promise<SessionUse> {
    const current = this.#session();
    return current && this.#lapsing(current) ? this.#renew(current) : { session: current };
  }

  #lapsing(session: StoredSession): boolean {
    return session.expiresAt - this.#ports.now() <= renewalMarginMs;
  }

  /** One refresh grant per use: Keycloak refusing it ends the session here, and nothing retries. */
  async #renew(session: StoredSession): Promise<SessionUse> {
    const authority = await this.#loginAuthority(session.loginTarget),
      response = await this.#ports
        .fetch(`${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            ...clientFields(authority),
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
    identity: { readonly subject: string; readonly personId: string; readonly loginTarget?: string },
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
      ...(identity.loginTarget ? { loginTarget: identity.loginTarget } : {}),
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

function clientFields(authority: OidcLoginAuthority): Record<string, string> {
  return {
    client_id: authority.clientId,
    ...(authority.clientSecret ? { client_secret: authority.clientSecret } : {}),
  };
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

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { managedRbacSessionStore } from "./managed-rbac-service.ts";

interface RbacConfig {
  readonly url: string;
  readonly realm: string;
}

interface PendingLogin {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

interface StoredSession {
  readonly schema: "harness-oidc-session/v1";
  readonly accessToken: string;
  readonly subject: string;
  readonly personId: string;
  readonly expiresAt: number;
  readonly roles: readonly string[];
}

export interface OidcSessionPorts {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly randomBytes: typeof randomBytes;
  readonly sessionStore: ReturnType<typeof managedRbacSessionStore>;
}

/** Daemon-owned Authorization Code + PKCE session. Tokens never cross the daemon boundary. */
export class OidcSessionService {
  readonly #rbacRoot: string;
  readonly #ports: OidcSessionPorts;
  #pending: PendingLogin | undefined;

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
    const authorizationUrl = new URL(
      `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/auth`,
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
      expiresIn = requiredNumber(tokens.expires_in, "expires_in"),
      userResponse = await this.#ports.fetch(
        `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/userinfo`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
    if (!userResponse.ok)
      throw coded("oidc_identity_rejected", `Keycloak userinfo returned HTTP ${userResponse.status}.`);
    const user = (await userResponse.json()) as Record<string, unknown>,
      subject = requiredString(user.sub, "sub"),
      personId = typeof user.harness_person_id === "string" ? user.harness_person_id : subject,
      claims = decodeJwtPayload(accessToken),
      session: StoredSession = {
        schema: "harness-oidc-session/v1",
        accessToken,
        subject,
        personId,
        expiresAt: this.#ports.now() + expiresIn * 1_000,
        roles: realmRoles(claims),
      };
    this.#writeSession(session);
    return this.status();
  }

  status(): Record<string, unknown> {
    const session = this.#session();
    if (!session || session.expiresAt <= this.#ports.now()) return { ok: true, authenticated: false };
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.expiresAt };
  }

  logout(): Record<string, unknown> {
    this.#ports.sessionStore.delete();
    this.#pending = undefined;
    return { ok: true, authenticated: false };
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    const token = await this.#centerToken(),
      members = await this.#adminJson("GET", "/roles/access-admin/users", token, undefined, true);
    return { ok: true, required: !Array.isArray(members) || members.length === 0 };
  }

  bind(auth: DaemonAuthenticationContext): DaemonAuthenticationContext {
    const session = this.#session();
    if (!session || session.expiresAt <= this.#ports.now()) return auth;
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

  requireRole(role: string): StoredSession {
    const session = this.#session();
    if (!session || session.expiresAt <= this.#ports.now())
      throw coded("authentication_required", "Sign in with Keycloak first.");
    if (!session.roles.includes(role)) throw coded("authorization_denied", `Keycloak role ${role} is required.`);
    return session;
  }

  async bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
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
  }

  async invite(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    this.requireRole("access-admin");
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
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

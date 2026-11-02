import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type AuthorizationProvider,
  type IdentityAuthenticationContext,
  type IdentitySessionPort,
  type OidcLoginAuthority,
  type StoredSession,
} from "@harness-anything/kernel";
import { BuiltinPolicyAdapter } from "./builtin-policy-adapter.ts";
import {
  builtinAuthorityUrl,
  ensureBuiltinConfig,
  findSession,
  opaqueToken,
  readState,
  sessionFile,
  type BuiltinUser,
} from "./state.ts";
import { identityPluginRequired } from "./collaboration.ts";

type Pending = {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly expiresAt: number;
  approvedPersonId?: string;
};
type BrowserCode = { readonly state: string; readonly user: BuiltinUser; readonly expiresAt: number };
type LoginResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};
type SessionFileResult =
  | { readonly kind: "present"; readonly session: StoredSession }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly error: unknown };
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export class BuiltinIdentitySession implements IdentitySessionPort {
  readonly #root: string;
  readonly #writes: { current: Promise<unknown> } = { current: Promise.resolve() };
  readonly #adapter: BuiltinPolicyAdapter;
  readonly #external?: IdentitySessionPort;
  readonly #pending = new Map<string, Pending>();
  readonly #browserCodes = new Map<string, BrowserCode>();
  #currentDeviceCode: string | undefined;
  #loginServer: Server | undefined;
  #loginPort: number | undefined;
  #loginRedirectUri: string | undefined;
  #centerToken: string | undefined;
  #sessionGeneration = 0;
  #loginState: string | undefined;
  constructor(
    userRoot: string,
    readArtifactActionScopes?: () => Promise<readonly string[]>,
    external?: IdentitySessionPort,
  ) {
    this.#root = userRoot;
    this.#adapter = new BuiltinPolicyAdapter({ userRoot, readArtifactActionScopes });
    this.#external = external;
  }
  async begin(redirectUri: string, loginTarget?: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.begin(redirectUri, loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
      return Promise.reject(coded("oidc_redirect_invalid", "OIDC callback must use a loopback HTTP address."));
    const state = opaqueToken("state");
    this.#loginState = state;
    this.#loginRedirectUri = redirectUri;
    return {
      ok: true,
      authorizationUrl: `${await this.#loginPageUrl("login", state)}&state=${encodeURIComponent(state)}`,
      state,
    };
  }
  async complete(code: string, state: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession();
    if (external) return external.complete(code, state);
    return this.serialize(async () => {
      if (!this.#loginState || state !== this.#loginState)
        throw coded("oidc_state_invalid", "Login callback state is missing, mismatched, or expired.");
      const pending = this.#browserCodes.get(code);
      if (!pending || pending.state !== state || pending.expiresAt <= Date.now()) {
        this.#browserCodes.delete(code);
        throw coded("oidc_identity_rejected", "Built-in account credentials were rejected.");
      }
      this.#browserCodes.delete(code);
      const user = pending.user;
      this.#loginState = undefined;
      await this.#closeLoginServer();
      this.#loginRedirectUri = undefined;
      return this.#acceptUser(user);
    });
  }
  async beginDevice(
    loginTarget?: string,
    _authorityOverride?: OidcLoginAuthority,
    expiresAtLimit?: number,
  ): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.beginDevice(loginTarget, _authorityOverride, expiresAtLimit);
    this.#assertLocalLoginTarget(loginTarget);
    const now = Date.now(),
      expiresAt = Math.min(now + 10 * 60_000, expiresAtLimit ?? Number.POSITIVE_INFINITY),
      userCode = randomCode(),
      deviceCode = opaqueToken("device");
    if (this.#currentDeviceCode) this.#pending.delete(this.#currentDeviceCode);
    this.#currentDeviceCode = deviceCode;
    this.#pending.set(deviceCode, { userCode, deviceCode, expiresAt });
    const verificationUri = await this.#loginPageUrl("device", userCode);
    return { ok: true, pending: true, verificationUri, userCode, interval: 1, expiresAt };
  }
  async deviceApproval(userCode: string, loginTarget?: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.deviceApproval(userCode, loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    const pending = [...this.#pending.values()].find((item) => item.userCode === userCode);
    if (!pending) throw coded("oidc_device_missing", "Unknown or expired built-in device code.");
    const user = this.#adapter.owner();
    if (!user) throw coded("bootstrap_admin_required", "Create the first built-in administrator before signing in.");
    const authorizationUrl = await this.#loginPageUrl("device", userCode);
    void user;
    return { ok: true, pending: true, approved: false, authorizationUrl };
  }
  async pollDevice(): Promise<Record<string, unknown>> {
    const external = this.#externalSession();
    if (external) return external.pollDevice();
    return this.serialize(async () => {
      const pending = this.#currentDeviceCode ? this.#pending.get(this.#currentDeviceCode) : undefined;
      if (!pending) throw coded("oidc_device_missing", "Start device login first.");
      if (pending.expiresAt <= Date.now()) {
        this.#pending.delete(pending.deviceCode);
        this.#currentDeviceCode = undefined;
        throw coded("oidc_device_expired", "Device authorization expired; start login again.");
      }
      if (!pending.approvedPersonId) return { ok: true, pending: true, interval: 1 };
      const user = this.#adapter.owner();
      this.#pending.delete(pending.deviceCode);
      this.#currentDeviceCode = undefined;
      if (!user) throw coded("oidc_identity_rejected", "Built-in account no longer exists.");
      return this.#acceptUser(user);
    });
  }
  async status(loginTarget?: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.status(loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    const session = this.#readSession();
    if (!session) return { ok: true, authenticated: false };
    return {
      ok: true,
      authenticated: true,
      personId: session.personId,
      expiresAt: session.sessionExpiresAt,
    };
  }
  async bindingHealth(loginTarget: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.bindingHealth(loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    return this.health();
  }
  logout(loginTarget?: string): Promise<Record<string, unknown>> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.logout(loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    ++this.#sessionGeneration;
    return this.serialize(async () => {
      const session = this.#readSession();
      if (session) this.#adapter.removeSession(session.accessToken);
      this.#deleteSession();
      return { ok: true, authenticated: false };
    });
  }
  async bootstrapStatus(): Promise<Record<string, unknown>> {
    const external = this.#externalSession();
    if (external) return external.bootstrapStatus();
    return { ok: true, required: !this.#adapter.owner() };
  }
  async interactiveAuthority(): Promise<{ readonly url: string; readonly realm: string; readonly clientId: string }> {
    const external = this.#externalSession();
    if (external) return external.interactiveAuthority();
    this.requireCollaboration();
    return { url: "builtin://local", realm: "local", clientId: "harness-center" };
  }
  configured(): boolean {
    const external = this.#externalSession();
    if (external) return external.configured();
    ensureBuiltinConfig(this.#root);
    return true;
  }
  centerConfigured(): boolean {
    const external = this.#externalSession();
    if (external) return external.centerConfigured();
    return this.configured();
  }
  requireCollaboration(): void {
    const external = this.#externalSession();
    if (external) return external.requireCollaboration();
    throw identityPluginRequired();
  }
  async bind<T extends IdentityAuthenticationContext>(
    auth: T,
    loginTarget?: string,
    replicaRead = false,
  ): Promise<T & IdentityAuthenticationContext> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.bind(auth, loginTarget, replicaRead);
    this.#assertLocalLoginTarget(loginTarget);
    const session = this.#readSession();
    if (!session) return auth;
    if (
      session.expiresAt <= Date.now() ||
      (session.sessionExpiresAt !== null && session.sessionExpiresAt <= Date.now())
    ) {
      this.#deleteSession();
      return auth;
    }
    const provider = this.#provider(),
      generation = this.#sessionGeneration;
    if (replicaRead)
      return {
        ...auth,
        replicaReadPrincipal: { personId: session.personId, sessionExpiresAt: session.sessionExpiresAt },
      };
    return {
      ...auth,
      localSessionAccessToken: async () => {
        const current = this.#readSession();
        if (!current || generation !== this.#sessionGeneration || current.subject !== session.subject)
          throw coded("authentication_required", "The originally bound built-in session has ended.");
        return current.accessToken;
      },
      oidcPrincipal: {
        provider,
        personId: session.personId,
        subject: session.subject,
        expiresAt: session.expiresAt,
        accessToken: session.accessToken,
        authority: { url: builtinAuthorityUrl(this.#root), realm: "local", clientId: "harness-center" },
      },
    };
  }
  discovery(_nodeId: string): OidcLoginAuthority | null {
    const external = this.#externalSession();
    if (external) return external.discovery(_nodeId);
    return null;
  }
  async requireRole(role: string, loginTarget?: string): Promise<StoredSession> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.requireRole(role, loginTarget);
    const session = await this.requireSession(loginTarget);
    if (!session.roles.includes(role)) throw coded("authorization_denied", `Built-in role ${role} is required.`);
    return session;
  }
  async requireSession(loginTarget?: string): Promise<StoredSession> {
    const external = this.#externalSession(loginTarget);
    if (external) return external.requireSession(loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    const session = this.#readSession();
    if (!session) throw coded("authentication_required", "Sign in with the built-in identity provider first.");
    return session;
  }
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const external = this.#externalSession();
    if (external) return external.serialize(operation);
    const run = this.#writes.current.then(operation);
    this.#writes.current = Promise.allSettled([run]).then(() => undefined);
    return run;
  }
  configureAuthority<T>(operation: () => Promise<T>, loginTarget?: string): Promise<T> {
    const external = this.#externalSession();
    if (external) return external.configureAuthority(operation, loginTarget);
    this.#assertLocalLoginTarget(loginTarget);
    return this.serialize(async () => {
      if (this.#adapter.owner()) this.#requireOwnerSession();
      else ensureBuiltinConfig(this.#root);
      return operation();
    });
  }
  async center(): Promise<{
    readonly url: string;
    readonly realm: string;
    readonly accessToken: string;
    readonly provider: AuthorizationProvider;
  }> {
    const external = this.#externalSession();
    if (external) return external.center();
    ensureBuiltinConfig(this.#root);
    const accessToken = this.#centerToken ?? this.#adapter.issueCenterToken();
    this.#centerToken = accessToken;
    return { url: builtinAuthorityUrl(this.#root), realm: "local", accessToken, provider: this.#adapter };
  }

  bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    const external = this.#externalSession();
    if (external) return external.bootstrapAdmin(input);
    return this.serialize(async () => {
      ensureBuiltinConfig(this.#root);
      if (this.#adapter.owner())
        throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");
      this.#adapter.addUser(input);
      return { ok: true, created: true, personId: input.personId };
    });
  }
  async invite(
    input: {
      readonly username: string;
      readonly email: string;
      readonly displayName: string;
      readonly personId: string;
    },
    _withinWriter = false,
    _loginTarget?: string,
  ): Promise<Record<string, unknown>> {
    const external = this.#externalSession();
    if (external) return external.invite(input, _withinWriter, _loginTarget);
    void input;
    throw identityPluginRequired();
  }
  async revokeDeviceSessions(nodeId: string): Promise<void> {
    const external = this.#externalSession();
    if (external?.revokeDeviceSessions) return external.revokeDeviceSessions(nodeId);
    throw identityPluginRequired();
  }
  receiveDeviceNotice(
    nodeId: string,
    personId: string,
    notice: import("@harness-anything/kernel").FleetDeviceLoginNotice,
  ): void {
    const external = this.#externalSession();
    if (external?.receiveDeviceNotice) return external.receiveDeviceNotice(nodeId, personId, notice);
    throw identityPluginRequired();
  }
  #provider(): BuiltinPolicyAdapter {
    return this.#adapter;
  }
  #externalSession(loginTarget?: string): IdentitySessionPort | undefined {
    if (!this.#external) return undefined;
    if (loginTarget && existsSync(path.join(loginTarget, "fleet-edge.json"))) return this.#external;
    const file = path.join(this.#root, "rbac", "config.json");
    if (!existsSync(file)) return undefined;
    const config = JSON.parse(readFileSync(file, "utf8")) as { readonly mode?: unknown };
    return config.mode === "builtin" || config.mode === undefined ? undefined : this.#external;
  }
  #assertLocalLoginTarget(loginTarget?: string): void {
    if (loginTarget && existsSync(path.join(loginTarget, "fleet-edge.json"))) throw identityPluginRequired();
  }
  async #loginPageUrl(kind: "login" | "device", value: string): Promise<string> {
    if (!this.#loginServer) {
      const server = createServer((request, response) => {
        void this.#serveLoginPage(request, response).then(undefined, () => {
          if (!response.headersSent)
            response.writeHead(500, { "content-type": "text/plain" }).end("Built-in sign-in failed.");
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      server.unref();
      this.#loginServer = server;
      this.#loginPort = (server.address() as AddressInfo).port;
    }
    return `http://127.0.0.1:${this.#loginPort}/${kind}?value=${encodeURIComponent(value)}`;
  }
  async #serveLoginPage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const result = await this.#loginResponse(request);
    response.writeHead(result.status, result.headers).end(result.body);
  }
  async #loginResponse(request: IncomingMessage): Promise<LoginResponse> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && (url.pathname === "/login" || url.pathname === "/device")) {
      const field = url.pathname === "/device" ? "userCode" : "state";
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: `<!doctype html><title>Harness sign in</title><form method="post" action="/${url.pathname.slice(1)}"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><input type="hidden" name="${field}" value="${escapeHtml(url.searchParams.get("value") ?? "")}"><button>Sign in</button></form>`,
      };
    }
    if (request.method !== "POST" || (url.pathname !== "/login" && url.pathname !== "/device")) return { status: 404 };
    const body = await readRequestBody(request),
      form = new URLSearchParams(body),
      user = this.#adapter.userByUsername(form.get("username") ?? ""),
      password = form.get("password");
    if (!user || password === null || !this.#adapter.verifyPassword(user, password)) {
      return {
        status: 401,
        headers: { "content-type": "text/plain" },
        body: "Built-in account credentials were rejected.",
      };
    }
    if (url.pathname === "/device") {
      const pending = [...this.#pending.values()].find((item) => item.userCode === form.get("userCode"));
      if (!pending) return { status: 404, body: "Unknown or expired device code." };
      this.#pending.set(pending.deviceCode, { ...pending, approvedPersonId: user.personId });
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "Device approved. Return to Harness.",
      };
    }
    const state = form.get("state"),
      redirect = this.#loginRedirectUri;
    if (!state || !redirect || state !== this.#loginState) return { status: 400, body: "Login state expired." };
    const callback = new URL(redirect),
      code = opaqueToken("builtin-code");
    this.#browserCodes.set(code, { state, user, expiresAt: Date.now() + 120_000 });
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return { status: 302, headers: { location: callback.toString() } };
  }
  async #closeLoginServer(): Promise<void> {
    const server = this.#loginServer;
    this.#loginServer = undefined;
    this.#loginPort = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  #readSession(): StoredSession | undefined {
    const file = sessionFile(this.#root);
    if (!existsSync(file)) return undefined;
    const result = this.#readSessionFile(file);
    if (result.kind === "invalid") throw result.error;
    return result.kind === "present" ? result.session : undefined;
  }
  #requireOwnerSession(): StoredSession {
    const owner = this.#adapter.owner(),
      session = this.#readSession();
    if (!owner || !session || session.personId !== owner.personId || !session.roles.includes("access-admin"))
      throw coded("authentication_required", "Sign in as the built-in owner before changing identity authority.");
    return session;
  }
  #readSessionFile(file: string): SessionFileResult {
    const parsed = parseSessionFile(readFileSync(file, "utf8"));
    if (parsed.kind === "invalid") return parsed;
    const value = parsed.value;
    if (!isStoredSession(value))
      return {
        kind: "invalid",
        error: coded("rbac_session_invalid", "The built-in session file has an unsupported format."),
      };
    return value.accessToken && findSession(readState(this.#root), value.accessToken)
      ? { kind: "present", session: value }
      : { kind: "absent" };
  }
  #deleteSession(): void {
    const file = sessionFile(this.#root);
    if (existsSync(file)) unlinkSync(file);
  }
  #acceptUser(user: BuiltinUser): Record<string, unknown> {
    const session = this.#mintSession(user);
    const file = sessionFile(this.#root),
      directory = path.dirname(file),
      temporary = `${file}.${process.pid}.tmp`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.sessionExpiresAt };
  }

  #mintSession(user: BuiltinUser): StoredSession {
    const now = Date.now(),
      accessToken = opaqueToken("builtin-session"),
      sessionExpiresAt = now + readState(this.#root).sessionLifetimeSeconds * 1_000,
      session: StoredSession = {
        schema: "harness-oidc-session/v3",
        issuer: builtinAuthorityUrl(this.#root),
        accessToken,
        refreshToken: opaqueToken("builtin-refresh"),
        subject: `builtin-subject-${user.userId}`,
        personId: user.personId,
        expiresAt: sessionExpiresAt,
        sessionExpiresAt,
        roles: ["access-admin"],
        authority: { url: builtinAuthorityUrl(this.#root), realm: "local", clientId: "harness-center" },
      };
    this.#adapter.registerSession(accessToken, {
      personId: session.personId,
      subject: session.subject,
      expiresAt: session.expiresAt,
      sessionExpiresAt,
      roles: session.roles,
    });
    return session;
  }
  health(): Record<string, unknown> {
    return {
      ok: true,
      ready: true,
      mode: "builtin",
      url: builtinAuthorityUrl(this.#root),
      realm: "local",
      clientId: "harness-center",
    };
  }
}
function randomCode(): string {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}
function parseSessionFile(
  text: string,
): { readonly kind: "parsed"; readonly value: unknown } | { readonly kind: "invalid"; readonly error: unknown } {
  try {
    return { kind: "parsed", value: JSON.parse(text) as unknown };
  } catch (error) {
    return { kind: "invalid", error };
  }
}
function isStoredSession(value: unknown): value is StoredSession {
  if (value === null || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    session.schema === "harness-oidc-session/v3" &&
    typeof session.issuer === "string" &&
    typeof session.accessToken === "string" &&
    typeof session.refreshToken === "string" &&
    typeof session.subject === "string" &&
    typeof session.personId === "string" &&
    typeof session.expiresAt === "number" &&
    (session.sessionExpiresAt === null || typeof session.sessionExpiresAt === "number") &&
    Array.isArray(session.roles) &&
    session.roles.every((role) => typeof role === "string")
  );
}
async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw coded("oidc_callback_invalid", "Built-in sign-in form is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

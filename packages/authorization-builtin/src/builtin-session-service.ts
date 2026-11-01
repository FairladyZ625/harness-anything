import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  consumeKnownError,
  type AuthorizationProvider,
  type DeviceLoginRequest,
  type FleetDeviceLoginNotice,
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

type Pending = {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly expiresAt: number;
  approvedPersonId?: string;
};
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export class BuiltinIdentitySession implements IdentitySessionPort {
  readonly #root: string;
  readonly #writes: { current: Promise<unknown> } = { current: Promise.resolve() };
  readonly #adapter: BuiltinPolicyAdapter;
  readonly #pending = new Map<string, Pending>();
  readonly #devices = new Map<string, DeviceLoginRequest>();
  #loginServer: Server | undefined;
  #loginPort: number | undefined;
  #loginRedirectUri: string | undefined;
  #centerToken: string | undefined;
  #sessionGeneration = 0;
  #loginState: string | undefined;
  constructor(userRoot: string) {
    this.#root = userRoot;
    this.#adapter = new BuiltinPolicyAdapter({ userRoot });
  }
  async begin(redirectUri: string): Promise<Record<string, unknown>> {
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
    return this.serialize(async () => {
      if (!this.#loginState || state !== this.#loginState)
        throw coded("oidc_state_invalid", "Login callback state is missing, mismatched, or expired.");
      const [username, password] = code.split(":", 2),
        user = this.#adapter.userByUsername(username ?? "");
      if (!user || password === undefined || !this.#adapter.verifyPassword(user, password))
        throw coded("oidc_identity_rejected", "Built-in account credentials were rejected.");
      this.#loginState = undefined;
      await this.#closeLoginServer();
      this.#loginRedirectUri = undefined;
      return this.#acceptUser(user);
    });
  }
  async beginDevice(
    _loginTarget?: string,
    _authorityOverride?: OidcLoginAuthority,
    expiresAtLimit?: number,
  ): Promise<Record<string, unknown>> {
    const now = Date.now(),
      expiresAt = Math.min(now + 10 * 60_000, expiresAtLimit ?? Number.POSITIVE_INFINITY),
      userCode = randomCode(),
      deviceCode = opaqueToken("device");
    this.#pending.set(deviceCode, { userCode, deviceCode, expiresAt });
    const verificationUri = await this.#loginPageUrl("device", userCode);
    return { ok: true, pending: true, verificationUri, userCode, interval: 1, expiresAt };
  }
  revokeDeviceSessions(_nodeId: string): Promise<void> {
    return Promise.resolve();
  }
  receiveDeviceNotice(nodeId: string, personId: string, notice: FleetDeviceLoginNotice): void {
    const key = `${nodeId}:${notice.userCode}`;
    if (notice.pending)
      this.#devices.set(key, {
        nodeId,
        personId,
        ...notice,
        verificationUriComplete: `builtin://login?user_code=${encodeURIComponent(notice.userCode)}`,
      });
    else this.#devices.delete(key);
  }
  async deviceApproval(userCode: string): Promise<Record<string, unknown>> {
    const pending = [...this.#pending.values()].find((item) => item.userCode === userCode);
    if (!pending) throw coded("oidc_device_missing", "Unknown or expired built-in device code.");
    const user = this.#adapter.users().find((item) => item.roles.includes("access-admin")) ?? this.#adapter.users()[0];
    if (!user) throw coded("bootstrap_admin_required", "Create the first built-in administrator before signing in.");
    this.#pending.set(pending.deviceCode, { ...pending, approvedPersonId: user.personId });
    return {
      ok: true,
      approved: true,
      personId: user.personId,
      authorizationUrl: await this.#loginPageUrl("device", userCode),
    };
  }
  async pollDevice(): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const pending = [...this.#pending.values()][0];
      if (!pending) throw coded("oidc_device_missing", "Start device login first.");
      if (pending.expiresAt <= Date.now()) {
        this.#pending.delete(pending.deviceCode);
        throw coded("oidc_device_expired", "Device authorization expired; start login again.");
      }
      if (!pending.approvedPersonId) return { ok: true, pending: true, interval: 1 };
      const user = this.#adapter.users().find((item) => item.personId === pending.approvedPersonId);
      this.#pending.delete(pending.deviceCode);
      if (!user) throw coded("oidc_identity_rejected", "Built-in account no longer exists.");
      return this.#acceptUser(user);
    });
  }
  async status(): Promise<Record<string, unknown>> {
    const session = this.#readSession();
    if (!session) return { ok: true, authenticated: false };
    return {
      ok: true,
      authenticated: true,
      personId: session.personId,
      expiresAt: session.sessionExpiresAt,
      deviceLoginRequests: [...this.#devices.values()].filter((item) => item.personId === session.personId),
    };
  }
  async bindingHealth(_loginTarget: string): Promise<Record<string, unknown>> {
    return this.health();
  }
  logout(): Promise<Record<string, unknown>> {
    ++this.#sessionGeneration;
    return this.serialize(async () => {
      const session = this.#readSession();
      if (session) this.#adapter.removeSession(session.accessToken);
      this.#deleteSession();
      return { ok: true, authenticated: false };
    });
  }
  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return { ok: true, required: this.#adapter.users().length === 0 };
  }
  async interactiveAuthority(): Promise<{ readonly url: string; readonly realm: string; readonly clientId: string }> {
    ensureBuiltinConfig(this.#root);
    // The invitation carries public provider metadata.  The center's local
    // filesystem path is never placed in a link sent to an edge node.
    return { url: "builtin://local", realm: "local", clientId: "harness-center" };
  }
  configured(): boolean {
    ensureBuiltinConfig(this.#root);
    return true;
  }
  centerConfigured(): boolean {
    return this.configured();
  }
  async bind<T extends IdentityAuthenticationContext>(
    auth: T,
    _loginTarget?: string,
    replicaRead = false,
  ): Promise<T & IdentityAuthenticationContext> {
    const fleetToken = auth.transportKind === "fleet-tls" ? auth.humanAccessToken : undefined,
      session = fleetToken ? this.#readFleetSession(fleetToken) : this.#readSession();
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
        const current = fleetToken ? this.#readFleetSession(fleetToken) : this.#readSession();
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
  discovery(nodeId: string): OidcLoginAuthority {
    return { url: "builtin://local", realm: "local", clientId: `harness-node-${nodeId}` };
  }
  async requireRole(role: string): Promise<StoredSession> {
    const session = await this.requireSession();
    if (!session.roles.includes(role)) throw coded("authorization_denied", `Built-in role ${role} is required.`);
    return session;
  }
  async requireSession(): Promise<StoredSession> {
    const session = this.#readSession();
    if (!session) throw coded("authentication_required", "Sign in with the built-in identity provider first.");
    return session;
  }
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writes.current.then(operation);
    this.#writes.current = run.catch((error) => {
      consumeKnownError(error);
    });
    return run;
  }
  configureAuthority<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      ensureBuiltinConfig(this.#root);
      return operation();
    });
  }
  async center(): Promise<{
    readonly url: string;
    readonly realm: string;
    readonly accessToken: string;
    readonly provider: AuthorizationProvider;
  }> {
    ensureBuiltinConfig(this.#root);
    const accessToken = this.#centerToken ?? this.#adapter.issueCenterToken();
    this.#centerToken = accessToken;
    return { url: builtinAuthorityUrl(this.#root), realm: "local", accessToken, provider: this.#adapter };
  }

  async issueInvitationSession(personId: string, withinWriter = false): Promise<StoredSession> {
    const issue = async () => {
      const user = this.#adapter.users().find((candidate) => candidate.personId === personId);
      if (!user) throw coded("access_person_unknown", `Built-in account ${personId} does not exist.`);
      return this.#mintSession(user);
    };
    return withinWriter ? issue() : this.serialize(issue);
  }

  async importSession(session: StoredSession, withinWriter = false): Promise<void> {
    const importIt = async () => {
      if (!session.accessToken || !session.personId || session.sessionExpiresAt === null)
        throw coded("authentication_required", "The center returned an incomplete built-in session.");
      const file = sessionFile(this.#root),
        directory = path.dirname(file),
        temporary = `${file}.${process.pid}.tmp`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
      this.#adapter.registerSession(session.accessToken, {
        personId: session.personId,
        subject: session.subject,
        expiresAt: session.expiresAt,
        sessionExpiresAt: session.sessionExpiresAt,
        roles: session.roles,
      });
    };
    if (withinWriter) await importIt();
    else await this.serialize(importIt);
  }
  bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      ensureBuiltinConfig(this.#root);
      if (this.#adapter.users().length)
        throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");
      this.#adapter.addUser({ ...input, roles: ["access-admin"] });
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
    withinWriter = false,
  ): Promise<Record<string, unknown>> {
    const invite = async () => {
      await this.requireRole("access-admin");
      const temporary = opaqueToken("invite");
      this.#adapter.addUser({ ...input, password: temporary });
      return { ok: true, invited: true, personId: input.personId };
    };
    return withinWriter ? invite() : this.serialize(invite);
  }
  #provider(): BuiltinPolicyAdapter {
    return this.#adapter;
  }
  async #loginPageUrl(kind: "login" | "device", value: string): Promise<string> {
    if (!this.#loginServer) {
      const server = createServer((request, response) => {
        void this.#serveLoginPage(request, response);
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
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && (url.pathname === "/login" || url.pathname === "/device")) {
        const field = url.pathname === "/device" ? "userCode" : "state";
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end(
            `<!doctype html><title>Harness sign in</title><form method="post" action="/${url.pathname.slice(1)}"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><input type="hidden" name="${field}" value="${escapeHtml(url.searchParams.get("value") ?? "")}"><button>Sign in</button></form>`,
          );
        return;
      }
      if (request.method !== "POST" || (url.pathname !== "/login" && url.pathname !== "/device")) {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestBody(request),
        form = new URLSearchParams(body),
        user = this.#adapter.userByUsername(form.get("username") ?? ""),
        password = form.get("password");
      if (!user || password === null || !this.#adapter.verifyPassword(user, password)) {
        response.writeHead(401, { "content-type": "text/plain" }).end("Built-in account credentials were rejected.");
        return;
      }
      if (url.pathname === "/device") {
        const pending = [...this.#pending.values()].find((item) => item.userCode === form.get("userCode"));
        if (!pending) {
          response.writeHead(404).end("Unknown or expired device code.");
          return;
        }
        this.#pending.set(pending.deviceCode, { ...pending, approvedPersonId: user.personId });
        response.writeHead(200, { "content-type": "text/plain" }).end("Device approved. Return to Harness.");
        return;
      }
      const state = form.get("state"),
        redirect = this.#loginRedirectUri;
      if (!state || !redirect || state !== this.#loginState) {
        response.writeHead(400).end("Login state expired.");
        return;
      }
      const callback = new URL(redirect);
      callback.searchParams.set("code", `${user.username}:${password}`);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() }).end();
    } catch (error) {
      consumeKnownError(error);
      response.writeHead(500, { "content-type": "text/plain" }).end("Built-in sign-in failed.");
    }
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
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as StoredSession;
      return session.accessToken && findSession(readState(this.#root), session.accessToken) ? session : undefined;
    } catch (error) {
      consumeKnownError(error);
      return undefined;
    }
  }
  #readFleetSession(token: string): StoredSession | undefined {
    const record = findSession(readState(this.#root), token);
    if (!record) return undefined;
    return {
      schema: "harness-oidc-session/v3",
      issuer: builtinAuthorityUrl(this.#root),
      accessToken: token,
      refreshToken: "builtin-fleet-session",
      subject: record.subject,
      personId: record.personId,
      expiresAt: record.expiresAt,
      sessionExpiresAt: record.sessionExpiresAt,
      roles: record.roles,
      authority: { url: builtinAuthorityUrl(this.#root), realm: "local", clientId: "harness-center" },
    };
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
        expiresAt: now + 15 * 60_000,
        sessionExpiresAt,
        roles: user.roles,
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

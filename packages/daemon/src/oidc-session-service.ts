import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type {
  DeviceLoginRequest,
  OidcLoginAuthority,
  OidcSessionPorts,
  OidcSessionStorePort,
  StoredSession,
} from "./oidc-session-contracts.ts";
import {
  clientFields,
  coded,
  decodeJwtPayload,
  realmRoles,
  requiredNumber,
  requiredString,
  transientTransportFailure,
  unavailable,
} from "./oidc-session-helpers.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { managedRbacListenerUrl, managedRbacSessionStore, type ManagedRbacListener } from "./managed-rbac-service.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { verifyFleetHuman } from "./oidc-fleet-principal.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import type { FleetDeviceLoginNotice } from "./fleet/command-protocol.ts";
import { reportFleetDeviceLogin, readFleetLoginAuthorityClient } from "./fleet/peer.ts";
import { errorMessageWithCause } from "./error-cause.ts";
import { oidcCenterSelections } from "./oidc-center-selection.ts";
import { openDeviceConfirmationGateway, type DeviceConfirmationGateway } from "./oidc-device-confirmation-gateway.ts";
import {
  fetchWithTlsCa,
  probeSystemCaTrust,
  rootCaFromCertificateChain,
  systemCaCertificates,
} from "./tls-ca-certificate.ts";

export type { DeviceLoginRequest, OidcLoginAuthority, OidcSessionPorts } from "./oidc-session-contracts.ts";

interface RbacConfig {
  readonly url: string;
  readonly realm: string;
  readonly clientId?: string;
  readonly listener?: ManagedRbacListener;
}

interface PendingLogin {
  readonly generation: number;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
  readonly authority: OidcLoginAuthority;
  readonly issuer: string;
  readonly loginTarget?: string;
}

interface PendingDeviceLogin {
  readonly notice: FleetDeviceLoginNotice;
  readonly authority: OidcLoginAuthority;
  readonly issuer: string;
  readonly loginTarget?: string;
  readonly deviceCode: string;
  readonly verifier: string;
  readonly expiresAt: number;
  interval: number;
  nextPollAt: number;
  lastTransportError?: string;
  gateway?: DeviceConfirmationGateway;
}

/** What one use of the session finds. `unavailable` is set when Keycloak could not be asked to renew it. */
interface SessionUse {
  readonly session: StoredSession | undefined;
  readonly unavailable?: Error;
}

interface CenterToken {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly url: string;
  readonly realm: string;
  readonly issuer: string;
}

/** A use this close to the access token's end renews it, so the token a request carries outlives the request. */
const renewalMarginMs = 30_000;

/**
 * Daemon-owned PKCE and Device session. Refresh tokens stay here; a short-lived access token may
 * accompany a fleet request as transient authentication metadata.
 * Access tokens stay short-lived. Ordinary SSO and offline idle limits are separate provider
 * policies; an offline token's refresh_expires_in does not set a local session deadline.
 */
export class OidcSessionService {
  readonly #rbacRoot: string;
  readonly #ports: OidcSessionPorts;
  readonly #centers: ReturnType<typeof oidcCenterSelections>;
  #pending: PendingLogin | undefined;
  #centerTokenCache: CenterToken | undefined;
  #loginGeneration = 0;
  #sessionGeneration = 0;
  #device: PendingDeviceLogin | undefined;
  readonly #deviceRequests = new Map<string, DeviceLoginRequest>();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(userRoot: string, ports: Partial<OidcSessionPorts> = {}) {
    this.#rbacRoot = path.join(userRoot, "rbac");
    this.#centers = oidcCenterSelections(userRoot);
    this.#ports = {
      fetch,
      now: Date.now,
      randomBytes,
      sessionStore: (issuer, realm) => managedRbacSessionStore(userRoot, issuer, realm),
      ...ports,
    };
  }

  async begin(redirectUri: string, loginTarget?: string): Promise<Record<string, unknown>> {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname))
      throw coded("oidc_redirect_invalid", "OIDC callback must use a loopback HTTP address.");
    // This daemon owns one browser login. Claim it before remote discovery can yield.
    const generation = ++this.#loginGeneration;
    this.#pending = undefined;
    const { authority, issuer } = await this.#centerIdentity(loginTarget, true);
    this.#assertLoginGeneration(generation);
    const verifier = this.#ports.randomBytes(32).toString("base64url"),
      state = this.#ports.randomBytes(24).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    this.#pending = {
      generation,
      state,
      verifier,
      redirectUri: redirect.toString(),
      createdAt: this.#ports.now(),
      authority,
      issuer,
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
      scope: authority.clientId.startsWith("harness-node-")
        ? "openid profile email offline_access"
        : "openid profile email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { ok: true, authorizationUrl: authorizationUrl.toString(), state };
  }

  async complete(code: string, state: string): Promise<Record<string, unknown>> {
    const pending = this.#pending;
    if (!pending || pending.state !== state || this.#ports.now() - pending.createdAt > 5 * 60_000)
      throw coded("oidc_state_invalid", "OIDC callback state is missing, mismatched, or expired.");
    this.#pending = undefined;
    const authority = pending.authority,
      tokenUrl = `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/token`,
      tokenResponse = await this.#fetchAuthority(authority, tokenUrl, {
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
    return this.#acceptTokens(
      (await tokenResponse.json()) as Record<string, unknown>,
      authority,
      pending.issuer,
      pending.loginTarget,
      pending.generation,
    );
  }

  #assertLoginGeneration(generation: number): void {
    if (generation !== this.#loginGeneration)
      throw coded("oidc_login_superseded", "A newer login or logout superseded this sign-in attempt.");
  }

  async beginDevice(
    loginTarget?: string,
    authorityOverride?: OidcLoginAuthority,
    expiresAtLimit?: number,
  ): Promise<Record<string, unknown>> {
    if (this.#device) {
      const previous = this.#device;
      this.#device = undefined;
      await this.#closeDeviceGateway(previous);
      await this.#reportDevice(previous, false);
    }
    const authority = authorityOverride ?? (await this.#loginAuthority(loginTarget, true)),
      verifier = this.#ports.randomBytes(32).toString("base64url");
    let issuer: string;
    let response: Response;
    try {
      issuer = await this.#issuer(authority);
      this.#centers.write(loginTarget, { authority, issuer });
      response = await this.#fetchAuthority(
        authority,
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/auth/device`,
        {
          method: "POST",
          body: new URLSearchParams({
            ...clientFields(authority),
            scope: authority.clientId.startsWith("harness-node-")
              ? "openid profile email offline_access"
              : "openid profile email",
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }),
        },
      );
    } catch (error) {
      tagDeviceTransportFailure(error);
      throw error;
    }
    if (!response.ok)
      throw coded("oidc_device_rejected", `Keycloak device authorization returned HTTP ${response.status}.`);
    const device = (await response.json()) as Record<string, unknown>,
      interval = requiredNumber(device.interval, "interval"),
      createdAt = this.#ports.now(),
      expiresAt = Math.min(
        createdAt + requiredNumber(device.expires_in, "expires_in") * 1_000,
        expiresAtLimit ?? Number.POSITIVE_INFINITY,
      ),
      userCode = requiredString(device.user_code, "user_code"),
      verificationUri = deviceVerificationUri(
        authority,
        requiredString(device.verification_uri, "verification_uri"),
        userCode,
      ),
      notice = { userCode, createdAt, expiresAt, pending: true };
    const gateway = await this.#managedDeviceGateway(authority, verificationUri, expiresAt - createdAt);
    this.#device = {
      notice,
      authority,
      issuer,
      deviceCode: requiredString(device.device_code, "device_code"),
      verifier,
      interval,
      expiresAt,
      nextPollAt: this.#ports.now() + interval * 1_000,
      ...(loginTarget ? { loginTarget } : {}),
      ...(gateway ? { gateway } : {}),
    };
    this.#centers.write(loginTarget, { authority, issuer });
    await this.#reportDevice(this.#device, true);
    return {
      ok: true,
      pending: true,
      verificationUri,
      ...(gateway ? { managedVerificationUri: gateway.verificationUri } : {}),
      userCode,
      interval,
      expiresAt,
    };
  }

  revokeDeviceSessions(nodeId: string): Promise<void> {
    return this.serialize(async () => {
      const center = await this.center();
      await new KeycloakPolicyAdapter(
        { ...center, resourceServerClientId: "harness-center" },
        this.#ports.fetch,
      ).revokeNodeConsent(center.accessToken, nodeId);
    });
  }

  receiveDeviceNotice(nodeId: string, personId: string, notice: FleetDeviceLoginNotice): void {
    const key = `${nodeId}:${notice.userCode}`;
    if (!notice.pending || notice.expiresAt <= this.#ports.now()) {
      this.#deviceRequests.delete(key);
      return;
    }
    const config = this.#config(),
      url = new URL(
        `${config.listener ? managedRbacListenerUrl(config.listener) : config.url}/realms/${encodeURIComponent(config.realm)}/device`,
      );
    url.searchParams.set("user_code", notice.userCode);
    this.#deviceRequests.set(key, {
      nodeId,
      personId,
      userCode: notice.userCode,
      createdAt: notice.createdAt,
      expiresAt: notice.expiresAt,
      verificationUriComplete: url.toString(),
    });
  }

  async deviceApproval(userCode: string, loginTarget?: string): Promise<Record<string, unknown>> {
    const session = await this.status(loginTarget),
      requests = session.deviceLoginRequests as readonly DeviceLoginRequest[] | undefined,
      request = requests?.find((item) => item.userCode === userCode);
    if (!request) throw coded("oidc_device_missing", "The device login request is no longer pending for this person.");
    return { ok: true, authorizationUrl: request.verificationUriComplete, listener: this.#config().listener ?? null };
  }

  async #reportDevice(pending: PendingDeviceLogin, active: boolean): Promise<void> {
    if (!pending.loginTarget) return;
    const notice = { ...pending.notice, pending: active };
    if (this.#ports.reportDevice) return this.#ports.reportDevice(pending.loginTarget, notice);
    const edge = readFleetEdgeConfig(pending.loginTarget);
    if (!edge) return;
    await reportFleetDeviceLogin(
      {
        hostname: edge.host,
        port: edge.port,
        ca: readFileSync(edge.caPath),
        servername: edge.servername,
        nodeId: edge.nodeId,
        credential: edge.credential,
      },
      notice,
    );
  }

  pollDevice(): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const pending = this.#device;
      if (!pending) throw coded("oidc_device_missing", "Start device login first.");
      if (this.#ports.now() >= pending.expiresAt) {
        this.#device = undefined;
        await this.#closeDeviceGateway(pending);
        await this.#reportDevice(pending, false);
        throw coded(
          "oidc_device_expired",
          pending.lastTransportError
            ? `Device authorization expired; the last Keycloak request failed: ${pending.lastTransportError}`
            : "Device authorization expired; start login again.",
        );
      }
      if (this.#ports.now() < pending.nextPollAt)
        return {
          ok: true,
          pending: true,
          interval: pending.interval,
        };
      let response: Response;
      try {
        response = await this.#fetchAuthority(
          pending.authority,
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
      } catch (error) {
        if (!tagDeviceTransportFailure(error)) throw error;
        const transportError = errorMessageWithCause(error);
        pending.lastTransportError = transportError;
        pending.nextPollAt = this.#ports.now() + pending.interval * 1_000;
        throw error;
      }
      const result = (await response.json()) as Record<string, unknown>;
      delete pending.lastTransportError;
      if (!response.ok) {
        if (result.error === "invalid_grant") {
          this.#device = undefined;
          await this.#closeDeviceGateway(pending);
          await this.#reportDevice(pending, false);
          return this.beginDevice(pending.loginTarget, pending.authority, pending.expiresAt);
        }
        if (result.error === "authorization_pending" || result.error === "slow_down") {
          if (result.error === "slow_down") pending.interval += 5;
          pending.nextPollAt = this.#ports.now() + pending.interval * 1_000;
          return { ok: true, pending: true, interval: pending.interval };
        }
        this.#device = undefined;
        await this.#closeDeviceGateway(pending);
        await this.#reportDevice(pending, false);
        throw coded("oidc_device_rejected", `Device authorization ended: ${String(result.error)}.`);
      }
      this.#device = undefined;
      const accepted = await this.#acceptTokens(result, pending.authority, pending.issuer, pending.loginTarget);
      await this.#closeDeviceGateway(pending);
      await this.#reportDevice(pending, false);
      return accepted;
    });
  }

  async #managedDeviceGateway(
    authority: OidcLoginAuthority,
    verificationUri: string,
    expiresInMs: number,
  ): Promise<DeviceConfirmationGateway | undefined> {
    if (!authority.browserUrl || !authority.url.startsWith("https://")) return undefined;
    const endpoint = new URL(authority.url);
    if (!(endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]"))
      return undefined;
    return openDeviceConfirmationGateway(authority, verificationUri, expiresInMs, this.#ports.fetch);
  }

  async #closeDeviceGateway(pending: PendingDeviceLogin): Promise<void> {
    await pending.gateway?.close();
  }

  async #acceptTokens(
    tokens: Record<string, unknown>,
    authority: OidcLoginAuthority,
    issuer: string,
    loginTarget?: string,
    generation?: number,
  ): Promise<Record<string, unknown>> {
    const accessToken = requiredString(tokens.access_token, "access_token"),
      actualIssuer = requiredString(decodeJwtPayload(accessToken).iss, "iss");
    if (actualIssuer !== issuer)
      throw coded("oidc_issuer_mismatch", "The Keycloak token issuer does not match the selected center.");
    const store = this.#sessionStore(issuer, authority.realm),
      userResponse = await this.#fetchAuthority(
        authority,
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/userinfo`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
    if (!userResponse.ok)
      throw coded("oidc_identity_rejected", `Keycloak userinfo returned HTTP ${userResponse.status}.`);
    const user = (await userResponse.json()) as Record<string, unknown>,
      subject = requiredString(user.sub, "sub"),
      personId = typeof user.harness_person_id === "string" ? user.harness_person_id : subject;
    const session = this.#issued(
      tokens,
      { subject, personId, ...(loginTarget ? { loginTarget } : {}) },
      authority,
      issuer,
    );
    this.#centers.write(loginTarget, { authority, issuer });
    if (generation === undefined) {
      this.#writeSession(session, store);
      ++this.#sessionGeneration;
    } else
      await this.serialize(async () => {
        // Serialize with renewal/logout; a late exchange must not replace the newer session.
        this.#assertLoginGeneration(generation);
        this.#writeSession(session, store);
        ++this.#sessionGeneration;
      });
    return { ok: true, authenticated: true, personId: session.personId, expiresAt: session.sessionExpiresAt };
  }

  /** `expiresAt` is the SSO deadline, or null when Keycloak decides offline validity on refresh. */
  async status(loginTarget?: string): Promise<Record<string, unknown>> {
    const { sessionStore } = await this.#centerIdentity(loginTarget),
      session = await this.#live(sessionStore);
    if (!session) return { ok: true, authenticated: false };
    for (const [key, request] of this.#deviceRequests)
      if (request.expiresAt <= this.#ports.now()) this.#deviceRequests.delete(key);
    return {
      ok: true,
      authenticated: true,
      personId: session.personId,
      expiresAt: session.sessionExpiresAt,
      deviceLoginRequests: [...this.#deviceRequests.values()].filter(
        (request) => request.personId === session.personId,
      ),
    };
  }

  /** Read the selected edge's public authority, independently of this daemon's signed-in session. */
  async bindingHealth(loginTarget: string): Promise<Record<string, unknown>> {
    const authority = await this.#loginAuthority(loginTarget, true),
      response = await this.#fetchAuthority(
        authority,
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}`,
      );
    return {
      source: "fleet-center",
      mode: "external",
      ok: response.ok,
      ready: response.ok,
      url: authority.url,
      realm: authority.realm,
      clientId: authority.clientId,
      status: response.status,
    };
  }

  /** Queued behind a renewal in flight, so a session that is being renewed stays signed out. */
  logout(loginTarget?: string): Promise<Record<string, unknown>> {
    ++this.#loginGeneration;
    ++this.#sessionGeneration;
    this.#pending = undefined;
    const device = this.#device;
    this.#device = undefined;
    return this.serialize(async () => {
      if (device) await this.#closeDeviceGateway(device);
      const { authority: targetAuthority, sessionStore } = await this.#centerIdentity(loginTarget),
        session = this.#session(sessionStore);
      sessionStore.delete();
      if (session) {
        const authority = session.authority?.clientId ? (session.authority as OidcLoginAuthority) : targetAuthority,
          response = await this.#fetchAuthority(
            authority,
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
      if (device) await this.#reportDevice(device, false);
      return { ok: true, authenticated: false };
    });
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return { ok: true, required: await this.#bootstrapRequired(await this.#centerToken()) };
  }

  /** Public metadata carried by new edge invitations; contains no secret or session token. */
  async interactiveAuthority(): Promise<{
    readonly url: string;
    readonly realm: string;
    readonly clientId: string;
    readonly certificate?: string;
  }> {
    const authority = await this.#loginAuthority(),
      url = authority.browserUrl ?? authority.url;
    const systemTrusted = await this.#probeSystemTrust(url),
      certificate = systemTrusted ? undefined : rootCaFromCertificateChain(authority.certificate ?? "");
    if (!systemTrusted && !certificate)
      throw coded(
        "oidc_login_trust_unavailable",
        "The login listener is not trusted by the system and its configured certificate chain has no usable root CA.",
      );
    return {
      url,
      realm: authority.realm,
      clientId: authority.clientId,
      ...(certificate ? { certificate } : {}),
    };
  }

  /** Whether a Keycloak authority exists at all; without one no request can ever authorize, so callers guide to ha bootstrap. */
  configured(): boolean {
    return existsSync(path.join(this.#rbacRoot, "config.json"));
  }

  /** Whether the daemon has the center service credential needed for ownership claims. */
  centerConfigured(): boolean {
    return this.configured() && existsSync(path.join(this.#rbacRoot, "center-client-secret"));
  }

  /**
   * Binds the signed-in person to a request. While Keycloak cannot be reached to renew the session
   * only a server-selected edge replica read may retain its unexpired session identity.
   * Every online caller still requires a usable access token.
   */
  async bind(
    auth: DaemonAuthenticationContext,
    loginTarget?: string,
    replicaRead = false,
  ): Promise<DaemonAuthenticationContext> {
    if (auth.transportKind === "fleet-tls") {
      if (!auth.humanAccessToken)
        throw Object.assign(new Error("Sign in on this device before using Fleet."), {
          code: "authentication_required",
        });
      const config = this.#config();
      const adminAccessToken = await this.#centerToken();
      return this.serialize(async () => {
        const bound = await verifyFleetHuman({
          auth,
          url: config.url,
          issuerUrl: config.listener ? managedRbacListenerUrl(config.listener) : config.url,
          realm: config.realm,
          clientId: "harness-center",
          expectedAzps: [{ clientId: `harness-node-${auth.nodePrincipal!.nodeId}` }, ...(auth.fleetExpectedAzps ?? [])],
          clientSecret: readFileSync(path.join(this.#rbacRoot, "center-client-secret"), "utf8").trim(),
          adminAccessToken,
          fetch: this.#ports.fetch,
          now: this.#ports.now(),
        });
        if (bound.nodePrincipal!.personId === auth.nodePrincipal!.personId) return bound;
        const adapter = new KeycloakPolicyAdapter(
            { ...config, resourceServerClientId: "harness-center" },
            this.#ports.fetch,
          ),
          node = await adapter.readNode(adminAccessToken, bound.nodePrincipal!.nodeId);
        if (!node || node.state !== "active" || node.revocation !== "complete")
          throw coded("node_owner_unregistered", "The device is not active.");
        if (node.personId !== bound.nodePrincipal!.personId)
          await adapter.transferNode(
            adminAccessToken,
            { ...node, personId: bound.nodePrincipal!.personId, revision: node.revision + 1 },
            node.personId,
          );
        return bound;
      });
    }
    const { sessionStore } = await this.#centerIdentity(loginTarget),
      generation = this.#sessionGeneration,
      { session, unavailable } = await this.#use(sessionStore);
    if (!session || generation !== this.#sessionGeneration) return auth;
    if (replicaRead && session.sessionExpiresAt !== null && session.sessionExpiresAt <= this.#ports.now()) return auth;
    if (unavailable) {
      if (!replicaRead || (session.sessionExpiresAt !== null && session.sessionExpiresAt <= this.#ports.now()))
        return auth;
      return {
        ...auth,
        replicaReadPrincipal: { personId: session.personId, sessionExpiresAt: session.sessionExpiresAt },
      };
    }
    const authority = session.authority ?? (await this.#loginAuthority(session.loginTarget));
    return {
      ...auth,
      localSessionAccessToken: async () => {
        const current = await this.#live(sessionStore);
        if (
          !current ||
          generation !== this.#sessionGeneration ||
          current.personId !== session.personId ||
          current.subject !== session.subject
        )
          throw coded("authentication_required", "The originally bound Keycloak session has ended.");
        return current.accessToken;
      },
      oidcPrincipal: {
        personId: session.personId,
        subject: session.subject,
        expiresAt: session.expiresAt,
        accessToken: session.accessToken,
        authority: {
          url: authority.url,
          realm: authority.realm,
          clientId: "harness-center",
          ...(authority.certificate ? { certificate: authority.certificate } : {}),
          ...(authority.servername ? { servername: authority.servername } : {}),
        },
      },
    };
  }

  /** Public metadata comes from the center; an edge never writes a second Keycloak configuration. */
  discovery(nodeId: string): OidcLoginAuthority | null {
    const config = this.#config(),
      url = config.listener ? managedRbacListenerUrl(config.listener) : config.url;
    if (new URL(url).protocol !== "https:") return null;
    return {
      url,
      realm: config.realm,
      clientId: `harness-node-${nodeId}`,
      ...(config.listener ? { certificate: readFileSync(config.listener.certificateFile, "utf8") } : {}),
    };
  }

  async requireRole(role: string, loginTarget?: string): Promise<StoredSession> {
    const { sessionStore } = await this.#centerIdentity(loginTarget);
    return this.#requireRole(role, await this.#live(sessionStore));
  }

  /** Device administration must observe external session revocation before using center Admin REST. */
  async requireSession(loginTarget?: string): Promise<StoredSession> {
    const { sessionStore } = await this.#centerIdentity(loginTarget),
      session = await this.#live(sessionStore);
    if (!session) throw coded("authentication_required", "Sign in with Keycloak first.");
    const authority = session.authority ?? (await this.#loginAuthority(session.loginTarget)),
      response = await this.#fetchAuthority(
        authority,
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/userinfo`,
        {
          headers: { authorization: `Bearer ${session.accessToken}` },
        },
      );
    if (!response.ok) throw coded("authentication_required", "This device session has ended; sign in again.");
    const identity = (await response.json()) as { sub?: string; harness_person_id?: string };
    if (identity.sub !== session.subject || identity.harness_person_id !== session.personId)
      throw coded("authentication_required", "This device session no longer identifies the signed-in person.");
    return session;
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
  configureAuthority<T>(operation: () => Promise<T>, loginTarget?: string): Promise<T> {
    return this.serialize(async () => {
      const sessionStore = this.configured() ? (await this.#centerIdentity(loginTarget)).sessionStore : undefined;
      if (
        existsSync(path.join(this.#rbacRoot, "config.json")) &&
        !(await this.#bootstrapRequired(await this.#centerToken()))
      ) {
        if (!sessionStore) throw coded("authentication_required", "Sign in with the selected center first.");
        await this.#requireRoleInWriter("access-admin", sessionStore);
      }
      return operation();
    });
  }

  /** Role check for a caller already inside the write queue: renewal runs directly, never queued behind itself. */
  async #requireRoleInWriter(role: string, sessionStore: OidcSessionStorePort): Promise<StoredSession> {
    const { session, unavailable } = await this.#useCurrent(sessionStore);
    if (unavailable) throw unavailable;
    return this.#requireRole(role, session);
  }

  async #bootstrapRequired(token: string): Promise<boolean> {
    const members = await this.#adminJson("GET", "/roles/access-admin/users", token, undefined, true);
    if (members === undefined) return true;
    if (!Array.isArray(members))
      throw coded("oidc_response_invalid", "Keycloak returned invalid administrator membership.");
    return members.length === 0;
  }

  async center(
    rejectedAccessToken?: string,
  ): Promise<{ readonly url: string; readonly realm: string; readonly accessToken: string }> {
    return { ...this.#config(), accessToken: await this.#centerToken(rejectedAccessToken) };
  }

  bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const { sessionStore } = await this.#centerIdentity(),
        token = await this.#centerToken();
      if (!(await this.#bootstrapRequired(token)))
        throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");
      await this.#ensureAccessAdminRole(token);
      const userId = await this.#createUser(token, input, false),
        role = await this.#adminJson("GET", "/roles/access-admin", token);
      await this.#adminJson("POST", `/users/${encodeURIComponent(userId)}/role-mappings/realm`, token, [role]);
      await this.#removeBootstrapAdministrator(token, sessionStore);
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
    loginTarget?: string,
  ): Promise<Record<string, unknown>> {
    const { sessionStore } = await this.#centerIdentity(loginTarget);
    // A caller already inside the write queue must not re-queue its own session renewal.
    if (withinWriter) await this.#requireRoleInWriter("access-admin", sessionStore);
    else await this.requireRole("access-admin", loginTarget);
    const token = await this.#centerToken(),
      userId = await this.#createUser(token, input, true);
    await this.#adminJson("PUT", `/users/${encodeURIComponent(userId)}/execute-actions-email`, token, [
      "UPDATE_PASSWORD",
    ]);
    return { ok: true, invited: true, personId: input.personId };
  }

  async #centerToken(rejectedAccessToken?: string): Promise<string> {
    const config = this.#config(),
      // The listener is the issuer Keycloak mints under; a listener change restarts Keycloak and makes
      // tokens from the previous issuer invalid, even though the loopback token endpoint is unchanged.
      issuer = config.listener ? managedRbacListenerUrl(config.listener) : config.url,
      secretFile = path.join(this.#rbacRoot, "center-client-secret");
    if (!existsSync(secretFile))
      throw coded("rbac_admin_unavailable", "Keycloak center credentials are not configured.");
    if (rejectedAccessToken !== undefined && this.#centerTokenCache?.accessToken === rejectedAccessToken)
      this.#centerTokenCache = undefined;
    const requestedAt = this.#ports.now(),
      cached = this.#centerTokenCache;
    if (
      cached &&
      cached.url === config.url &&
      cached.realm === config.realm &&
      cached.issuer === issuer &&
      cached.expiresAt > requestedAt
    )
      return cached.accessToken;
    const response = await this.#ports
      .fetch(`${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "harness-center",
          client_secret: readFileSync(secretFile, "utf8").trim(),
        }),
      })
      .catch((cause: unknown) => {
        throw Object.assign(coded("daemon_error", "Keycloak could not be reached to acquire a center token."), {
          cause,
        });
      });
    if (!response.ok)
      throw coded("rbac_admin_unavailable", `Keycloak service authentication returned HTTP ${response.status}.`);
    const payload = (await response.json()) as Record<string, unknown>,
      accessToken = requiredString(payload.access_token, "access_token"),
      expiresIn =
        typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 0;
    if (expiresIn > 0)
      this.#centerTokenCache = {
        accessToken,
        // dec_B0B79908FE04BBA7766035765B/CH3: include acquisition time and clock skew.
        expiresAt: requestedAt + expiresIn * 1_000 - Math.min(renewalMarginMs, expiresIn * 100),
        url: config.url,
        realm: config.realm,
        issuer,
      };
    return accessToken;
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

  async #removeBootstrapAdministrator(token: string, sessionStore: OidcSessionStorePort): Promise<void> {
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
    sessionStore.retireBootstrap();
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

  async #loginAuthority(target?: string, resetSession = false): Promise<OidcLoginAuthority> {
    if (target && this.#ports.loginAuthority) return this.#ports.loginAuthority(target);
    const edge = target ? readFleetEdgeConfig(target) : null;
    if (edge) {
      const authority = await readFleetLoginAuthorityClient({
        resetSession,
        hostname: edge.host,
        port: edge.port,
        ca: readFileSync(edge.caPath),
        servername: edge.servername,
        nodeId: edge.nodeId,
        credential: edge.credential,
      });
      return {
        ...authority,
        ...(edge.loginUrl ? { url: edge.loginUrl } : {}),
        ...(edge.loginServername ? { servername: edge.loginServername } : {}),
        ...(edge.loginBrowserUrl ? { browserUrl: edge.loginBrowserUrl } : {}),
        ...(edge.loginCertificate ? { certificate: edge.loginCertificate } : {}),
        clientSecret: edge.credential,
      };
    }
    const config = this.#config();
    return {
      url: config.url,
      realm: config.realm,
      clientId: "harness-gui",
      ...(config.listener ? { browserUrl: managedRbacListenerUrl(config.listener) } : {}),
      ...(config.listener ? { certificate: readFileSync(config.listener.certificateFile, "utf8") } : {}),
    };
  }

  async #centerIdentity(
    target?: string,
    resetSession = false,
    authorityOverride?: OidcLoginAuthority,
  ): Promise<{
    readonly authority: OidcLoginAuthority;
    readonly issuer: string;
    readonly sessionStore: OidcSessionStorePort;
  }> {
    const selected = resetSession ? undefined : this.#centers.read(target);
    if (selected) return { ...selected, sessionStore: this.#sessionStore(selected.issuer, selected.authority.realm) };
    const authority = authorityOverride ?? (await this.#loginAuthority(target, resetSession)),
      issuer = await this.#issuer(authority);
    this.#centers.write(target, { authority, issuer });
    return { authority, issuer, sessionStore: this.#sessionStore(issuer, authority.realm) };
  }

  async #issuer(authority: OidcLoginAuthority): Promise<string> {
    const response = await this.#fetchAuthority(
      authority,
      `${authority.url}/realms/${encodeURIComponent(authority.realm)}/.well-known/openid-configuration`,
    );
    if (!response.ok) throw coded("oidc_discovery_unavailable", `Keycloak discovery returned HTTP ${response.status}.`);
    return requiredString(((await response.json()) as Record<string, unknown>).issuer, "issuer");
  }

  #sessionStore(issuer: string, realm: string): OidcSessionStorePort {
    return this.#ports.sessionStore(issuer, realm);
  }

  async #fetchAuthority(
    authority: Pick<OidcLoginAuthority, "url" | "realm" | "certificate" | "servername">,
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const ca = authority.certificate ?? this.#defaultCaCertificates();
    return this.#fetchWithCa(ca, input, init, authority.servername);
  }

  #defaultCaCertificates(): readonly string[] {
    return this.#ports.defaultCaCertificates?.() ?? systemCaCertificates();
  }

  async #probeSystemTrust(url: string): Promise<boolean> {
    return probeSystemCaTrust(this.#ports.fetch, this.#defaultCaCertificates(), url);
  }

  #fetchWithCa(
    ca: string | readonly string[],
    input: string | URL,
    init?: RequestInit,
    servername?: string,
  ): Promise<Response> {
    return fetchWithTlsCa(this.#ports.fetch, ca, input, init, servername);
  }

  /** The signed-in session holding a usable access token; fails when Keycloak could not be asked to renew it. */
  async #live(sessionStore: OidcSessionStorePort): Promise<StoredSession | undefined> {
    const { session, unavailable } = await this.#use(sessionStore);
    if (unavailable) throw unavailable;
    return session;
  }

  /** A use near or past the access token's end renews the session first. */
  async #use(sessionStore: OidcSessionStorePort): Promise<SessionUse> {
    const session = this.#session(sessionStore);
    if (!session || !this.#lapsing(session)) return { session };
    return this.serialize(async () => {
      // Uses that queued behind a renewal find the session it wrote and do not renew again.
      return this.#useCurrent(sessionStore);
    });
  }

  async #useCurrent(sessionStore: OidcSessionStorePort): Promise<SessionUse> {
    const current = this.#session(sessionStore);
    return current && this.#lapsing(current) ? this.#renew(current, sessionStore) : { session: current };
  }

  #lapsing(session: StoredSession): boolean {
    return session.expiresAt - this.#ports.now() <= renewalMarginMs;
  }

  /** One refresh grant per use: Keycloak refusing it ends the session here, and nothing retries. */
  async #renew(session: StoredSession, sessionStore: OidcSessionStorePort): Promise<SessionUse> {
    const generation = this.#sessionGeneration,
      edge = session.loginTarget ? readFleetEdgeConfig(session.loginTarget) : null,
      authority =
        edge && session.authority
          ? { ...session.authority, clientId: `harness-node-${edge.nodeId}`, clientSecret: edge.credential }
          : session.authority?.clientId
            ? (session.authority as OidcLoginAuthority)
            : await this.#loginAuthority(session.loginTarget),
      response = await this.#fetchAuthority(
        authority,
        `${authority.url}/realms/${encodeURIComponent(authority.realm)}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            ...clientFields(authority),
            refresh_token: session.refreshToken,
          }),
        },
      ).catch((error: unknown) => unavailable("Keycloak could not be reached to renew the session.", error));
    if (generation !== this.#sessionGeneration) return { session: undefined };
    if (response instanceof Error)
      return {
        session:
          session.sessionExpiresAt === null || session.sessionExpiresAt > this.#ports.now() ? session : undefined,
        unavailable: response,
      };
    // Keycloak answers 400 once the session sat idle past its lifetime, was signed out, or had its token revoked.
    if (response.status === 400) {
      sessionStore.delete();
      return { session: undefined };
    }
    if (!response.ok)
      return {
        session: undefined,
        unavailable: unavailable(`Keycloak session renewal returned HTTP ${response.status}.`),
      };
    const tokens = (await response.json()) as Record<string, unknown>;
    if (generation !== this.#sessionGeneration) return { session: undefined };
    const accessToken = requiredString(tokens.access_token, "access_token");
    if (requiredString(decodeJwtPayload(accessToken).iss, "iss") !== session.issuer)
      throw coded("oidc_issuer_mismatch", "The renewed token issuer does not match the selected center.");
    if (session.sessionExpiresAt !== null && session.sessionExpiresAt <= this.#ports.now()) {
      sessionStore.delete();
      return { session: undefined };
    }
    const renewed = this.#issued(tokens, session, authority, session.issuer);
    this.#writeSession(renewed, sessionStore);
    return { session: renewed };
  }

  #issued(
    tokens: Record<string, unknown>,
    identity: { readonly subject: string; readonly personId: string; readonly loginTarget?: string },
    authority: OidcLoginAuthority,
    issuer: string,
  ): StoredSession {
    const accessToken = requiredString(tokens.access_token, "access_token"),
      now = this.#ports.now();
    return {
      schema: "harness-oidc-session/v3",
      issuer,
      accessToken,
      refreshToken: requiredString(tokens.refresh_token, "refresh_token"),
      subject: identity.subject,
      personId: identity.personId,
      expiresAt: now + requiredNumber(tokens.expires_in, "expires_in") * 1_000,
      sessionExpiresAt:
        typeof tokens.scope === "string" && tokens.scope.split(" ").includes("offline_access")
          ? null
          : now + requiredNumber(tokens.refresh_expires_in, "refresh_expires_in") * 1_000,
      roles: realmRoles(decodeJwtPayload(accessToken)),
      ...(identity.loginTarget ? { loginTarget: identity.loginTarget } : {}),
      authority: {
        url: authority.url,
        realm: authority.realm,
        clientId: authority.clientId,
        ...(authority.certificate ? { certificate: authority.certificate } : {}),
        ...(authority.servername ? { servername: authority.servername } : {}),
      },
    };
  }

  #session(sessionStore: OidcSessionStorePort): StoredSession | undefined {
    const value = sessionStore.read();
    return value === undefined ? undefined : (JSON.parse(value) as StoredSession);
  }
  #writeSession(session: StoredSession, sessionStore: OidcSessionStorePort): void {
    sessionStore.write(`${JSON.stringify(session)}\n`);
  }
}

function deviceVerificationUri(authority: OidcLoginAuthority, fallback: string, userCode: string): string {
  if (!authority.browserUrl) return fallback;
  const url = new URL(
    `realms/${encodeURIComponent(authority.realm)}/device`,
    `${authority.browserUrl.replace(/\/$/u, "")}/`,
  );
  url.searchParams.set("user_code", userCode);
  return url.toString();
}

/**
 * The one code a transient Keycloak transport failure carries. Starting device authorization and
 * polling it are the same unreachable-authority failure, so both use this mapping instead of each
 * inventing an answer. Returns whether the caught value was that failure; callers rethrow it as-is.
 */
function tagDeviceTransportFailure(error: unknown): boolean {
  if (!transientTransportFailure(error)) return false;
  (error as TypeError & { code?: string }).code = "oidc_device_transport_unavailable";
  return true;
}

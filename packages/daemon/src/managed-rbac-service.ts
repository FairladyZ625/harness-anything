import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { connect, createServer, isIP, type Server } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { consumeKnownError } from "@harness-anything/kernel";
import { runProcessText } from "./process-port.ts";
import type { AccessAdminOperation, AccessAdminRequest } from "./access-admin-service.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { keycloakLoginAttributes, keycloakLoginMappers } from "./keycloak-login-client.ts";
import {
  alignSessionLifetime,
  sessionLifetimeBounds,
  sessionLifetimeRealmSettings,
} from "./keycloak-session-lifetime.ts";

export const managedRbacVersions = Object.freeze({
  keycloak: "26.7.3",
  java: "21.0.12.1+1",
  postgres: "18.3.0",
});

type SupportedPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64";
type ManagedRbacOperation =
  | "bootstrap"
  | "health"
  | "start"
  | "stop"
  | "backup"
  | "restore"
  | "upgrade"
  | "listener"
  | "listener-set"
  | "login-begin"
  | "login-complete"
  | "login"
  | "login-poll"
  | "session"
  | "logout"
  | "bootstrap-status"
  | "bootstrap-admin"
  | "invite"
  | AccessAdminOperation;

export interface ManagedRbacRequest extends AccessAdminRequest {
  readonly repoId?: string;
  readonly rootDir?: string;
  readonly operation?: ManagedRbacOperation;
  readonly mode?: "managed" | "external";
  readonly url?: string;
  readonly realm?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly backupDir?: string;
  readonly redirectUri?: string;
  readonly code?: string;
  readonly state?: string;
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly password?: string;
  readonly personId?: string;
  readonly listenAddress?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly certificateFile?: string;
  readonly certificateKeyFile?: string;
}

/**
 * Where edge nodes reach the managed Keycloak: HTTPS on one address of this machine, under the
 * hostname its certificate names. Without one, Keycloak serves loopback HTTP only.
 */
export interface ManagedRbacListener {
  readonly address: string;
  readonly hostname: string;
  readonly port: number;
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
}

interface ManagedRbacConfig {
  readonly schema: "harness-managed-rbac/v1";
  readonly mode: "managed" | "external";
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly versions: typeof managedRbacVersions;
  readonly installedPlatform?: SupportedPlatform;
  readonly installedAt?: string;
  readonly postgresPort?: number;
  readonly managementPort?: number;
  readonly listener?: ManagedRbacListener;
  /** An operator stopped the managed services; a daemon start leaves them down until they are started again. */
  readonly stopped?: boolean;
}

interface Artifact {
  readonly name: "keycloak" | "java" | "postgres";
  readonly url: string;
  readonly checksumUrl: string;
  readonly algorithm: "sha1" | "sha256";
  readonly checksumFormat: "raw" | "github-release";
  readonly archive: "tar.gz" | "jar-txz";
}

export interface ManagedRbacPorts {
  readonly fetch: typeof fetch;
  readonly spawn: typeof spawn;
  readonly now: () => string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

const defaultPorts: ManagedRbacPorts = {
  fetch,
  spawn,
  now: () => new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
};

export class ManagedRbacService {
  readonly #root: string;
  readonly #ports: ManagedRbacPorts;
  readonly #children = new Map<"postgres" | "keycloak", ChildProcess>();
  readonly #readiness = new Map<"postgres" | "keycloak", Promise<void>>();
  #lifecycle: Promise<unknown> = Promise.resolve();

  constructor(userRoot: string, ports: Partial<ManagedRbacPorts> = {}) {
    this.#root = path.join(userRoot, "rbac");
    this.#ports = { ...defaultPorts, ...ports };
  }

  /** Lifecycle operations run one at a time: a start asked for while the daemon is still resuming waits for it. */
  run(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (request.mode !== "external" && request.operation === "health") return this.health();
    const run = this.#lifecycle.then(() => this.#run(request));
    this.#lifecycle = run.catch(consumeKnownError);
    return run;
  }

  /**
   * The authorization server is part of the center, so a daemon start brings the managed one back.
   * Keycloak keeps its sessions in PostgreSQL: people who were signed in stay signed in.
   */
  async resume(): Promise<void> {
    const config = this.#readConfigIfPresent();
    if (config?.mode !== "managed" || config.stopped) return;
    await this.run({ operation: "start" });
  }

  async #run(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    const operation = request.operation ?? "bootstrap";
    if (request.mode === "external") return this.#configureExternal(request);
    if (operation === "stop") {
      const config = this.#readConfigIfPresent();
      if (config?.mode === "managed") this.#writeConfig({ ...config, stopped: true });
      return this.stop();
    }
    if (operation === "listener") {
      const { listener } = this.#readManagedConfig();
      return { ok: true, command: "rbac-listener", listener: listener ?? null, version: listenerVersion(listener) };
    }
    if (operation === "listener-set") return this.#setListener(request);
    if (operation === "backup") return this.#backup(request);
    if (operation === "restore") return this.#restore(request);
    const started = Date.now();
    if (operation === "bootstrap" || operation === "upgrade") await this.#install();
    await this.start();
    const health = await this.#waitUntilReady();
    await this.#syncRealm();
    return {
      ok: true,
      command: `rbac-${operation}`,
      mode: "managed",
      versions: managedRbacVersions,
      coldStartMs: Date.now() - started,
      ...health,
    };
  }

  async start(): Promise<void> {
    const config = this.#readConfig();
    if (config.mode === "external") return;
    if (!existsSync(path.join(this.#root, "runtime", "postgres", "bin", "postgres")))
      throw managedRbacError("rbac_not_installed", "Run ha bootstrap before starting managed RBAC services.");
    if (config.stopped) this.#writeConfig({ ...config, stopped: false });
    await this.#startPostgres();
    await this.#startKeycloak();
  }

  async stop(): Promise<Record<string, unknown>> {
    const stopped: string[] = [];
    for (const name of ["keycloak", "postgres"] as const) if (await this.#stopChild(name)) stopped.push(name);
    return { ok: true, command: "rbac-stop", stopped };
  }

  async #stopChild(name: "postgres" | "keycloak"): Promise<boolean> {
    const child = this.#children.get(name);
    if (!child) return false;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#children.delete(name);
    this.#readiness.delete(name);
    return true;
  }

  /**
   * The listener is one value in the managed configuration, changed against the version an
   * administrator read. Keycloak restarts under it; a listener Keycloak cannot start with is not kept.
   * The listener's hostname becomes the token issuer, so a session signed in under the previous
   * issuer is refused at its next renewal and signs in again.
   */
  async #setListener(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    const config = this.#readManagedConfig(),
      currentVersion = listenerVersion(config.listener),
      expectedVersion = request.expectedVersion;
    if (!expectedVersion)
      throw managedRbacError(
        "rbac_listener_invalid",
        "Changing the listener requires --expected-version; read it with --operation listener.",
      );
    if (expectedVersion !== currentVersion)
      return { ok: false, code: "version_conflict", command: "rbac-listener-set", expectedVersion, currentVersion };
    const listener = requestedListener(request),
      { listener: _replaced, ...loopback } = config,
      apply = async (next: ManagedRbacConfig): Promise<void> => {
        await this.#stopChild("keycloak");
        this.#writeConfig(next);
        await this.start();
        await this.#waitUntilReady();
      };
    if (listener) requirePrivateKeyFile(listener.certificateKeyFile);
    try {
      await apply(listener ? { ...loopback, listener } : loopback);
    } catch (error) {
      await apply(config);
      throw error;
    }
    return {
      ok: true,
      command: "rbac-listener-set",
      listener: listener ?? null,
      version: listenerVersion(listener),
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const config = this.#readConfig();
    const response = await this.#ports.fetch(`${config.url}/realms/${encodeURIComponent(config.realm)}`);
    return {
      ready: response.ok,
      mode: config.mode,
      url: config.url,
      browserUrl: config.listener ? managedRbacListenerUrl(config.listener) : config.url,
      realm: config.realm,
      clientId: config.clientId,
      status: response.status,
      ...(config.mode === "managed"
        ? { versions: config.versions }
        : { version: response.headers.get("x-keycloak-version") ?? response.headers.get("server") ?? "unknown" }),
    };
  }

  async #install(): Promise<void> {
    const platform = supportedPlatform(this.#ports.platform, this.#ports.arch);
    const runtime = path.join(this.#root, "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const artifact of artifactManifest(platform)) await this.#installArtifact(artifact, runtime);
    this.#initializeDatabase();
    this.#writeRealmImport();
    const existing = this.#readConfigIfPresent(),
      ports = existing?.mode === "managed" ? undefined : await availableLoopbackPorts(),
      httpPort = existing?.mode === "managed" ? Number(new URL(existing.url).port) : ports![0],
      postgresPort = existing?.mode === "managed" && existing.postgresPort ? existing.postgresPort : ports![1],
      managementPort = existing?.mode === "managed" && existing.managementPort ? existing.managementPort : ports![2];
    this.#writeConfig({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: `http://127.0.0.1:${httpPort}`,
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      installedPlatform: platform,
      installedAt: this.#ports.now(),
      postgresPort,
      managementPort,
      ...(existing?.mode === "managed" && existing.listener ? { listener: existing.listener } : {}),
    });
  }

  async #installArtifact(artifact: Artifact, runtime: string): Promise<void> {
    const destination = path.join(runtime, artifact.name);
    const marker = path.join(destination, ".installed");
    if (existsSync(marker) && readFileSync(marker, "utf8").startsWith(`${artifact.url}\n`)) return;
    const downloads = path.join(this.#root, "downloads");
    mkdirSync(downloads, { recursive: true, mode: 0o700 });
    const archive = path.join(downloads, `${artifact.name}.${artifact.archive === "jar-txz" ? "jar" : "tar.gz"}`),
      temporary = `${archive}.partial`;
    const [payload, publishedChecksum] = await Promise.all([
      this.#ports.fetch(artifact.url),
      this.#ports.fetch(artifact.checksumUrl),
    ]);
    if (!payload.ok || !payload.body)
      throw managedRbacError("rbac_download_failed", `${artifact.name} download returned HTTP ${payload.status}.`);
    if (!publishedChecksum.ok)
      throw managedRbacError(
        "rbac_checksum_unavailable",
        `${artifact.name} checksum returned HTTP ${publishedChecksum.status}.`,
      );
    await pipeline(payload.body, createWriteStream(temporary, { mode: 0o600 }));
    const checksumBody = await publishedChecksum.text(),
      expected = publishedDigest(artifact, checksumBody),
      actual = await digestFile(temporary, artifact.algorithm);
    if (!expected || actual !== expected) {
      rmSync(temporary, { force: true });
      throw managedRbacError("rbac_checksum_mismatch", `${artifact.name} did not match its published checksum.`);
    }
    renameSync(temporary, archive);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    extractArtifact(archive, destination, artifact.archive);
    flattenSingleDirectory(destination);
    writeFileSync(marker, `${artifact.url}\n${actual}\n`, { mode: 0o600 });
  }

  #initializeDatabase(): void {
    const data = path.join(this.#root, "data", "postgres"),
      initdb = path.join(this.#root, "runtime", "postgres", "bin", "initdb");
    if (existsSync(path.join(data, "PG_VERSION"))) return;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    run(initdb, ["-D", data, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  }

  #writeRealmImport(): void {
    const secretFile = path.join(this.#root, "center-client-secret");
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    const realm = {
      realm: "harness",
      enabled: true,
      ...sessionLifetimeRealmSettings(sessionLifetimeBounds.defaultSeconds),
      registrationAllowed: false,
      loginWithEmailAllowed: true,
      clients: [
        {
          clientId: "harness-center",
          enabled: true,
          publicClient: false,
          serviceAccountsEnabled: true,
          authorizationServicesEnabled: true,
          // Grants are independent allow rules on one resource: any applicable grant permits, none denies.
          authorizationSettings: { policyEnforcementMode: "ENFORCING", decisionStrategy: "AFFIRMATIVE" },
          secret: readFileSync(secretFile, "utf8").trim(),
        },
        {
          clientId: "harness-gui",
          enabled: true,
          publicClient: true,
          standardFlowEnabled: true,
          redirectUris: ["http://127.0.0.1/*"],
          attributes: keycloakLoginAttributes,
          protocolMappers: keycloakLoginMappers("harness-center"),
        },
      ],
      users: [
        {
          username: "service-account-harness-center",
          enabled: true,
          serviceAccountClientId: "harness-center",
          clientRoles: {
            "realm-management": [
              "manage-users",
              "view-users",
              "manage-realm",
              "manage-clients",
              "view-clients",
              "manage-authorization",
              "view-authorization",
            ],
          },
        },
      ],
    };
    const importDir = path.join(this.#root, "runtime", "keycloak", "data", "import");
    mkdirSync(importDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(importDir, "harness-realm.json"), `${JSON.stringify(realm, null, 2)}\n`, { mode: 0o600 });
  }

  #startPostgres(): Promise<void> {
    const active = this.#readiness.get("postgres");
    if (active) return active;
    const config = this.#readManagedConfig(),
      binary = path.join(this.#root, "runtime", "postgres", "bin", "postgres"),
      data = path.join(this.#root, "data", "postgres"),
      logs = path.join(this.#root, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    return this.#spawnUntilReady(
      "postgres",
      binary,
      ["-D", data, "-h", "127.0.0.1", "-p", String(config.postgresPort)],
      {},
      /database system is ready to accept connections/u,
      30_000,
    );
  }

  /**
   * Keycloak binds HTTP and HTTPS to one host, and that host stays loopback: the center keeps
   * reaching it over loopback HTTP. A listener is this process passing TLS connections through to
   * Keycloak's loopback HTTPS port, so the listen address carries HTTPS and nothing else.
   */
  async #startKeycloak(): Promise<void> {
    const active = this.#readiness.get("keycloak");
    if (active) return active;
    const config = this.#readManagedConfig(),
      { listener } = config,
      httpPort = new URL(config.url).port,
      javaHome = javaHomePath(this.#root, this.#ports.platform),
      kc = path.join(this.#root, "runtime", "keycloak", "bin", "kc.sh");
    if (listener) requirePrivateKeyFile(listener.certificateKeyFile);
    const httpsPort = listener ? (await availableLoopbackPorts())[0] : undefined,
      passthrough = listener ? await listenPassthrough(listener, httpsPort!) : undefined;
    const ready = this.#spawnUntilReady(
      "keycloak",
      kc,
      [
        "start",
        "--http-enabled=true",
        // A fixed hostname is the issuer of every token, whichever address the request arrived on.
        listener ? `--hostname=${managedRbacListenerUrl(listener)}` : "--hostname-strict=false",
        "--import-realm",
        "--health-enabled=true",
      ],
      {
        ...process.env,
        JAVA_HOME: javaHome,
        KC_HTTP_HOST: "127.0.0.1",
        KC_HTTP_PORT: httpPort,
        KC_HTTP_MANAGEMENT_HOST: "127.0.0.1",
        KC_HTTP_MANAGEMENT_PORT: String(config.managementPort),
        KC_CACHE: "local",
        KC_DB: "postgres",
        KC_DB_URL: `jdbc:postgresql://127.0.0.1:${config.postgresPort}/postgres`,
        KC_DB_USERNAME: "postgres",
        KC_DB_PASSWORD: "",
        KC_BOOTSTRAP_ADMIN_USERNAME: "harness-bootstrap",
        KC_BOOTSTRAP_ADMIN_PASSWORD: readOrCreateSecret(path.join(this.#root, "bootstrap-admin-password")),
        ...(listener
          ? {
              KC_HTTPS_PORT: String(httpsPort),
              KC_HTTPS_CERTIFICATE_FILE: listener.certificateFile,
              KC_HTTPS_CERTIFICATE_KEY_FILE: listener.certificateKeyFile,
            }
          : {}),
      },
      /Keycloak .* started in/u,
      60_000,
    );
    if (passthrough) this.#children.get("keycloak")!.once("exit", () => passthrough.close());
    return ready;
  }

  #track(name: "postgres" | "keycloak", child: ChildProcess): void {
    child.once("exit", () => {
      this.#children.delete(name);
      this.#readiness.delete(name);
    });
    this.#children.set(name, child);
  }

  #spawnUntilReady(
    name: "postgres" | "keycloak",
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    readyPattern: RegExp,
    timeoutMs: number,
  ): Promise<void> {
    const logs = path.join(this.#root, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    // Opened here rather than lazily by the stream: a log that cannot be opened fails this start,
    // instead of surfacing later as an unhandled stream error once the directory is gone.
    const logFile = path.join(logs, `${name}.log`),
      log = createWriteStream(logFile, { fd: openSync(logFile, "a") });
    let settleReady: (() => void) | null = null,
      settleError: ((error: Error) => void) | null = null,
      observed = "";
    const readiness = new Promise<void>((resolve, reject) => {
        settleReady = resolve;
        settleError = reject;
      }),
      child = this.#ports.spawn(command, [...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        settleError?.(managedRbacError("rbac_start_timeout", `${name} was not ready within ${timeoutMs}ms.`));
      }, timeoutMs),
      observe = (chunk: Buffer | string) => {
        const text = chunk.toString();
        log.write(text);
        observed = `${observed}${text}`.slice(-8_192);
        if (!readyPattern.test(observed)) return;
        clearTimeout(timer);
        settleReady?.();
      };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    child.once("error", (error) => {
      clearTimeout(timer);
      settleError?.(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      log.end();
      if (code !== 0) settleError?.(managedRbacError("rbac_process_failed", `${name} exited with ${String(code)}.`));
    });
    this.#track(name, child);
    this.#readiness.set(name, readiness);
    return readiness;
  }

  async #waitUntilReady(): Promise<Record<string, unknown>> {
    let result: Record<string, unknown> = { status: "not_checked" };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      result = await this.health();
      if (result.ready === true) return result;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw managedRbacError("rbac_health_failed", `Keycloak realm health returned HTTP ${String(result.status)}.`);
  }

  /**
   * Brings a realm that already exists up to this build's Base policy and session lifetime contract.
   * Runs as the center's own service account: the one-time bootstrap password is gone once an administrator exists.
   */
  async #syncRealm(): Promise<void> {
    const config = this.#readManagedConfig(),
      tokenResponse = await this.#ports.fetch(
        `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: config.clientId,
            client_secret: readFileSync(path.join(this.#root, "center-client-secret"), "utf8").trim(),
          }),
        },
      );
    if (!tokenResponse.ok)
      throw managedRbacError("rbac_policy_sync_failed", `Keycloak center token returned HTTP ${tokenResponse.status}.`);
    const payload = (await tokenResponse.json()) as { readonly access_token?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token)
      throw managedRbacError("rbac_policy_sync_failed", "Keycloak center token response omitted access_token.");
    const adapter = new KeycloakPolicyAdapter(
      { url: config.url, realm: config.realm, resourceServerClientId: config.clientId },
      this.#ports.fetch,
    );
    await adapter.syncBasePolicy(payload.access_token);
    await adapter.syncLoginClients(payload.access_token);
    await alignSessionLifetime(
      { url: config.url, realm: config.realm, accessToken: payload.access_token },
      this.#ports.fetch,
    );
  }

  async #configureExternal(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (!request.url || !request.realm || !request.clientId || !request.clientSecret?.trim())
      throw managedRbacError(
        "rbac_external_config_incomplete",
        "External mode requires URL, realm, client ID and a write-only client secret.",
      );
    if (request.clientId !== "harness-center")
      throw managedRbacError("rbac_external_client_invalid", "The fleet resource server must be harness-center.");
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      throw managedRbacError("rbac_external_url_insecure", "External Keycloak must use HTTPS unless it is loopback.");
    const normalizedUrl = url.toString().replace(/\/$/u, ""),
      probe = await this.#ports.fetch(`${normalizedUrl}/realms/${encodeURIComponent(request.realm)}`);
    if (!probe.ok)
      throw managedRbacError(
        "rbac_external_probe_failed",
        `External Keycloak realm probe returned HTTP ${probe.status}; configuration was not changed.`,
      );
    const tokenResponse = await this.#ports.fetch(
      `${normalizedUrl}/realms/${encodeURIComponent(request.realm)}/protocol/openid-connect/token`,
      {
        method: "POST",
        redirect: "error",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: request.clientId,
          client_secret: request.clientSecret.trim(),
        }),
      },
    );
    if (!tokenResponse.ok)
      throw managedRbacError(
        "rbac_external_credentials_rejected",
        "External Keycloak rejected the center credentials; configuration was not changed.",
      );
    let token: { readonly access_token?: unknown };
    try {
      token = (await tokenResponse.json()) as { readonly access_token?: unknown };
    } catch {
      throw managedRbacError(
        "rbac_external_credentials_rejected",
        "External Keycloak returned an invalid service token response; configuration was not changed.",
      );
    }
    if (!token || typeof token.access_token !== "string" || !token.access_token)
      throw managedRbacError(
        "rbac_external_credentials_rejected",
        "External Keycloak omitted the service token; configuration was not changed.",
      );
    // Check the administration read used by first-admin bootstrap before persisting either value.
    const admin = await this.#ports.fetch(
      `${normalizedUrl}/admin/realms/${encodeURIComponent(request.realm)}/users?max=1`,
      {
        headers: { authorization: `Bearer ${token.access_token}` },
        redirect: "error",
      },
    );
    if (!admin.ok)
      throw managedRbacError(
        "rbac_external_credentials_rejected",
        "The center credentials cannot administer the realm; configuration was not changed.",
      );
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const secretFile = path.join(this.#root, "center-client-secret");
    writeFileSync(secretFile, request.clientSecret.trim(), { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    this.#writeConfig({
      schema: "harness-managed-rbac/v1",
      mode: "external",
      url: normalizedUrl,
      realm: request.realm,
      clientId: request.clientId,
      versions: managedRbacVersions,
    });
    return { ok: true, command: "rbac-configure", mode: "external", url: normalizedUrl, realm: request.realm };
  }

  async #backup(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (!request.backupDir) throw managedRbacError("rbac_backup_dir_required", "Backup requires --backup-dir.");
    if (existsSync(request.backupDir))
      throw managedRbacError("rbac_backup_exists", "Backup destination already exists.");
    mkdirSync(request.backupDir, { recursive: true, mode: 0o700 });
    const output = path.join(request.backupDir, "keycloak-data.tar.gz"),
      wasRunning = this.#children.size > 0;
    if (wasRunning) await this.stop();
    try {
      run("tar", ["-czf", output, "-C", path.join(this.#root, "data"), "postgres"]);
      writeFileSync(
        path.join(request.backupDir, "manifest.json"),
        `${JSON.stringify(this.#readManagedConfig(), null, 2)}\n`,
        { mode: 0o600 },
      );
    } finally {
      if (wasRunning) {
        await this.start();
        await this.#waitUntilReady();
      }
    }
    return { ok: true, command: "rbac-backup", backupDir: request.backupDir, bytes: statSync(output).size };
  }

  async #restore(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (!request.backupDir) throw managedRbacError("rbac_backup_dir_required", "Restore requires --backup-dir.");
    const input = path.join(request.backupDir, "keycloak-data.tar.gz"),
      manifest = path.join(request.backupDir, "manifest.json"),
      data = path.join(this.#root, "data"),
      postgresData = path.join(data, "postgres");
    if (!existsSync(input) || !existsSync(manifest))
      throw managedRbacError("rbac_backup_invalid", "Backup must contain keycloak-data.tar.gz and manifest.json.");
    const backupConfig = JSON.parse(readFileSync(manifest, "utf8")) as ManagedRbacConfig;
    if (JSON.stringify(backupConfig.versions) !== JSON.stringify(this.#readManagedConfig().versions))
      throw managedRbacError(
        "rbac_backup_version_mismatch",
        "Backup runtime versions do not match the installed runtime.",
      );
    await this.stop();
    rmSync(postgresData, { recursive: true, force: true });
    mkdirSync(data, { recursive: true, mode: 0o700 });
    run("tar", ["-xzf", input, "-C", data]);
    await this.start();
    await this.#waitUntilReady();
    return { ok: true, command: "rbac-restore", backupDir: request.backupDir };
  }

  #readConfig(): ManagedRbacConfig {
    const file = path.join(this.#root, "config.json");
    if (!existsSync(file))
      throw managedRbacError("rbac_not_configured", "Run ha bootstrap or configure an external Keycloak first.");
    return JSON.parse(readFileSync(file, "utf8")) as ManagedRbacConfig;
  }

  #readConfigIfPresent(): ManagedRbacConfig | undefined {
    const file = path.join(this.#root, "config.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ManagedRbacConfig) : undefined;
  }

  #readManagedConfig(): ManagedRbacConfig & { readonly postgresPort: number; readonly managementPort: number } {
    const config = this.#readConfig();
    if (config.mode !== "managed" || !config.postgresPort || !config.managementPort)
      throw managedRbacError("rbac_managed_config_invalid", "Managed RBAC configuration is missing service ports.");
    return config as ManagedRbacConfig & { readonly postgresPort: number; readonly managementPort: number };
  }

  #writeConfig(config: ManagedRbacConfig): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const file = path.join(this.#root, "config.json"),
      temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }
}

export function managedRbacSessionStore(userRoot: string): {
  readonly read: () => string | undefined;
  readonly write: (value: string) => void;
  readonly delete: () => void;
  readonly retireBootstrap: () => void;
} {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "oidc-session.json");
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    write: (value) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, value, { mode: 0o600 });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    },
    delete: () => rmSync(file, { force: true }),
    retireBootstrap: () => rmSync(path.join(root, "bootstrap-admin-password"), { force: true }),
  };
}

/** Append-only audit trail of access administration. Authorization never reads it. */
export function managedRbacReceiptJournal(userRoot: string): {
  readonly read: () => readonly string[];
  readonly append: (line: string) => void;
} {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "access-receipts.jsonl");
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []),
    append: (line) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
    },
  };
}

/**
 * Reserves a new file only its owner can read, for a credential the caller writes before the
 * external write that makes it real. A path that is already taken throws instead of being
 * overwritten; the descriptor closes exactly once, so `discard` after a `keep` whose write failed
 * removes the reservation instead of failing on the closed descriptor.
 */
export function reserveCredentialFile(file: string): {
  readonly keep: (credential: string) => void;
  readonly discard: () => void;
} {
  const descriptor = openSync(file, "wx", 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
  return {
    keep: (credential) => {
      try {
        writeFileSync(descriptor, credential);
      } finally {
        close();
      }
    },
    discard: () => {
      close();
      rmSync(file, { force: true });
    },
  };
}

export function managedRbacListenerUrl(listener: Pick<ManagedRbacListener, "hostname" | "port">): string {
  return `https://${listener.hostname}:${listener.port}`;
}

function listenerVersion(listener: ManagedRbacListener | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(listener ?? null))
    .digest("hex");
}

/** No listener field means loopback only; otherwise all five describe the listener. */
function requestedListener(request: ManagedRbacRequest): ManagedRbacListener | undefined {
  const { listenAddress: address, hostname, port, certificateFile, certificateKeyFile } = request;
  if ([address, hostname, port, certificateFile, certificateKeyFile].every((value) => value === undefined))
    return undefined;
  if (
    !address ||
    isIP(address) === 0 ||
    !hostname ||
    !Number.isInteger(port) ||
    port! < 1 ||
    port! > 65_535 ||
    !URL.canParse(`https://${hostname}:${port}`) ||
    new URL(`https://${hostname}:${port}`).hostname !== hostname ||
    !certificateFile ||
    !certificateKeyFile ||
    !path.isAbsolute(certificateFile) ||
    !path.isAbsolute(certificateKeyFile) ||
    !existsSync(certificateFile)
  )
    throw managedRbacError(
      "rbac_listener_invalid",
      "A listener takes --listen-address (an IP address of this machine), --hostname (lowercase, as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  return { address, hostname, port: port!, certificateFile, certificateKeyFile };
}

function requirePrivateKeyFile(file: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : undefined;
  if (mode === undefined || (mode & 0o077) !== 0)
    throw managedRbacError(
      "rbac_listener_key_exposed",
      mode === undefined
        ? `The listener's private key ${file} does not exist.`
        : `The listener's private key ${file} has mode ${mode.toString(8).padStart(4, "0")}; only its owner may read it (chmod 600).`,
    );
}

function listenPassthrough(listener: ManagedRbacListener, httpsPort: number): Promise<Server> {
  const server = createServer((client) => {
    const keycloak = connect(httpsPort, "127.0.0.1");
    client.pipe(keycloak).pipe(client);
    client.on("error", () => keycloak.destroy());
    keycloak.on("error", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        managedRbacError(
          "rbac_listener_unavailable",
          `Could not listen on ${listener.address}:${listener.port}: ${error.message}`,
        ),
      ),
    );
    server.listen(listener.port, listener.address, () => resolve(server));
  });
}

export function artifactManifest(platform: SupportedPlatform): readonly Artifact[] {
  const [os, arch] = platform.split("-") as ["darwin" | "linux", "arm64" | "x64"],
    adoptiumOs = os === "darwin" ? "mac" : "linux",
    adoptiumArch = arch === "arm64" ? "aarch64" : "x64",
    zonkyPlatform = os === "darwin" ? "darwin" : "linux",
    zonkyArch = arch === "arm64" ? "arm64v8" : "amd64",
    zonkyArtifact = `embedded-postgres-binaries-${zonkyPlatform}-${zonkyArch}`,
    zonkyBase = `https://repo1.maven.org/maven2/io/zonky/test/postgres/${zonkyArtifact}/${managedRbacVersions.postgres}/${zonkyArtifact}-${managedRbacVersions.postgres}.jar`,
    temurinBase = `https://api.adoptium.net/v3/binary/version/jdk-${encodeURIComponent(managedRbacVersions.java)}/${adoptiumOs}/${adoptiumArch}/jre/hotspot/normal/eclipse`;
  return [
    {
      name: "keycloak",
      url: `https://github.com/keycloak/keycloak/releases/download/${managedRbacVersions.keycloak}/keycloak-${managedRbacVersions.keycloak}.tar.gz`,
      checksumUrl: `https://api.github.com/repos/keycloak/keycloak/releases/tags/${managedRbacVersions.keycloak}`,
      algorithm: "sha256",
      checksumFormat: "github-release",
      archive: "tar.gz",
    },
    {
      name: "java",
      url: temurinBase,
      checksumUrl: temurinBase.replace("/binary/", "/checksum/"),
      algorithm: "sha256",
      checksumFormat: "raw",
      archive: "tar.gz",
    },
    {
      name: "postgres",
      url: zonkyBase,
      checksumUrl: `${zonkyBase}.sha256`,
      algorithm: "sha256",
      checksumFormat: "raw",
      archive: "jar-txz",
    },
  ];
}

function publishedDigest(artifact: Artifact, body: string): string | undefined {
  if (artifact.checksumFormat === "raw") return body.trim().split(/\s+/u)[0]?.toLowerCase();
  const release = JSON.parse(body) as {
      readonly assets?: readonly { readonly name?: string; readonly digest?: string }[];
    },
    filename = new URL(artifact.url).pathname.split("/").at(-1),
    digest = release.assets?.find((asset) => asset.name === filename)?.digest;
  return digest?.startsWith(`${artifact.algorithm}:`)
    ? digest.slice(artifact.algorithm.length + 1).toLowerCase()
    : undefined;
}

function supportedPlatform(platform: NodeJS.Platform, arch: string): SupportedPlatform {
  const key = `${platform}-${arch}`;
  if (key === "darwin-arm64" || key === "darwin-x64" || key === "linux-x64") return key;
  throw managedRbacError(
    "rbac_platform_unsupported",
    `Managed RBAC supports macOS arm64/x64 and Linux x64; received ${key}.`,
  );
}

async function availableLoopbackPorts(): Promise<readonly [number, number, number]> {
  const first = createServer(),
    second = createServer(),
    third = createServer();
  try {
    const firstPort = await listenOnAvailableLoopbackPort(first),
      secondPort = await listenOnAvailableLoopbackPort(second),
      thirdPort = await listenOnAvailableLoopbackPort(third);
    return [firstPort, secondPort, thirdPort];
  } finally {
    if (first.listening) first.close();
    if (second.listening) second.close();
    if (third.listening) third.close();
  }
}

function listenOnAvailableLoopbackPort(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(managedRbacError("rbac_port_allocation_failed", "Could not allocate a loopback port."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function digestFile(file: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const digest = createHash(algorithm);
  await pipeline(createReadStream(file), digest);
  return digest.digest("hex");
}

function extractArtifact(archive: string, destination: string, format: Artifact["archive"]): void {
  if (format === "tar.gz") return run("tar", ["-xzf", archive, "-C", destination]);
  const unpacked = path.join(destination, "jar");
  mkdirSync(unpacked, { recursive: true });
  run("unzip", ["-q", archive, "-d", unpacked]);
  const txz = findFile(unpacked, ".txz");
  if (!txz) throw managedRbacError("rbac_archive_invalid", "PostgreSQL bundle does not contain a .txz archive.");
  run("tar", ["-xJf", txz, "-C", destination]);
  rmSync(unpacked, { recursive: true, force: true });
}

function findFile(root: string, suffix: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(candidate, suffix);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
  }
  return null;
}

function flattenSingleDirectory(root: string): void {
  const entries = readdirSync(root, { withFileTypes: true }),
    directories = entries.filter((entry) => entry.isDirectory());
  if (entries.length !== 1 || directories.length !== 1 || existsSync(path.join(root, "bin"))) return;
  const child = path.join(root, directories[0]!.name);
  for (const entry of readdirSync(child)) renameSync(path.join(child, entry), path.join(root, entry));
  rmSync(child, { recursive: true, force: true });
}

function javaHomePath(root: string, platform: NodeJS.Platform): string {
  const base = path.join(root, "runtime", "java");
  return platform === "darwin" && existsSync(path.join(base, "Contents", "Home"))
    ? path.join(base, "Contents", "Home")
    : base;
}

function readOrCreateSecret(file: string): string {
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

function run(command: string, args: readonly string[]): void {
  try {
    runProcessText(command, args);
  } catch (error) {
    throw managedRbacError(
      "rbac_process_failed",
      `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function managedRbacError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

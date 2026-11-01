import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  openSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { consumeKnownError } from "@harness-anything/kernel";
import type { ManagedRbacHost } from "./managed-host.ts";
import type { ManagedRbacRequest, ManagedRbacListener, CertificateMode } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { keycloakLoginAttributes, keycloakLoginMappers } from "./keycloak-login-client.ts";
import { transientTransportFailure } from "./oidc-session-helpers.ts";
import {
  alignSessionLifetime,
  sessionLifetimeBounds,
  sessionLifetimeRealmSettings,
} from "./keycloak-session-lifetime.ts";

import {
  ensureSelfSignedCertificate,
  firstReachableAddress,
  listenerVersion,
  removeSelfSignedCertificate,
  publicListener,
  requestedListener,
  validateListenerInput,
} from "./managed-rbac-listener-certificate.ts";

export const managedRbacVersions = Object.freeze({
  keycloak: "26.7.3",
  java: "21.0.12.1+1",
  postgres: "18.3.0",
});

type SupportedPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "win32-arm64" | "win32-x64";
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
  readonly certificateMode?: CertificateMode;
  /** An operator stopped the managed services; a daemon start leaves them down until they are started again. */
  readonly stopped?: boolean;
}

interface Artifact {
  readonly name: "keycloak" | "java" | "postgres";
  readonly url: string;
  readonly checksumUrl: string;
  readonly algorithm: "sha1" | "sha256";
  readonly checksumFormat: "raw" | "github-release";
  readonly archive: "tar.gz" | "jar-txz" | "zip";
}

export interface ManagedRbacPorts {
  readonly fetch: typeof fetch;
  readonly spawn: typeof spawn;
  readonly now: () => string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface ManagedPostgresBinaries {
  readonly initdb: string;
  readonly postgres: string;
  readonly pgCtl: string;
}

const defaultPorts: ManagedRbacPorts = {
  fetch,
  spawn,
  now: () => new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
};

export class ManagedRbacService {
  readonly #host: ManagedRbacHost;
  #execute(command: string, args: readonly string[]): void {
    run(command, args, this.#host.runProcessText);
  }
  readonly #root: string;
  readonly #ports: ManagedRbacPorts;
  readonly #children = new Map<"postgres" | "keycloak", ChildProcess>();
  readonly #readiness = new Map<"postgres" | "keycloak", Promise<void>>();
  #lifecycle: Promise<unknown> = Promise.resolve();

  constructor(userRoot: string, host: ManagedRbacHost, ports: Partial<ManagedRbacPorts> = {}) {
    this.#host = host;
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

  /**
   * The login listener's certificate pair for daemon-owned TLS surfaces that serve the same
   * machines (the fleet center reuses it when its start carries no explicit certificate).
   * The private-key path stays daemon-side; the sanitized listener read never carries it out.
   */
  loginListenerCertificate(): { readonly certificateFile: string; readonly certificateKeyFile: string } | null {
    const listener = this.#readConfigIfPresent()?.listener;
    return listener
      ? { certificateFile: listener.certificateFile, certificateKeyFile: listener.certificateKeyFile }
      : null;
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
      const config = this.#readManagedConfig();
      const { listener } = config;
      return {
        ok: true,
        command: "rbac-listener",
        listener: listener ? publicListener(listener) : null,
        certificateMode: config.certificateMode ?? (listener ? "domain" : "self-signed"),
        version: listenerVersion(listener, config.certificateMode),
      };
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
    if (!existsSync(managedExecutable(this.#root, "runtime/postgres/bin/postgres", this.#ports.platform)))
      throw managedRbacError("rbac_not_installed", "Run ha bootstrap before starting managed RBAC services.");
    if (config.stopped) this.#writeConfig({ ...config, stopped: false });
    await this.#startPostgres();
    await this.#startKeycloak();
  }

  /** Install and resolve only the managed PostgreSQL artifact for isolated storage integration tests. */
  async ensurePostgresBinaries(): Promise<ManagedPostgresBinaries> {
    const platform = supportedPlatform(this.#ports.platform, this.#ports.arch),
      runtime = path.join(this.#root, "runtime"),
      postgresArtifact = artifactManifest(platform).find((artifact) => artifact.name === "postgres");
    if (!postgresArtifact)
      throw managedRbacError("rbac_artifact_missing", "The managed artifact manifest has no PostgreSQL entry.");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    await this.#installArtifact(postgresArtifact, runtime);
    return {
      initdb: managedExecutable(this.#root, "runtime/postgres/bin/initdb", this.#ports.platform),
      postgres: managedExecutable(this.#root, "runtime/postgres/bin/postgres", this.#ports.platform),
      pgCtl: managedExecutable(this.#root, "runtime/postgres/bin/pg_ctl", this.#ports.platform),
    };
  }

  async stop(): Promise<Record<string, unknown>> {
    const stopped: string[] = [];
    for (const name of ["keycloak", "postgres"] as const) if (await this.#stopChild(name)) stopped.push(name);
    return { ok: true, command: "rbac-stop", stopped };
  }

  async #stopChild(name: "postgres" | "keycloak"): Promise<boolean> {
    const child = this.#children.get(name);
    if (!child) return false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", finish);
        resolve();
      };
      timer.unref();
      child.once("exit", finish);
      if (
        (child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined)
      ) {
        finish();
        return;
      }
      child.kill("SIGTERM");
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
    if (
      request.certificateMode !== undefined &&
      !["self-signed", "domain", "internal-ca"].includes(request.certificateMode)
    )
      throw managedRbacError("rbac_listener_invalid", "Certificate mode must be self-signed, domain, or internal-ca.");
    const config = this.#readManagedConfig(),
      currentVersion = listenerVersion(config.listener, config.certificateMode),
      expectedVersion = request.expectedVersion;
    if (!expectedVersion)
      throw managedRbacError(
        "rbac_listener_invalid",
        "Changing the listener requires --expected-version; read it with --operation listener.",
      );
    if (expectedVersion !== currentVersion)
      return { ok: false, code: "version_conflict", command: "rbac-listener-set", expectedVersion, currentVersion };
    const listener = await this.#requestedListener(request),
      certificateMode = request.certificateMode ?? (listener ? (config.certificateMode ?? "domain") : "self-signed"),
      { listener: _replaced, certificateMode: _oldMode, ...loopback } = config,
      apply = async (next: ManagedRbacConfig): Promise<void> => {
        await this.#stopChild("keycloak");
        this.#writeConfig(next);
        await this.start();
        await this.#waitUntilReady();
      };
    if (listener) {
      requirePrivateKeyFile(listener.certificateKeyFile);
      this.#host.validateCertificateNames(readFileSync(listener.certificateFile), [
        listener.address,
        listener.hostname,
      ]);
    }
    try {
      await apply(listener ? { ...loopback, listener, certificateMode } : { ...loopback, certificateMode });
      if (certificateMode === "domain" || certificateMode === "internal-ca") removeSelfSignedCertificate(this.#root);
    } catch (error) {
      await apply(config);
      throw this.#host.mapListenerBindError(error);
    }
    return {
      ok: true,
      command: "rbac-listener-set",
      listener: listener ? publicListener(listener) : null,
      certificateMode,
      version: listenerVersion(listener, certificateMode),
    };
  }

  async #requestedListener(request: ManagedRbacRequest): Promise<ManagedRbacListener | undefined> {
    const mode = request.certificateMode;
    if (mode === "self-signed") {
      const address = request.listenAddress ?? firstReachableAddress();
      const hostname = request.hostname ?? address;
      const port = request.port ?? 8443;
      const endpoint = validateListenerInput(address, hostname, port),
        generated = await ensureSelfSignedCertificate(this.#root, endpoint.hostname, endpoint.address, this.#host);
      this.#host.validateCertificateNames(readFileSync(generated.certificateFile), [
        endpoint.address,
        endpoint.hostname,
      ]);
      return {
        ...endpoint,
        certificateFile: generated.certificateFile,
        certificateKeyFile: generated.certificateKeyFile,
      };
    }
    return requestedListener(request);
  }

  async health(): Promise<Record<string, unknown>> {
    const config = this.#readConfig();
    const response = await this.#ports.fetch(`${config.url}/realms/${encodeURIComponent(config.realm)}`);
    return {
      ok: response.ok,
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
    const certificateMode =
      existing?.mode === "managed"
        ? (existing.certificateMode ?? (existing.listener ? "domain" : "self-signed"))
        : "self-signed";
    // A listener publishes the login service to the network. Bootstrap leaves Keycloak on loopback;
    // exposing it is an explicit listener-set, and an existing operator choice is preserved.
    const listener = existing?.mode === "managed" ? existing.listener : undefined;
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
      ...(listener ? { listener } : {}),
      ...(certificateMode ? { certificateMode } : {}),
    });
  }

  async #installArtifact(artifact: Artifact, runtime: string): Promise<void> {
    const destination = path.join(runtime, artifact.name);
    const marker = path.join(destination, ".installed");
    if (existsSync(marker) && readFileSync(marker, "utf8").startsWith(`${artifact.url}\n`)) return;
    const downloads = path.join(this.#root, "downloads");
    mkdirSync(downloads, { recursive: true, mode: 0o700 });
    const archive = path.join(
        downloads,
        `${artifact.name}.${artifact.archive === "jar-txz" ? "jar" : artifact.archive === "zip" ? "zip" : "tar.gz"}`,
      ),
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
    extractArtifact(archive, destination, artifact.archive, this.#ports.platform, this.#host.runProcessText);
    flattenSingleDirectory(destination);
    writeFileSync(marker, `${artifact.url}\n${actual}\n`, { mode: 0o600 });
  }

  #postgresPasswordFile(): string {
    return path.join(this.#root, "postgres-password");
  }

  #postgresPassword(): string {
    return readOrCreateSecret(this.#postgresPasswordFile());
  }

  #initializeDatabase(): void {
    const data = path.join(this.#root, "data", "postgres"),
      passwordFile = this.#postgresPasswordFile(),
      initdb = managedExecutable(this.#root, "runtime/postgres/bin/initdb", this.#ports.platform);
    if (existsSync(path.join(data, "PG_VERSION"))) return;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    this.#postgresPassword();
    this.#execute(initdb, [
      "-D",
      data,
      "--username=postgres",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--no-locale",
    ]);
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

  async #startPostgres(): Promise<void> {
    const active = this.#readiness.get("postgres");
    if (active) return active;
    const config = this.#readManagedConfig(),
      binary = managedExecutable(this.#root, "runtime/postgres/bin/postgres", this.#ports.platform),
      data = path.join(this.#root, "data", "postgres"),
      logs = path.join(this.#root, "logs");
    await this.#hardenPostgresAuthentication(binary, data);
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
   * A data directory initialized before password authentication allowed every local process in with
   * `trust`. Set the postgres role's password with the bundled postgres in single-user mode — the
   * runtime ships no psql — then rewrite the trust lines to scram-sha-256. Single-user mode does not
   * use pg_hba.conf, so the statement runs before any password is required. No trust branch survives,
   * so a failed migration fails the start instead of leaving an open database.
   */
  async #hardenPostgresAuthentication(binary: string, data: string): Promise<void> {
    const hba = path.join(data, "pg_hba.conf");
    if (!existsSync(hba) || !postgresHbaUsesTrust(readFileSync(hba, "utf8"))) return;
    const password = this.#postgresPassword(),
      applied = "harness-postgres-password-applied",
      sql = [
        `ALTER ROLE postgres WITH PASSWORD '${password.replaceAll("'", "''")}';`,
        `SELECT '${applied}' FROM pg_authid WHERE rolname = 'postgres' AND rolpassword LIKE 'SCRAM-SHA-256$%';`,
        "",
      ].join("\n");
    let result: Awaited<ReturnType<ManagedRbacHost["runProcessExitAsync"]>>;
    try {
      result = await this.#host.runProcessExitAsync(
        binary,
        ["--single", "-D", data, "postgres"],
        undefined,
        undefined,
        sql,
        undefined,
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error";
      throw managedRbacError(
        "rbac_postgres_password_failed",
        `The bundled postgres could not run in single-user mode (${code}).`,
      );
    }
    // Single-user mode reports SQL errors but still exits 0, and its error output can echo the
    // statement (including the password). Read the sentinel row instead of trusting the exit code,
    // and keep stderr out of the thrown message.
    if (!result.stdout.includes(applied) || /(?:^|\n)[^\n]*\b(?:ERROR|FATAL):/u.test(result.stderr))
      throw managedRbacError(
        "rbac_postgres_password_failed",
        "Setting the PostgreSQL password with the bundled postgres failed; trust authentication was left in place.",
      );
    const hardened = hardenPostgresHba(readFileSync(hba, "utf8"));
    if (postgresHbaUsesTrust(hardened))
      throw managedRbacError(
        "rbac_postgres_auth_insecure",
        "Could not remove trust authentication from the PostgreSQL data directory.",
      );
    writeFileSync(hba, hardened, { mode: 0o600 });
    chmodSync(hba, 0o600);
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
      kc = managedExecutable(this.#root, "runtime/keycloak/bin/kc.sh", this.#ports.platform);
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
        KC_DB_PASSWORD: this.#postgresPassword(),
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
      path.join(this.#root, "runtime", "keycloak"),
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
    cwd?: string,
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
      [launchCommand, launchArgs] = windowsBatchLaunch(command, args, this.#ports.platform),
      child = this.#ports.spawn(launchCommand, launchArgs, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
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
    let result: Record<string, unknown> = { status: "not_checked" },
      transportFailure: unknown = null;
    const attempts = this.#ports.platform === "win32" ? 720 : 120;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const healthAttempt = await healthReadinessAttempt(() => this.health());
      if ("transportFailure" in healthAttempt) {
        transportFailure = healthAttempt.transportFailure;
      } else {
        result = healthAttempt.result;
        transportFailure = null;
        if (result.ready === true) return result;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (transportFailure)
      throw Object.assign(
        new Error("Keycloak realm health could not be reached before the readiness deadline.", {
          cause: transportFailure,
        }),
        { code: "rbac_health_failed" },
      );
    throw managedRbacError(
      "rbac_health_failed",
      `Keycloak realm health returned HTTP ${String(result.status)} after ${String(attempts * 250)}ms.`,
    );
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
      this.#execute("tar", ["-czf", output, "-C", path.join(this.#root, "data"), "postgres"]);
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
    this.#execute("tar", ["-xzf", input, "-C", data]);
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

export function managedRbacSessionStore(
  userRoot: string,
  issuer: string,
  realm: string,
): {
  readonly read: () => string | undefined;
  readonly write: (value: string) => void;
  readonly delete: () => void;
  readonly retireBootstrap: () => void;
} {
  const root = path.join(userRoot, "rbac"),
    key = createHash("sha256")
      .update(JSON.stringify([issuer, realm]))
      .digest("hex"),
    directory = path.join(root, "oidc-sessions"),
    file = path.join(directory, `${key}.json`);
  rmSync(path.join(root, "oidc-session.json"), { force: true });
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    write: (value) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, value, { mode: 0o600 });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    },
    delete: () => rmSync(file, { force: true }),
    retireBootstrap: () => rmSync(path.join(root, "bootstrap-admin-password"), { force: true }),
  };
}

export function managedRbacListenerUrl(listener: Pick<ManagedRbacListener, "hostname" | "port">): string {
  return `https://${listener.hostname}:${listener.port}`;
}

function requirePrivateKeyFile(file: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : undefined;
  if (mode === undefined || (mode & 0o077) !== 0)
    throw managedRbacError(
      "rbac_listener_key_exposed",
      mode === undefined
        ? "The listener's private key must be present and readable only by its owner (chmod 600)."
        : "The listener's private key must be readable only by its owner (chmod 600).",
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
  const [os, arch] = platform.split("-") as ["darwin" | "linux" | "win32", "arm64" | "x64"],
    windows = os === "win32",
    adoptiumOs = windows ? "windows" : os === "darwin" ? "mac" : "linux",
    // Zonky does not publish Windows arm64. Windows arm64 runs the amd64 bundle under system emulation.
    adoptiumArch = windows ? "x64" : arch === "arm64" ? "aarch64" : "x64",
    zonkyPlatform = windows ? "windows" : os === "darwin" ? "darwin" : "linux",
    zonkyArch = windows ? "amd64" : arch === "arm64" ? "arm64v8" : "amd64",
    zonkyArtifact = `embedded-postgres-binaries-${zonkyPlatform}-${zonkyArch}`,
    zonkyBase = `https://repo1.maven.org/maven2/io/zonky/test/postgres/${zonkyArtifact}/${managedRbacVersions.postgres}/${zonkyArtifact}-${managedRbacVersions.postgres}.jar`,
    temurinBase = `https://api.adoptium.net/v3/binary/version/jdk-${encodeURIComponent(managedRbacVersions.java)}/${adoptiumOs}/${adoptiumArch}/jre/hotspot/normal/eclipse`;
  return [
    {
      name: "keycloak",
      url: `https://github.com/keycloak/keycloak/releases/download/${managedRbacVersions.keycloak}/keycloak-${managedRbacVersions.keycloak}.${windows ? "zip" : "tar.gz"}`,
      checksumUrl: `https://api.github.com/repos/keycloak/keycloak/releases/tags/${managedRbacVersions.keycloak}`,
      algorithm: "sha256",
      checksumFormat: "github-release",
      archive: windows ? "zip" : "tar.gz",
    },
    {
      name: "java",
      url: temurinBase,
      checksumUrl: temurinBase.replace("/binary/", "/checksum/"),
      algorithm: "sha256",
      checksumFormat: "raw",
      archive: windows ? "zip" : "tar.gz",
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
  if (
    key === "darwin-arm64" ||
    key === "darwin-x64" ||
    key === "linux-x64" ||
    key === "win32-arm64" ||
    key === "win32-x64"
  )
    return key;
  throw managedRbacError(
    "rbac_platform_unsupported",
    `Managed RBAC supports macOS arm64/x64, Linux x64, and Windows x64/arm64 (x64 runtime on arm64); received ${key}.`,
  );
}

function managedExecutable(root: string, relative: string, platform: NodeJS.Platform): string {
  const windowsRelative = relative.endsWith(".sh") ? relative.slice(0, -3) + ".bat" : `${relative}.exe`;
  return path.join(root, platform === "win32" ? windowsRelative : relative);
}

function windowsBatchLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): readonly [string, readonly string[]] {
  if (platform !== "win32" || !command.toLowerCase().endsWith(".bat")) return [command, [...args]];
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`,
    commandLine = `& ${quote(command)} ${args.map(quote).join(" ")}`,
    encoded = Buffer.from(commandLine, "utf16le").toString("base64");
  return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]];
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

function extractArtifact(
  archive: string,
  destination: string,
  format: Artifact["archive"],
  platform: NodeJS.Platform,
  execute: ManagedRbacHost["runProcessText"],
): void {
  const run = (command: string, args: readonly string[]) => {
    execute(command, args);
  };
  if (format === "tar.gz") return run("tar", ["-xzf", archive, "-C", destination]);
  if (format === "zip") return run("tar", ["-xf", archive, "-C", destination]);
  const unpacked = path.join(destination, "jar");
  mkdirSync(unpacked, { recursive: true });
  run(
    platform === "win32" ? "tar" : "unzip",
    platform === "win32" ? ["-xf", archive, "-C", unpacked] : ["-q", archive, "-d", unpacked],
  );
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

/** Whether any non-comment pg_hba.conf line accepts a connection without a password. */
function postgresHbaUsesTrust(hba: string): boolean {
  return hba.split(/\r?\n/u).some((line) => {
    const body = line.trim();
    if (body === "" || body.startsWith("#")) return false;
    const fields = body.split(/\s+/u),
      methodIndex = fields[0] === "local" ? 3 : 4;
    return (fields[0] === "local" || fields[0]?.startsWith("host") === true) && fields[methodIndex] === "trust";
  });
}

/** Rewrites only trust methods; reject, peer, certificate, and other operator choices stay as they are. */
function hardenPostgresHba(hba: string): string {
  return hba
    .split(/\r?\n/u)
    .map((line) => {
      const body = line.trim();
      if (body === "" || body.startsWith("#")) return line;
      const fields = body.split(/\s+/u),
        methodIndex = fields[0] === "local" ? 3 : 4;
      if (fields[0] !== "local" && fields[0]?.startsWith("host") !== true) return line;
      if (fields[methodIndex] !== "trust") return line;
      fields[methodIndex] = "scram-sha-256";
      return `${line.slice(0, line.length - line.trimStart().length)}${fields.join(" ")}`;
    })
    .join("\n");
}

function readOrCreateSecret(file: string): string {
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString("base64url"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

function run(command: string, args: readonly string[], execute: ManagedRbacHost["runProcessText"]): void {
  try {
    execute(command, args);
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

async function healthReadinessAttempt(
  health: () => Promise<Record<string, unknown>>,
): Promise<{ readonly result: Record<string, unknown> } | { readonly transportFailure: unknown }> {
  try {
    return { result: await health() };
  } catch (error) {
    if (transientTransportFailure(error)) return { transportFailure: error };
    throw error;
  }
}

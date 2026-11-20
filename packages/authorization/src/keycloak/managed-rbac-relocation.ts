import { sha256Bytes } from "@harness-anything/kernel";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CertificateMode, ManagedRbacListener, ManagedRbacRequest } from "@harness-anything/kernel";
import { requestedListener } from "./managed-rbac-listener-certificate.ts";

export type ManagedRbacSupportedPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "win32-arm64" | "win32-x64";

export interface ManagedRbacConfig {
  readonly schema: "harness-managed-rbac/v1";
  readonly mode: "managed" | "external";
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly versions: { readonly keycloak: string; readonly java: string; readonly postgres: string };
  readonly installedPlatform?: ManagedRbacSupportedPlatform;
  readonly installedAt?: string;
  readonly postgresPort?: number;
  readonly managementPort?: number;
  readonly listener?: ManagedRbacListener;
  readonly listenerGeneration?: string;
  readonly certificateMode?: CertificateMode;
  readonly stopped?: boolean;
}

export type ManagedRbacManagedConfig = ManagedRbacConfig & {
  readonly mode: "managed";
  readonly postgresPort: number;
  readonly managementPort: number;
};

export interface ManagedRbacRelocationExportOptions {
  readonly bundleDir: string;
  readonly edgeJoinJournal?: RelocationJsonValue;
}

export interface ManagedRbacRelocationImportOptions {
  readonly bundleDir: string;
  readonly loginUrl: string;
  readonly listenAddress: string;
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
  readonly certificateMode?: Exclude<CertificateMode, "self-signed">;
}

interface ManagedRbacRelocationMaterial {
  readonly listener: ManagedRbacListener | undefined;
  readonly listenerGeneration: string | undefined;
  readonly stagedDirectory: string | undefined;
}

export interface ManagedRbacRelocationPorts {
  readonly readConfig: () => ManagedRbacManagedConfig;
  readonly writeConfig: (config: ManagedRbacConfig) => void;
  readonly readCenterClientSecret: () => string;
  readonly writeCenterClientSecret: (secret: string) => void;
  readonly requireRunningServices: () => void;
  readonly stopKeycloak: () => Promise<void>;
  readonly restartKeycloak: () => Promise<void>;
  readonly runKeycloakCli: (args: readonly string[], config: ManagedRbacManagedConfig) => Promise<void>;
  readonly prepareListenerMaterial: (
    request: ManagedRbacRequest,
    config: ManagedRbacManagedConfig,
    certificateMode: Exclude<CertificateMode, "self-signed">,
  ) => Promise<ManagedRbacRelocationMaterial>;
  readonly pruneListenerVersions: (
    active: ManagedRbacListener | undefined,
    previous: ManagedRbacListener | undefined,
  ) => { readonly ok: true } | { readonly ok: false; readonly error: string };
}

export type RelocationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RelocationJsonValue[]
  | { readonly [key: string]: RelocationJsonValue };

export type ManagedRbacRelocationEntryName = "realm.json" | "center-client-secret" | "edge-join-journal.json";

export interface ManagedRbacRelocationEntry {
  readonly name: ManagedRbacRelocationEntryName;
  readonly sha256: string;
}

export interface ManagedRbacRelocationManifest {
  readonly schema: "harness-keycloak-relocation/v1";
  readonly realm: string;
  readonly entries: readonly ManagedRbacRelocationEntry[];
}

export interface ManagedRbacRelocationBundleInput {
  readonly realm: string;
  readonly realmJson: string | Buffer;
  readonly centerClientSecret: string;
  readonly edgeJoinJournal?: RelocationJsonValue;
}

export interface ManagedRbacRelocationBundle extends Omit<ManagedRbacRelocationBundleInput, "realmJson"> {
  readonly manifest: ManagedRbacRelocationManifest;
  readonly realmJson: string;
}

const entryNames: readonly ManagedRbacRelocationEntryName[] = [
  "center-client-secret",
  "edge-join-journal.json",
  "realm.json",
];

export function writeManagedRbacRelocationBundle(directory: string, input: ManagedRbacRelocationBundleInput): void {
  if (existsSync(directory))
    throw relocationError("rbac_relocation_bundle_exists", "Relocation destination already exists.");
  if (!/^[A-Za-z0-9._-]+$/u.test(input.realm) || input.centerClientSecret.trim().length === 0)
    throw relocationError("rbac_relocation_bundle_invalid", "Relocation realm or center credential is invalid.");
  const realmBytes = Buffer.isBuffer(input.realmJson) ? input.realmJson : Buffer.from(input.realmJson, "utf8"),
    files = new Map<ManagedRbacRelocationEntryName, Buffer>([
      ["center-client-secret", Buffer.from(input.centerClientSecret, "utf8")],
      ["realm.json", realmBytes],
    ]);
  if (input.edgeJoinJournal !== undefined) {
    const journal = JSON.stringify(input.edgeJoinJournal);
    if (journal === undefined)
      throw relocationError("rbac_relocation_bundle_invalid", "Edge-join journal is not JSON data.");
    files.set("edge-join-journal.json", Buffer.from(`${journal}\n`, "utf8"));
  }
  parseJson(files.get("realm.json")!, "realm.json");

  const manifest: ManagedRbacRelocationManifest = {
      schema: "harness-keycloak-relocation/v1",
      realm: input.realm,
      entries: [...files.entries()]
        .map(([name, contents]) => ({ name, sha256: digest(contents) }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    },
    parent = path.dirname(directory);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(parent, {
    recursive: true,
    mode: 0o700,
  });
  const staging = mkdtempSync(path.join(parent, `.rbac-relocation-${process.pid}-`));
  try {
    for (const [name, contents] of files) writePrivateFile(path.join(staging, name), contents);
    writePrivateFile(
      path.join(staging, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(staging, directory);
  } finally {
    if (existsSync(staging))
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(staging, {
        recursive: true,
        force: true,
      });
  }
}

export function readManagedRbacRelocationBundle(directory: string): ManagedRbacRelocationBundle {
  const manifestBytes = readRegularFile(directory, "manifest.json"),
    manifest = parseJson(manifestBytes, "manifest.json");
  if (
    !isRecord(manifest) ||
    manifest.schema !== "harness-keycloak-relocation/v1" ||
    typeof manifest.realm !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(manifest.realm) ||
    !Array.isArray(manifest.entries) ||
    Object.keys(manifest).sort().join(",") !== "entries,realm,schema"
  )
    throw relocationError("rbac_relocation_bundle_invalid", "Relocation manifest schema is invalid.");

  const entries = new Map<ManagedRbacRelocationEntryName, string>();
  for (const value of manifest.entries) {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "name,sha256" ||
      typeof value.name !== "string" ||
      !entryNames.includes(value.name as ManagedRbacRelocationEntryName) ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      entries.has(value.name as ManagedRbacRelocationEntryName)
    )
      throw relocationError("rbac_relocation_bundle_invalid", "Relocation manifest entry list is invalid.");
    entries.set(value.name as ManagedRbacRelocationEntryName, value.sha256);
  }
  const hasJournal = entries.has("edge-join-journal.json"),
    expectedNames = hasJournal ? entryNames : entryNames.filter((name) => name !== "edge-join-journal.json");
  if (entries.size !== expectedNames.length || expectedNames.some((name) => !entries.has(name)))
    throw relocationError("rbac_relocation_bundle_invalid", "Relocation manifest is missing required entries.");

  const contents = new Map<ManagedRbacRelocationEntryName, Buffer>();
  for (const name of expectedNames) {
    const bytes = readRegularFile(directory, name);
    if (digest(bytes) !== entries.get(name))
      throw relocationError(
        "rbac_relocation_integrity_failed",
        `Relocation entry ${name} failed SHA-256 verification.`,
      );
    contents.set(name, bytes);
  }
  const secret = contents.get("center-client-secret")!.toString("utf8"),
    realmJson = contents.get("realm.json")!.toString("utf8");
  if (!secret.trim()) throw relocationError("rbac_relocation_bundle_invalid", "Relocation center credential is empty.");
  parseJson(realmJson, "realm.json");
  const journal = contents.has("edge-join-journal.json")
    ? parseJson(contents.get("edge-join-journal.json")!, "edge-join-journal.json")
    : undefined;

  return {
    manifest: manifest as unknown as ManagedRbacRelocationManifest,
    realm: manifest.realm,
    realmJson,
    centerClientSecret: secret,
    ...(journal === undefined ? {} : { edgeJoinJournal: journal as RelocationJsonValue }),
  };
}

function readRegularFile(directory: string, name: string): Buffer {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw relocationError("rbac_relocation_bundle_invalid", "Relocation bundle root must be a directory.");
  const file = path.join(directory, name);
  if (!existsSync(file))
    throw relocationError("rbac_relocation_bundle_invalid", `Relocation bundle is missing ${name}.`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw relocationError("rbac_relocation_bundle_invalid", `Relocation entry ${name} must be a regular file.`);
  return readFileSync(file);
}

function writePrivateFile(file: string, contents: Buffer): void {
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ writeFileSync(file, contents, {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(file, 0o600);
}

function digest(contents: Buffer): string {
  return sha256Bytes(contents);
}

function parseJson(value: Buffer | string, name: string): unknown {
  try {
    return JSON.parse(value.toString());
  } catch {
    throw relocationError("rbac_relocation_bundle_invalid", `Relocation entry ${name} is not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relocationError(code: string, message: string): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class ManagedRbacRelocationService {
  readonly #root: string;
  readonly #ports: ManagedRbacRelocationPorts;

  constructor(root: string, ports: ManagedRbacRelocationPorts) {
    this.#root = root;
    this.#ports = ports;
  }

  async exportBundle(input: ManagedRbacRelocationExportOptions): Promise<Record<string, unknown>> {
    const config = this.#ports.readConfig();
    this.#ports.requireRunningServices();
    const destination = path.resolve(input.bundleDir),
      temporaryRoot = path.join(this.#root, `.rbac-relocation-export-${randomBytes(10).toString("hex")}`),
      realmFile = path.join(temporaryRoot, "realm.json");
    if (existsSync(destination))
      throw relocationError("rbac_relocation_bundle_exists", "Relocation destination already exists.");
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(temporaryRoot, {
      recursive: false,
      mode: 0o700,
    });
    try {
      await this.#ports.stopKeycloak();
      await this.#ports.runKeycloakCli(
        ["export", "--file", realmFile, "--realm", config.realm, "--users", "same_file"],
        config,
      );
      chmodSync(realmFile, 0o600);
      const realmJson = readFileSync(realmFile, "utf8"),
        realm = JSON.parse(realmJson) as Readonly<Record<string, unknown>>;
      if (realm.realm !== config.realm)
        throw relocationError("rbac_relocation_realm_invalid", "Keycloak exported a different realm.");
      writeManagedRbacRelocationBundle(destination, {
        realm: config.realm,
        realmJson,
        centerClientSecret: this.#ports.readCenterClientSecret(),
        ...(input.edgeJoinJournal === undefined ? {} : { edgeJoinJournal: input.edgeJoinJournal }),
      });
      return {
        ok: true,
        command: "rbac-relocation-export",
        bundleDir: destination,
        entryCount: input.edgeJoinJournal === undefined ? 2 : 3,
      };
    } finally {
      try {
        await this.#ports.restartKeycloak();
      } finally {
        /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(temporaryRoot, {
          recursive: true,
          force: true,
        });
      }
    }
  }

  async importBundle(input: ManagedRbacRelocationImportOptions): Promise<Record<string, unknown>> {
    const bundleDir = path.resolve(input.bundleDir),
      bundle = readManagedRbacRelocationBundle(bundleDir),
      config = this.#ports.readConfig();
    this.#ports.requireRunningServices();
    if (bundle.realm !== config.realm)
      throw relocationError("rbac_relocation_realm_mismatch", "Relocation bundle realm does not match this service.");
    const loginUrl = new URL(input.loginUrl),
      certificateMode = input.certificateMode ?? "domain";
    if (
      loginUrl.protocol !== "https:" ||
      loginUrl.username ||
      loginUrl.password ||
      loginUrl.pathname !== "/" ||
      loginUrl.search ||
      loginUrl.hash
    )
      throw relocationError("rbac_relocation_login_url_invalid", "Relocation login URL must be an HTTPS origin.");
    const listenerRequest: ManagedRbacRequest = {
        listenAddress: input.listenAddress,
        hostname: loginUrl.hostname,
        port: loginUrl.port ? Number(loginUrl.port) : 443,
        certificateFile: input.certificateFile,
        certificateKeyFile: input.certificateKeyFile,
        certificateMode,
      },
      requested = requestedListener(listenerRequest);
    if (
      !requested ||
      requested.hostname !== loginUrl.hostname ||
      requested.port !== (loginUrl.port ? Number(loginUrl.port) : 443)
    )
      throw relocationError(
        "rbac_relocation_login_url_invalid",
        "Relocation login URL does not match the TLS listener.",
      );

    const realm = JSON.parse(bundle.realmJson) as Record<string, unknown>;
    if (realm.realm !== config.realm || !Array.isArray(realm.clients))
      throw relocationError("rbac_relocation_realm_invalid", "Relocation realm data is incomplete.");
    const clients = realm.clients.filter(isRecord),
      centerClient = clients.find((client) => client.clientId === config.clientId);
    if (!centerClient)
      throw relocationError("rbac_relocation_realm_invalid", "Relocation realm is missing the center client.");
    centerClient.secret = bundle.centerClientSecret.trim();
    const attributes = isRecord(realm.attributes) ? realm.attributes : {};
    realm.attributes = { ...attributes, frontendUrl: relocationListenerUrl(requested) };

    const temporaryRoot = path.join(this.#root, `.rbac-relocation-import-${randomBytes(10).toString("hex")}`),
      rollbackRealmFile = path.join(temporaryRoot, "rollback-realm.json"),
      importRealmFile = path.join(temporaryRoot, "import-realm.json"),
      previousSecret = this.#ports.readCenterClientSecret(),
      previousConfig = config;
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(temporaryRoot, {
      recursive: false,
      mode: 0o700,
    });
    let rollbackReady = false,
      importStarted = false,
      secretCommitted = false,
      configCommitted = false,
      succeeded = false,
      material: ManagedRbacRelocationMaterial | undefined;
    try {
      material = await this.#ports.prepareListenerMaterial(listenerRequest, config, certificateMode);
      const listener = material.listener;
      if (!listener)
        throw relocationError("rbac_relocation_login_url_invalid", "Relocation TLS listener is incomplete.");
      const nextConfig: ManagedRbacConfig = {
        ...config,
        stopped: false,
        listener,
        listenerGeneration: material.listenerGeneration,
        certificateMode,
      };
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ writeFileSync(
        importRealmFile,
        `${JSON.stringify(realm, null, 2)}\n`,
        { mode: 0o600 },
      );
      chmodSync(importRealmFile, 0o600);
      await this.#ports.stopKeycloak();
      await this.#ports.runKeycloakCli(
        ["export", "--file", rollbackRealmFile, "--realm", config.realm, "--users", "same_file"],
        config,
      );
      chmodSync(rollbackRealmFile, 0o600);
      rollbackReady = true;
      importStarted = true;
      await this.#ports.runKeycloakCli(["import", "--file", importRealmFile, "--override=true"], config);
      this.#ports.writeCenterClientSecret(bundle.centerClientSecret);
      secretCommitted = true;
      this.#ports.writeConfig(nextConfig);
      configCommitted = true;
      await this.#ports.restartKeycloak();
      succeeded = true;
      const cleanup = this.#ports.pruneListenerVersions(listener, config.listener);
      return {
        ok: true,
        command: "rbac-relocation-import",
        loginUrl: relocationListenerUrl(listener),
        ...(!cleanup.ok ? { cleanupWarning: cleanup.error } : {}),
        ...(bundle.edgeJoinJournal === undefined ? {} : { edgeJoinJournal: bundle.edgeJoinJournal }),
      };
    } catch (error) {
      try {
        await this.#ports.stopKeycloak();
        if (importStarted && rollbackReady)
          await this.#ports.runKeycloakCli(["import", "--file", rollbackRealmFile, "--override=true"], config);
        if (secretCommitted) this.#ports.writeCenterClientSecret(previousSecret);
        if (configCommitted) this.#ports.writeConfig(previousConfig);
        await this.#ports.restartKeycloak();
      } catch {
        throw relocationError(
          "rbac_relocation_rollback_failed",
          "Relocation import failed and the previous managed RBAC state could not be restored.",
        );
      }
      throw error;
    } finally {
      try {
        if (!succeeded && material?.stagedDirectory)
          /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(
            material.stagedDirectory,
            { recursive: true, force: true },
          );
      } finally {
        /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(temporaryRoot, {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

function relocationListenerUrl(listener: Pick<ManagedRbacListener, "hostname" | "port">): string {
  return `https://${listener.hostname}:${listener.port}`;
}

export function writeManagedRbacCenterClientSecret(root: string, secret: string): void {
  const file = path.join(root, "center-client-secret"),
    temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  writePrivateFile(temporary, Buffer.from(secret.trim(), "utf8"));
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(temporary, file);
}

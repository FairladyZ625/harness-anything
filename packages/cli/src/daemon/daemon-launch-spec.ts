import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  daemonLaunchOptionsResolvedFlag,
  type DaemonLaunchConfiguration
} from "@harness-anything/daemon";

export const daemonLaunchSpecSchema = "daemon-launch-spec/v3";
export { daemonLaunchOptionsResolvedFlag } from "@harness-anything/daemon";

export class DaemonLaunchPreflightError extends Error {
  readonly code: "authority-manifest-registry-incomplete" | "launch-check-failed";

  constructor(
    message: string,
    code: "authority-manifest-registry-incomplete" | "launch-check-failed"
  ) {
    super(message);
    this.name = "DaemonLaunchPreflightError";
    this.code = code;
  }
}

export type { DaemonLaunchConfiguration } from "@harness-anything/daemon";

export interface DaemonLaunchOptions {
  readonly authorityManifest?: string;
  readonly authoredRoot?: string;
}

export interface ParsedDaemonLaunchArgv extends DaemonLaunchOptions {
  readonly rootDir: string;
  readonly socketPath?: string;
  readonly userRoot?: string;
  readonly optionsResolved: boolean;
}

interface PersistedDaemonLaunchSpec {
  readonly schema: typeof daemonLaunchSpecSchema;
  readonly endpoint: string;
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
}

interface LegacyPersistedDaemonLaunchSpec {
  readonly schema: "daemon-launch-spec/v2";
  readonly endpoint: string;
  readonly options: DaemonLaunchOptions;
}

export class DaemonLaunchResolution {
  readonly #endpoint: string;
  readonly #options: DaemonLaunchOptions;

  private constructor(endpoint: string, options: DaemonLaunchOptions) {
    this.#endpoint = daemonLaunchEndpointIdentity(endpoint);
    assertValidDaemonLaunchOptions(options);
    this.#options = Object.freeze(cloneDaemonLaunchOptions(options));
    Object.freeze(this);
  }

  static restore(userRoot: string, endpoint: string, explicit: DaemonLaunchOptions): DaemonLaunchResolution {
    const endpointIdentity = daemonLaunchEndpointIdentity(endpoint);
    let persistedOptions: DaemonLaunchOptions | undefined;
    try {
      const persisted = readPersistedDaemonLaunchSpec(userRoot, endpointIdentity);
      persistedOptions = persisted && isDaemonLaunchConfiguration(persisted)
        ? daemonLaunchOptionsFromConfiguration(persisted)
        : persisted;
    } catch (error) {
      // A complete explicit authority configuration is sufficient to rebuild durable state. Do not
      // let an obsolete or damaged cache prevent that recovery path; a successful start rewrites v3.
      if (explicit.authorityManifest === undefined) throw error;
    }
    return new DaemonLaunchResolution(endpointIdentity, resolveRestoredLaunchOptions(persistedOptions, explicit));
  }

  static complete(endpoint: string, options: DaemonLaunchOptions): DaemonLaunchResolution {
    return new DaemonLaunchResolution(endpoint, options);
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get options(): DaemonLaunchOptions {
    return this.#options;
  }

  withEffectiveOptions(options: DaemonLaunchOptions): DaemonLaunchResolution {
    return new DaemonLaunchResolution(this.#endpoint, options);
  }

  persist(userRoot: string, launchConfiguration: DaemonLaunchConfiguration): void {
    const configurationOptions = daemonLaunchOptionsFromConfiguration(launchConfiguration);
    if (!sameDaemonLaunchOptions(configurationOptions, this.#options)) {
      throw new Error("daemon launch configuration does not match its resolved launch options");
    }
    writeDaemonLaunchResolution(userRoot, this.#endpoint, launchConfiguration);
  }
}

/**
 * The socket or named-pipe endpoint is the daemon's single-writer identity. The full digest keeps
 * arbitrary endpoint characters out of the filename and remains distinct on case-insensitive file
 * systems for endpoint strings that differ only by case.
 */
export function daemonLaunchSpecPath(userRoot: string, endpoint: string): string {
  const endpointIdentity = daemonLaunchEndpointIdentity(endpoint);
  const digest = createHash("sha256").update(endpointIdentity).digest("hex");
  return path.join(path.resolve(userRoot), `daemon-launch-spec.${digest}.json`);
}

/**
 * Resolve current structured values against the spec owned by this exact endpoint. Every path that
 * may persist a spec obtains an opaque resolution here first, so an omitted foreground/autostart
 * option is restored before it can replace durable state.
 */
export function resolveDaemonLaunchSpec(
  userRoot: string,
  endpoint: string,
  explicit: DaemonLaunchOptions
): DaemonLaunchResolution {
  return DaemonLaunchResolution.restore(userRoot, endpoint, explicit);
}

export function resolveCompleteDaemonLaunchSpec(
  endpoint: string,
  options: DaemonLaunchOptions
): DaemonLaunchResolution {
  return DaemonLaunchResolution.complete(endpoint, options);
}

function writeDaemonLaunchResolution(
  userRoot: string,
  endpoint: string,
  launchConfiguration: DaemonLaunchConfiguration
): void {
  const target = daemonLaunchSpecPath(userRoot, endpoint);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  assertDaemonLaunchConfigurationForEndpoint(launchConfiguration, endpoint);
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    const document: PersistedDaemonLaunchSpec = {
      schema: daemonLaunchSpecSchema,
      endpoint,
      launchConfiguration: cloneDaemonLaunchConfiguration(launchConfiguration),
      ...(launchConfiguration.machineId !== undefined ? { machineId: launchConfiguration.machineId } : {}),
      ...(launchConfiguration.daemonGeneration !== undefined ? { daemonGeneration: launchConfiguration.daemonGeneration } : {})
    };
    // Owner-only mode. The spec contains paths, never credentials or key material.
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const daemonLaunchKnownOptions = new Set([
  "--actor", "--authored-root", "--authority-manifest", "--check", "--daemon-mode",
  "--daemon-profile", "--foreground", "--help", "--idle-ms", "--json", "--repo",
  "--root", "--service", "--socket", "--stdio", "--user-root", daemonLaunchOptionsResolvedFlag, "-h"
]);

export function parseDaemonLaunchArgv(
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): ParsedDaemonLaunchArgv {
  const rootDir = path.resolve(cwd, validatedDaemonPathOption(argv, "--root", true) ?? ".");
  const authorityManifest = validatedDaemonPathOption(argv, "--authority-manifest", false)
    ?? nonEmptyDaemonEnvironmentPath(env.HARNESS_AUTHORITY_MANIFEST);
  const authoredRoot = validatedDaemonPathOption(argv, "--authored-root", false)
    ?? nonEmptyDaemonEnvironmentPath(env.HARNESS_AUTHORED_ROOT);
  const socketPath = validatedDaemonPathOption(argv, "--socket", true);
  const userRoot = validatedDaemonPathOption(argv, "--user-root", true)
    ?? nonEmptyDaemonEnvironmentPath(env.HARNESS_DAEMON_USER_ROOT);
  return Object.freeze({
    rootDir,
    ...(authorityManifest !== undefined ? { authorityManifest: path.resolve(cwd, authorityManifest) } : {}),
    ...(authoredRoot !== undefined ? { authoredRoot: path.resolve(rootDir, authoredRoot) } : {}),
    ...(socketPath !== undefined ? { socketPath: daemonLaunchEndpointIdentity(socketPath, cwd) } : {}),
    ...(userRoot !== undefined ? { userRoot: path.resolve(cwd, userRoot) } : {}),
    optionsResolved: argv.includes(daemonLaunchOptionsResolvedFlag)
  });
}

export function readPersistedDaemonLaunchSpec(
  userRoot: string,
  endpoint: string
): DaemonLaunchConfiguration | DaemonLaunchOptions | undefined {
  const endpointIdentity = daemonLaunchEndpointIdentity(endpoint);
  const source = daemonLaunchSpecPath(userRoot, endpointIdentity);
  if (!existsSync(source)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    throw incompatibleDaemonLaunchSpecError(source, "invalid-json");
  }
  if (!isRecordValue(decoded) || decoded.endpoint !== endpointIdentity) {
    throw incompatibleDaemonLaunchSpecError(source, "endpoint-mismatch");
  }
  if (isLegacyPersistedDaemonLaunchSpec(decoded)) return cloneDaemonLaunchOptions(decoded.options);
  if (decoded.schema !== daemonLaunchSpecSchema || !isDaemonLaunchConfiguration(decoded.launchConfiguration)
    || !optionalNonEmptyString(decoded.machineId) || !optionalPositiveSafeInteger(decoded.daemonGeneration)
    || (decoded.machineId !== undefined && decoded.machineId !== decoded.launchConfiguration.machineId)
    || (decoded.daemonGeneration !== undefined && decoded.daemonGeneration !== decoded.launchConfiguration.daemonGeneration)) {
    throw incompatibleDaemonLaunchSpecError(source, "invalid-document");
  }
  const configuration = cloneDaemonLaunchConfiguration(decoded.launchConfiguration);
  try {
    assertDaemonLaunchConfigurationForEndpoint(configuration, endpointIdentity);
    return configuration;
  } catch {
    throw incompatibleDaemonLaunchSpecError(source, "invalid-launch-configuration");
  }
}

export function resolveRestoredLaunchOptions(
  persisted: DaemonLaunchOptions | undefined,
  explicit: DaemonLaunchOptions
): DaemonLaunchOptions {
  assertValidDaemonLaunchOptions(explicit);
  return {
    ...(explicit.authorityManifest !== undefined
      ? { authorityManifest: explicit.authorityManifest }
      : persisted?.authorityManifest !== undefined
        ? { authorityManifest: persisted.authorityManifest }
        : {}),
    ...(explicit.authoredRoot !== undefined
      ? { authoredRoot: explicit.authoredRoot }
      : persisted?.authoredRoot !== undefined
        ? { authoredRoot: persisted.authoredRoot }
        : {})
  };
}

export async function preflightDaemonLaunch(configuration: DaemonLaunchConfiguration): Promise<void> {
  const child = spawn(configuration.execPath, [
    ...configuration.execArgv,
    configuration.entrypoint,
    ...configuration.args,
    "--check"
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env }
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code === 0) return;
  const diagnostic = Buffer.concat([...stderr, ...stdout]).toString("utf8").trim();
  const message = diagnostic || `daemon launch preflight exited with ${result.signal ? `signal ${result.signal}` : `code ${String(result.code)}`}`;
  throw new DaemonLaunchPreflightError(
    message,
    /(?:^|\W)AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE(?:\W|$)/u.test(message)
      ? "authority-manifest-registry-incomplete"
      : "launch-check-failed"
  );
}

function daemonLaunchEndpointIdentity(endpoint: string, cwd = process.cwd()): string {
  if (endpoint.length === 0) throw new Error("daemon launch endpoint must be non-empty");
  if (process.platform === "win32" && endpoint.startsWith("\\\\.\\pipe\\")) {
    return path.win32.normalize(endpoint).toLowerCase();
  }
  return path.resolve(cwd, endpoint);
}

function assertValidDaemonLaunchOptions(options: DaemonLaunchOptions): void {
  if (options.authorityManifest !== undefined && options.authorityManifest.trim().length === 0) {
    throw new Error("--authority-manifest requires a non-empty path value.");
  }
  if (options.authoredRoot !== undefined && options.authoredRoot.trim().length === 0) {
    throw new Error("--authored-root requires a non-empty path value.");
  }
  if (options.authorityManifest !== undefined && !path.isAbsolute(options.authorityManifest)) {
    throw new Error("--authority-manifest must resolve to an absolute path.");
  }
  if (options.authoredRoot !== undefined && !path.isAbsolute(options.authoredRoot)) {
    throw new Error("--authored-root must resolve to an absolute path.");
  }
}

function daemonLaunchOptionsFromConfiguration(configuration: DaemonLaunchConfiguration): DaemonLaunchOptions {
  const parsed = parseDaemonLaunchArgv(configuration.args);
  return {
    ...(parsed.authorityManifest !== undefined ? { authorityManifest: parsed.authorityManifest } : {}),
    ...(parsed.authoredRoot !== undefined ? { authoredRoot: parsed.authoredRoot } : {})
  };
}

function assertDaemonLaunchConfigurationForEndpoint(
  configuration: DaemonLaunchConfiguration,
  endpoint: string
): void {
  const parsed = parseDaemonLaunchArgv(configuration.args);
  if (parsed.socketPath !== daemonLaunchEndpointIdentity(endpoint)) {
    throw new Error("persisted launch configuration endpoint does not match its launch spec owner");
  }
}

function isDaemonLaunchConfiguration(value: unknown): value is DaemonLaunchConfiguration {
  return isRecordValue(value)
    && typeof value.execPath === "string"
    && value.execPath.length > 0
    && Array.isArray(value.execArgv)
    && value.execArgv.every((arg) => typeof arg === "string")
    && typeof value.entrypoint === "string"
    && value.entrypoint.length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && optionalNonEmptyString(value.machineId)
    && optionalPositiveSafeInteger(value.daemonGeneration);
}

function isLegacyPersistedDaemonLaunchSpec(
  value: Record<string, unknown>
): value is Record<string, unknown> & LegacyPersistedDaemonLaunchSpec {
  return value.schema === "daemon-launch-spec/v2" && isDaemonLaunchOptions(value.options);
}

function isDaemonLaunchOptions(value: unknown): value is DaemonLaunchOptions {
  if (!isRecordValue(value)) return false;
  const authorityManifest = value.authorityManifest;
  const authoredRoot = value.authoredRoot;
  return (authorityManifest === undefined || (typeof authorityManifest === "string" && path.isAbsolute(authorityManifest)))
    && (authoredRoot === undefined || (typeof authoredRoot === "string" && path.isAbsolute(authoredRoot)));
}

function incompatibleDaemonLaunchSpecError(
  source: string,
  category: "invalid-json" | "invalid-document" | "endpoint-mismatch" | "invalid-launch-configuration"
): Error {
  return new Error(
    `DAEMON_LAUNCH_SPEC_INCOMPATIBLE: persisted daemon launch specification at ${source} is not compatible with this CLI (${category}). `
    + "Remove that file and rebuild it with: ha daemon start --service --user-root <user-root> --authority-manifest <path>"
  );
}

function validatedDaemonPathOption(argv: ReadonlyArray<string>, name: string, rejectFlagPrefix: boolean): string | undefined {
  let selected: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value.trim().length === 0
      || daemonLaunchKnownOptions.has(value) || (rejectFlagPrefix && value.startsWith("-"))) {
      const qualifier = rejectFlagPrefix ? ", non-flag" : "";
      throw new Error(`${name} requires a non-empty${qualifier} path value.`);
    }
    selected ??= value;
  }
  return selected;
}

function nonEmptyDaemonEnvironmentPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cloneDaemonLaunchOptions(options: DaemonLaunchOptions): DaemonLaunchOptions {
  return {
    ...(options.authorityManifest !== undefined ? { authorityManifest: options.authorityManifest } : {}),
    ...(options.authoredRoot !== undefined ? { authoredRoot: options.authoredRoot } : {})
  };
}

function sameDaemonLaunchOptions(left: DaemonLaunchOptions, right: DaemonLaunchOptions): boolean {
  return left.authorityManifest === right.authorityManifest && left.authoredRoot === right.authoredRoot;
}

function cloneDaemonLaunchConfiguration(configuration: DaemonLaunchConfiguration): DaemonLaunchConfiguration {
  return {
    execPath: configuration.execPath,
    execArgv: [...configuration.execArgv],
    entrypoint: configuration.entrypoint,
    args: [...configuration.args],
    ...(configuration.machineId !== undefined ? { machineId: configuration.machineId } : {}),
    ...(configuration.daemonGeneration !== undefined ? { daemonGeneration: configuration.daemonGeneration } : {})
  };
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function optionalPositiveSafeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

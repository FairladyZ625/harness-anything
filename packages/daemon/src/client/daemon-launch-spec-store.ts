import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  createDaemonLaunchConfiguration,
  daemonLaunchOptionsResolvedFlag,
  type DaemonLaunchConfiguration,
  type DaemonLaunchConfigurationInput
} from "./daemon-launch-configuration.ts";

export const daemonLaunchSpecSchema = "daemon-launch-spec/v3";

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

interface LegacyPersistedDaemonLaunchSpec {
  readonly schema: "daemon-launch-spec/v2";
  readonly endpoint: string;
  readonly options: DaemonLaunchOptions;
}

export class DaemonLaunchSpecReadError extends Error {
  readonly source: string;
  readonly category:
    | "invalid-json"
    | "invalid-document"
    | "endpoint-mismatch"
    | "invalid-launch-configuration";

  constructor(
    source: string,
    category:
      | "invalid-json"
      | "invalid-document"
      | "endpoint-mismatch"
      | "invalid-launch-configuration"
  ) {
    super(
      `DAEMON_LAUNCH_SPEC_INCOMPATIBLE: persisted daemon launch specification at ${source} is not compatible with this CLI (${category}). `
      + "Remove that file and rebuild it with: ha daemon start --service --user-root <user-root> --authority-manifest <path>"
    );
    this.name = "DaemonLaunchSpecReadError";
    this.source = source;
    this.category = category;
  }
}

const daemonLaunchKnownOptions = new Set([
  "--actor", "--authored-root", "--authority-manifest", "--check", "--daemon-mode",
  "--daemon-profile", "--foreground", "--help", "--idle-ms", "--json", "--repo",
  "--root", "--service", "--socket", "--stdio", "--user-root", daemonLaunchOptionsResolvedFlag, "-h"
]);

/**
 * The endpoint is the persisted launch spec's ownership identity. Hashing the normalized identity
 * keeps arbitrary endpoint characters out of the filename and remains case-safe on Windows.
 */
export function daemonLaunchSpecPath(userRoot: string, endpoint: string): string {
  const endpointIdentity = daemonLaunchEndpointIdentity(endpoint);
  const digest = createHash("sha256").update(endpointIdentity).digest("hex");
  return path.join(path.resolve(userRoot), `daemon-launch-spec.${digest}.json`);
}

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
    throw new DaemonLaunchSpecReadError(source, "invalid-json");
  }
  if (!isRecordValue(decoded) || decoded.endpoint !== endpointIdentity) {
    throw new DaemonLaunchSpecReadError(source, "endpoint-mismatch");
  }
  if (isLegacyPersistedDaemonLaunchSpec(decoded)) return cloneDaemonLaunchOptions(decoded.options);
  if (decoded.schema !== daemonLaunchSpecSchema || !isDaemonLaunchConfiguration(decoded.launchConfiguration)
    || !optionalNonEmptyString(decoded.machineId) || !optionalPositiveSafeInteger(decoded.daemonGeneration)
    || (decoded.machineId !== undefined && decoded.machineId !== decoded.launchConfiguration.machineId)
    || (decoded.daemonGeneration !== undefined && decoded.daemonGeneration !== decoded.launchConfiguration.daemonGeneration)) {
    throw new DaemonLaunchSpecReadError(source, "invalid-document");
  }
  const configuration = cloneDaemonLaunchConfiguration(decoded.launchConfiguration);
  try {
    assertDaemonLaunchConfigurationForEndpoint(configuration, endpointIdentity);
    return configuration;
  } catch {
    throw new DaemonLaunchSpecReadError(source, "invalid-launch-configuration");
  }
}

/**
 * Compose a fresh runtime launch with the durable policy owned by the same endpoint.
 *
 * Runtime identity and executable fields always come from input. Only authored layout, authority
 * composition, and the resolved-options marker are restored. A non-canonical persisted argv is
 * rejected so a newly added launch flag cannot be silently discarded by this projection.
 */
export function createDaemonLaunchConfigurationFromPersistedPolicy(
  input: DaemonLaunchConfigurationInput
): DaemonLaunchConfiguration {
  const current = createDaemonLaunchConfiguration(input);
  let persisted: DaemonLaunchConfiguration | DaemonLaunchOptions | undefined;
  try {
    persisted = readPersistedDaemonLaunchSpec(input.target.userRoot, input.target.socketPath);
  } catch (error) {
    if (error instanceof DaemonLaunchSpecReadError && error.category === "endpoint-mismatch") return current;
    throw error;
  }
  if (persisted === undefined) return current;

  const currentPolicy = daemonLaunchPolicyFromCurrentConfiguration(current);
  const persistedPolicy = isDaemonLaunchConfiguration(persisted)
    ? daemonLaunchPolicyFromConfiguration(persisted)
    : persisted;
  const persistedOptionsResolved = "launchOptionsResolved" in persistedPolicy
    && typeof persistedPolicy.launchOptionsResolved === "boolean"
    ? persistedPolicy.launchOptionsResolved
    : false;
  return createDaemonLaunchConfiguration({
    ...input,
    ...(currentPolicy.authorityManifest !== undefined
      ? { authorityManifest: currentPolicy.authorityManifest }
      : persistedPolicy.authorityManifest !== undefined
        ? { authorityManifest: persistedPolicy.authorityManifest }
        : {}),
    ...(currentPolicy.authoredRoot !== undefined
      ? { authoredRoot: currentPolicy.authoredRoot }
      : persistedPolicy.authoredRoot !== undefined
        ? { authoredRoot: persistedPolicy.authoredRoot }
        : {}),
    launchOptionsResolved: input.launchOptionsResolved
      ?? persistedOptionsResolved
  });
}

interface DaemonLaunchPolicy extends DaemonLaunchOptions {
  readonly launchOptionsResolved: boolean;
}

function daemonLaunchPolicyFromCurrentConfiguration(configuration: DaemonLaunchConfiguration): DaemonLaunchPolicy {
  const parsed = parseDaemonLaunchArgv(configuration.args, process.cwd(), {});
  return {
    ...(parsed.authorityManifest !== undefined ? { authorityManifest: parsed.authorityManifest } : {}),
    ...(parsed.authoredRoot !== undefined ? { authoredRoot: parsed.authoredRoot } : {}),
    launchOptionsResolved: parsed.optionsResolved
  };
}

function daemonLaunchPolicyFromConfiguration(configuration: DaemonLaunchConfiguration): DaemonLaunchPolicy {
  const parsed = parseCanonicalDaemonLaunchConfiguration(configuration);
  return {
    ...(parsed.authorityManifest !== undefined ? { authorityManifest: parsed.authorityManifest } : {}),
    ...(parsed.authoredRoot !== undefined ? { authoredRoot: parsed.authoredRoot } : {}),
    launchOptionsResolved: parsed.optionsResolved
  };
}

function parseCanonicalDaemonLaunchConfiguration(configuration: DaemonLaunchConfiguration): ParsedDaemonLaunchArgv {
  const parsed = parseDaemonLaunchArgv(configuration.args, process.cwd(), {});
  const repoId = requiredOption(configuration.args, "--repo");
  const idleExitMs = Number(requiredOption(configuration.args, "--idle-ms"));
  if (!parsed.socketPath || !parsed.userRoot || !Number.isSafeInteger(idleExitMs) || idleExitMs < 0) {
    throw daemonLaunchPolicyMismatchError();
  }
  const reconstructed = createDaemonLaunchConfiguration({
    target: {
      canonicalRoot: parsed.rootDir,
      repoId,
      socketPath: parsed.socketPath,
      userRoot: parsed.userRoot
    },
    entrypoint: configuration.entrypoint,
    idleExitMs,
    execPath: configuration.execPath,
    execArgv: configuration.execArgv,
    ...(parsed.authorityManifest !== undefined ? { authorityManifest: parsed.authorityManifest } : {}),
    ...(parsed.authoredRoot !== undefined ? { authoredRoot: parsed.authoredRoot } : {}),
    launchOptionsResolved: parsed.optionsResolved
  });
  if (!sameStringArray(reconstructed.args, configuration.args)) throw daemonLaunchPolicyMismatchError();
  return parsed;
}

function requiredOption(argv: ReadonlyArray<string>, name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw daemonLaunchPolicyMismatchError();
  return value;
}

function daemonLaunchPolicyMismatchError(): Error {
  return new Error(
    "DAEMON_LAUNCH_SPEC_POLICY_MISMATCH: persisted daemon launch arguments contain an unclassified or non-canonical field"
  );
}

function assertDaemonLaunchConfigurationForEndpoint(
  configuration: DaemonLaunchConfiguration,
  endpoint: string
): void {
  const parsed = parseDaemonLaunchArgv(configuration.args, process.cwd(), {});
  if (parsed.socketPath !== daemonLaunchEndpointIdentity(endpoint)) {
    throw new Error("persisted launch configuration endpoint does not match its launch spec owner");
  }
}

export function daemonLaunchEndpointIdentity(endpoint: string, cwd = process.cwd()): string {
  if (endpoint.length === 0) throw new Error("daemon launch endpoint must be non-empty");
  if (process.platform === "win32" && endpoint.startsWith("\\\\.\\pipe\\")) {
    return path.win32.normalize(endpoint).toLowerCase();
  }
  return path.resolve(cwd, endpoint);
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

function cloneDaemonLaunchOptions(options: DaemonLaunchOptions): DaemonLaunchOptions {
  return {
    ...(options.authorityManifest !== undefined ? { authorityManifest: options.authorityManifest } : {}),
    ...(options.authoredRoot !== undefined ? { authoredRoot: options.authoredRoot } : {})
  };
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

function sameStringArray(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

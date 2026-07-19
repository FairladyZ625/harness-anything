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

export const daemonLaunchSpecSchema = "daemon-launch-spec/v2";
export const daemonLaunchOptionsResolvedFlag = "--launch-options-resolved";

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

export interface DaemonLaunchConfiguration {
  readonly execPath: string;
  readonly execArgv: ReadonlyArray<string>;
  readonly entrypoint: string;
  readonly args: ReadonlyArray<string>;
}

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
    const persisted = readPersistedDaemonLaunchSpec(userRoot, endpointIdentity);
    return new DaemonLaunchResolution(endpointIdentity, resolveRestoredLaunchOptions(persisted, explicit));
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

  persist(userRoot: string): void {
    writeDaemonLaunchResolution(userRoot, this.#endpoint, this.#options);
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

function writeDaemonLaunchResolution(userRoot: string, endpoint: string, options: DaemonLaunchOptions): void {
  const target = daemonLaunchSpecPath(userRoot, endpoint);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    const document: PersistedDaemonLaunchSpec = {
      schema: daemonLaunchSpecSchema,
      endpoint,
      options: cloneDaemonLaunchOptions(options)
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
): DaemonLaunchOptions | undefined {
  const endpointIdentity = daemonLaunchEndpointIdentity(endpoint);
  const source = daemonLaunchSpecPath(userRoot, endpointIdentity);
  if (!existsSync(source)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecordValue(decoded)
    || decoded.schema !== daemonLaunchSpecSchema
    || decoded.endpoint !== endpointIdentity
    || !isDaemonLaunchOptions(decoded.options)) {
    return undefined;
  }
  return cloneDaemonLaunchOptions(decoded.options);
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

function isDaemonLaunchOptions(value: unknown): value is DaemonLaunchOptions {
  if (!isRecordValue(value)) return false;
  const authorityManifest = value.authorityManifest;
  const authoredRoot = value.authoredRoot;
  return (authorityManifest === undefined || (typeof authorityManifest === "string" && path.isAbsolute(authorityManifest)))
    && (authoredRoot === undefined || (typeof authoredRoot === "string" && path.isAbsolute(authoredRoot)));
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

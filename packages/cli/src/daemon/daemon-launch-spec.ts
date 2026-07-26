import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  daemonLaunchEndpointIdentity,
  daemonLaunchSpecPath,
  daemonLaunchSpecSchema,
  parseDaemonLaunchArgv,
  readPersistedDaemonLaunchSpec,
  type DaemonLaunchOptions,
  type DaemonLaunchConfiguration
} from "@harness-anything/daemon";

export {
  daemonLaunchOptionsResolvedFlag,
  daemonLaunchSpecPath,
  daemonLaunchSpecSchema,
  parseDaemonLaunchArgv,
  readPersistedDaemonLaunchSpec
} from "@harness-anything/daemon";
export type {
  DaemonLaunchConfiguration,
  DaemonLaunchOptions,
  ParsedDaemonLaunchArgv
} from "@harness-anything/daemon";

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

interface PersistedDaemonLaunchSpec {
  readonly schema: typeof daemonLaunchSpecSchema;
  readonly endpoint: string;
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
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
      persistedOptions = persisted && "args" in persisted
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

function sameDaemonLaunchOptions(left: DaemonLaunchOptions, right: DaemonLaunchOptions): boolean {
  return left.authorityManifest === right.authorityManifest && left.authoredRoot === right.authoredRoot;
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

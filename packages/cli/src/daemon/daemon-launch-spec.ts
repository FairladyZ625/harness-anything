import { spawn } from "node:child_process";
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
import { readOption } from "../cli/parse-options.ts";

export const daemonLaunchSpecSchema = "daemon-launch-spec/v1";

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

interface PersistedDaemonLaunchSpec {
  readonly schema: typeof daemonLaunchSpecSchema;
  readonly launchConfiguration: DaemonLaunchConfiguration;
}

export function daemonLaunchSpecPath(userRoot: string): string {
  return path.join(path.resolve(userRoot), "daemon-launch-spec.json");
}

export function persistDaemonLaunchSpec(userRoot: string, launchConfiguration: DaemonLaunchConfiguration): void {
  const target = daemonLaunchSpecPath(userRoot);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    const document: PersistedDaemonLaunchSpec = {
      schema: daemonLaunchSpecSchema,
      launchConfiguration: cloneDaemonLaunchConfiguration(launchConfiguration)
    };
    // Owner-only mode. POSIX enforces this; on Windows chmod maps to the read-only bit only and does
    // not restrict other local users, so the spec must never hold secret material — it records launch
    // argv (repo/socket/user-root paths and the authority-manifest path), not credentials or key bytes.
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readPersistedDaemonLaunchSpec(userRoot: string): DaemonLaunchConfiguration | undefined {
  const source = daemonLaunchSpecPath(userRoot);
  if (!existsSync(source)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw incompatibleLaunchSpecError(source, error);
  }
  if (!isRecordValue(decoded)
    || decoded.schema !== daemonLaunchSpecSchema
    || !isDaemonLaunchConfiguration(decoded.launchConfiguration)) {
    throw incompatibleLaunchSpecError(source);
  }
  return cloneDaemonLaunchConfiguration(decoded.launchConfiguration);
}

export interface DaemonLaunchOverrides {
  readonly authorityManifest?: string;
  readonly authoredRoot?: string;
}

/**
 * Restore the launch options a bare cold start omits. `currentDaemonServiceLaunchConfiguration`
 * always rebuilds every launch flag except `--authority-manifest` and `--authored-root` from
 * resolved input, so those two are the only values that can go missing when the daemon is
 * relaunched without them. Explicitly-provided values (a CLI flag, or `HARNESS_AUTHORITY_MANIFEST`
 * for the manifest — both already resolved into `explicit`) take precedence and become the next
 * persisted value; a value only falls back to the persisted spec when the current invocation
 * omitted it. No raw-argv string merge is performed, so option boundaries, repeated options, and
 * explicit global flags such as `--root` cannot be misparsed or silently dropped.
 */
export function resolveRestoredLaunchOptions(
  persisted: DaemonLaunchConfiguration | undefined,
  explicit: DaemonLaunchOverrides
): { readonly authorityManifest: string | undefined; readonly authoredRoot: string | undefined } {
  return {
    authorityManifest: explicit.authorityManifest
      ?? (persisted ? readOption(persisted.args, "--authority-manifest") : undefined),
    authoredRoot: explicit.authoredRoot
      ?? (persisted ? readOption(persisted.args, "--authored-root") : undefined)
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

function incompatibleLaunchSpecError(source: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? ` (${cause.message})` : "";
  return new Error(
    `DAEMON_LAUNCH_SPEC_INCOMPATIBLE: persisted daemon launch specification at ${source} is not compatible with this CLI${detail}. `
    + `Remove that file and rebuild it with: ha daemon start --service --user-root <user-root> --authority-manifest <path>`
  );
}

function isDaemonLaunchConfiguration(value: unknown): value is DaemonLaunchConfiguration {
  return isRecordValue(value)
    && typeof value.execPath === "string"
    && Array.isArray(value.execArgv)
    && value.execArgv.every((arg) => typeof arg === "string")
    && typeof value.entrypoint === "string"
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string");
}

function cloneDaemonLaunchConfiguration(configuration: DaemonLaunchConfiguration): DaemonLaunchConfiguration {
  return {
    execPath: configuration.execPath,
    execArgv: [...configuration.execArgv],
    entrypoint: configuration.entrypoint,
    args: [...configuration.args]
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "@harness-anything/application/record";
import { landedSettingDefaults } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FdeCommandRunner {
  readonly run: (command: string, args: ReadonlyArray<string>, budget: FdeProbeBudget) => Promise<CommandResult>;
}

export interface FdeProbeBudget {
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
}

export interface FdeEvidence {
  readonly schema: "fde-evidence/v1";
  readonly platform: NodeJS.Platform;
  readonly mechanism: "filevault" | "luks" | "unsupported";
  readonly state: "encrypted" | "not-encrypted" | "indeterminate" | "unsupported";
  readonly evidenceCode: string;
}

export async function detectFullVolumeEncryption(options: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: FdeCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<FdeEvidence> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? nodeFdeCommandRunner;
  const budget = resolveFdeProbeBudget(options.env ?? process.env);
  if (platform === "darwin") return detectFileVault(runner, budget);
  if (platform === "linux") return detectLuks(runner, budget);
  return evidence(platform, "unsupported", "unsupported", "platform_not_supported");
}

export const nodeFdeCommandRunner: FdeCommandRunner = {
  run: async (command, args, budget) => {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: "utf8",
        timeout: budget.timeoutMs,
        maxBuffer: budget.maxBufferBytes
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? ""
      };
    }
  }
};

async function detectFileVault(runner: FdeCommandRunner, budget: FdeProbeBudget): Promise<FdeEvidence> {
  const result = await runner.run("fdesetup", ["status"], budget);
  if (result.exitCode !== 0) return evidence("darwin", "filevault", "indeterminate", "filevault_probe_failed");
  if (/FileVault is On\./iu.test(result.stdout)) return evidence("darwin", "filevault", "encrypted", "filevault_on");
  if (/FileVault is Off\./iu.test(result.stdout)) return evidence("darwin", "filevault", "not-encrypted", "filevault_off");
  return evidence("darwin", "filevault", "indeterminate", "filevault_status_unknown");
}

async function detectLuks(runner: FdeCommandRunner, budget: FdeProbeBudget): Promise<FdeEvidence> {
  const result = await runner.run("lsblk", ["--json", "--output", "NAME,TYPE,FSTYPE,MOUNTPOINTS"], budget);
  if (result.exitCode !== 0) return evidence("linux", "luks", "indeterminate", "lsblk_probe_failed");
  try {
    const document: unknown = JSON.parse(result.stdout);
    if (!isRecord(document) || !Array.isArray(document.blockdevices)) {
      return evidence("linux", "luks", "indeterminate", "lsblk_schema_unknown");
    }
    const rootPath = findRootPath(document.blockdevices, false);
    if (!rootPath) return evidence("linux", "luks", "indeterminate", "root_device_not_found");
    return rootPath.encrypted
      ? evidence("linux", "luks", "encrypted", "luks_root_chain")
      : evidence("linux", "luks", "not-encrypted", "plain_root_chain");
  } catch {
    return evidence("linux", "luks", "indeterminate", "lsblk_json_invalid");
  }
}

export function resolveFdeProbeBudget(env: NodeJS.ProcessEnv = process.env): FdeProbeBudget {
  return {
    timeoutMs: boundedPositiveInteger("HARNESS_FDE_PROBE_TIMEOUT_MS", env.HARNESS_FDE_PROBE_TIMEOUT_MS, landedSettingDefaults.fdeProbeTimeoutMs, 120_000),
    maxBufferBytes: boundedPositiveInteger("HARNESS_FDE_PROBE_MAX_BUFFER_BYTES", env.HARNESS_FDE_PROBE_MAX_BUFFER_BYTES, landedSettingDefaults.fdeProbeMaxBufferBytes, 64 * 1024 * 1024)
  };
}

function boundedPositiveInteger(name: string, raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function findRootPath(
  value: ReadonlyArray<unknown>,
  ancestorEncrypted: boolean
): { readonly encrypted: boolean } | undefined {
  for (const item of value) {
    if (!isRecord(item)) continue;
    // A dm-crypt mapping can also be created without a LUKS header. Require
    // crypto_LUKS evidence somewhere in the root ancestry instead of treating
    // the generic `crypt` device type as sufficient.
    const pathEncrypted = ancestorEncrypted || item.fstype === "crypto_LUKS";
    if (mountsRoot(item.mountpoints)) return { encrypted: pathEncrypted };
    if (Array.isArray(item.children)) {
      const childPath = findRootPath(item.children, pathEncrypted);
      if (childPath) return childPath;
    }
  }
  return undefined;
}

function mountsRoot(value: unknown): boolean {
  return Array.isArray(value) && value.some((mountpoint) => mountpoint === "/");
}

function evidence(
  platform: NodeJS.Platform,
  mechanism: FdeEvidence["mechanism"],
  state: FdeEvidence["state"],
  evidenceCode: string
): FdeEvidence {
  return { schema: "fde-evidence/v1", platform, mechanism, state, evidenceCode };
}

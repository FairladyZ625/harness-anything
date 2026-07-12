import { readFileSync } from "node:fs";
import os from "node:os";
import type { PlatformMetadataPolicy } from "./metadata-policy.ts";
import { draftPlatformMetadataPolicy, validatePlatformMetadataPolicy } from "./metadata-policy.ts";
import { platformQualificationMatrix } from "./matrix.ts";
import { observeRuntimeMount } from "./mount-observation.ts";
import {
  probePortableFileSemantics,
  unboundNativeSemanticProbes,
  type NativeSemanticProbe
} from "./semantic-probe.ts";
import {
  platformQualificationExitCodes,
  type CapabilityProbeResult,
  type MountObservation,
  type PlatformAdapterDeclaration,
  type PlatformKind,
  type PlatformQualificationExitSymbol,
  type PlatformQualificationFailure,
  type PlatformQualificationResult
} from "./types.ts";
import { detectWsl } from "./wsl.ts";

export interface PlatformQualificationOptions {
  readonly root: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly osRelease?: string;
  readonly procVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly mount?: MountObservation;
  readonly metadataPolicy?: PlatformMetadataPolicy;
  readonly portableProbe?: (root: string) => Promise<ReadonlyArray<CapabilityProbeResult>>;
  readonly nativeProbe?: NativeSemanticProbe;
}

function qualificationFailure(symbol: PlatformQualificationExitSymbol, reason: string): PlatformQualificationFailure {
  return { symbol, code: platformQualificationExitCodes[symbol], reason };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterFor(platform: PlatformKind): PlatformAdapterDeclaration {
  if (platform === "macos") return platformQualificationMatrix["macos-apfs"];
  if (platform === "linux") return platformQualificationMatrix["linux-native"];
  if (platform === "wsl") return platformQualificationMatrix["wsl-linux"];
  return platformQualificationMatrix["windows-native"];
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

export async function qualifyWritablePlatform(options: PlatformQualificationOptions): Promise<PlatformQualificationResult> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const wsl = detectWsl({
    hostPlatform,
    osRelease: options.osRelease ?? os.release(),
    procVersion: options.procVersion ?? readProcVersion(),
    env: options.env ?? process.env
  });
  const platform: PlatformKind = hostPlatform === "darwin"
    ? "macos"
    : hostPlatform === "linux"
      ? (wsl.isWsl ? "wsl" : "linux")
      : "windows-native";
  const adapter = adapterFor(platform);
  const earlyFailures: PlatformQualificationFailure[] = [];
  let mount: MountObservation;
  try {
    mount = options.mount ?? observeRuntimeMount(options.root, hostPlatform);
  } catch (error) {
    mount = { source: "unknown", mountPoint: options.root, fileSystemType: "unknown", options: [] };
    earlyFailures.push(qualificationFailure("MOUNT_OBSERVATION_FAILED", errorDetail(error)));
  }
  let portableResults: ReadonlyArray<CapabilityProbeResult>;
  try {
    portableResults = await (options.portableProbe ?? probePortableFileSemantics)(options.root);
  } catch (error) {
    portableResults = [{ capability: "exclusiveCreate", passed: false, detail: errorDetail(error) }];
  }
  const nativeCapabilities = adapter.requiredCapabilities
    .filter((entry) => entry.source === "native-adapter-probe")
    .map((entry) => entry.name);
  let nativeResults: ReadonlyArray<CapabilityProbeResult>;
  try {
    nativeResults = options.nativeProbe === undefined
      ? unboundNativeSemanticProbes(nativeCapabilities)
      : await options.nativeProbe(options.root, nativeCapabilities);
  } catch (error) {
    nativeResults = nativeCapabilities.map((capability) => ({
      capability,
      passed: false,
      detail: errorDetail(error)
    }));
  }
  const capabilities = [...portableResults, ...nativeResults];
  const observation = {
    hostPlatform,
    platform,
    isWsl: wsl.isWsl,
    ...(wsl.distroName === undefined ? {} : { wslDistroName: wsl.distroName }),
    mount,
    capabilities
  };
  const failures: PlatformQualificationFailure[] = [...earlyFailures];

  if (hostPlatform !== "darwin" && hostPlatform !== "linux" && hostPlatform !== "win32") {
    failures.push(qualificationFailure("UNSUPPORTED_PLATFORM", `Host platform ${hostPlatform} has no writable adapter`));
  }
  const fileSystemType = mount.fileSystemType.toLowerCase();
  if (platform === "wsl" && (fileSystemType === "drvfs" || mount.mountPoint.toLowerCase() === "/mnt/c" || mount.mountPoint.toLowerCase().startsWith("/mnt/c/"))) {
    failures.push(qualificationFailure("DRVFS_WRITABLE_VIEW_REJECTED", `WSL writable views cannot use ${mount.mountPoint} (${mount.fileSystemType})`));
  } else if (!adapter.acceptedFileSystems.includes(fileSystemType)) {
    failures.push(qualificationFailure("UNSUPPORTED_FILESYSTEM", `${adapter.adapterId} requires ${adapter.acceptedFileSystems.join(" or ")}; observed ${mount.fileSystemType} at ${mount.mountPoint}`));
  }
  const rejectedMountOptions = mount.options.filter((option) => ["ro", "read-only", "noexec", "noowners"].includes(option.toLowerCase()));
  if (rejectedMountOptions.length > 0) {
    failures.push(qualificationFailure(
      "UNSUPPORTED_MOUNT_OPTIONS",
      `Writable qualification rejects mount options: ${rejectedMountOptions.join(", ")}`
    ));
  }
  if (adapter.writableQualification === "deferred") {
    failures.push(qualificationFailure("WINDOWS_NATIVE_WRITABLE_DEFERRED", "Native Windows writable qualification is deferred; use a WSL Linux filesystem view"));
  }

  const required = new Set(adapter.requiredCapabilities.map((entry) => entry.name));
  const failedCapabilities = capabilities.filter((entry) => required.has(entry.capability) && !entry.passed);
  const observed = new Set(capabilities.map((entry) => entry.capability));
  const missingCapabilities = [...required].filter((capability) => !observed.has(capability));
  if (failedCapabilities.length > 0 || missingCapabilities.length > 0) {
    const names = [
      ...failedCapabilities.map((entry) => `${entry.capability}: ${entry.detail}`),
      ...missingCapabilities.map((capability) => `${capability}: no result`)
    ];
    failures.push(qualificationFailure("REQUIRED_SEMANTIC_PROBE_FAILED", names.join("; ")));
  }

  const policy = options.metadataPolicy ?? draftPlatformMetadataPolicy(platform);
  const policyValidation = validatePlatformMetadataPolicy(policy);
  if (policy.platform !== platform || !policyValidation.complete) {
    failures.push(qualificationFailure(
      "METADATA_POLICY_UNRESOLVED",
      policy.platform !== platform
        ? `Metadata policy targets ${policy.platform}, observed ${platform}`
        : `L-14 metadata policy is incomplete; missing=[${policyValidation.missingFields.join(", ")}], unknown=[${policyValidation.unknownFields.join(", ")}]`
    ));
  }

  if (failures.length > 0) return { mode: "REJECTED", adapter, observation, failures };
  return { mode: "WRITABLE", adapter, observation };
}

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function inspectFleetCampaignEnvironment(env = process.env) {
  const boundedVolume = env.HARNESS_STRESS_BOUNDED_VOLUME ?? null,
    powerDevice = env.HARNESS_STRESS_POWER_DEVICE ?? null,
    volume = inspectVolume(boundedVolume),
    power = inspectPowerDevice(powerDevice);
  return {
    volume,
    power,
    verdict: volume.ready && power.ready ? "PASS" : "BLOCKED",
  };
}

function inspectVolume(candidate) {
  if (!candidate)
    return {
      ready: false,
      path: null,
      reason: "HARNESS_STRESS_BOUNDED_VOLUME is not set",
    };
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) return { ready: false, path: resolved, reason: "bounded volume path is absent" };
  let mount;
  try {
    mount = execFileSync("findmnt", ["--json", "--target", resolved], { encoding: "utf8" });
  } catch (error) {
    return { ready: false, path: resolved, reason: commandFailure("findmnt", error) };
  }
  const filesystems = JSON.parse(mount).filesystems ?? [];
  if (filesystems.length !== 1 || path.resolve(filesystems[0].target) !== resolved)
    return { ready: false, path: resolved, reason: "path is not a dedicated mount target" };
  const stats = statSync(resolved);
  if (!stats.isDirectory()) return { ready: false, path: resolved, reason: "bounded volume is not a directory" };
  return {
    ready: true,
    path: resolved,
    source: filesystems[0].source,
    filesystem: filesystems[0].fstype,
  };
}

function inspectPowerDevice(candidate) {
  if (!candidate)
    return {
      ready: false,
      path: null,
      reason: "HARNESS_STRESS_POWER_DEVICE is not set",
    };
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) return { ready: false, path: resolved, reason: "power-loss device is absent" };
  const stats = statSync(resolved);
  if (!stats.isBlockDevice())
    return { ready: false, path: resolved, reason: "power-loss target is not a block device" };
  let bytes;
  try {
    bytes = Number(execFileSync("blockdev", ["--getsize64", resolved], { encoding: "utf8" }).trim());
  } catch (error) {
    return { ready: false, path: resolved, reason: commandFailure("blockdev", error) };
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    return { ready: false, path: resolved, reason: "power-loss device size is invalid" };
  return { ready: true, path: resolved, bytes };
}

function commandFailure(command, error) {
  const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return `${command} preflight failed: ${detail}`;
}

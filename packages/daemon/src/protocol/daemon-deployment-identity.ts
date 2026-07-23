import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DaemonDeploymentStatus } from "@harness-anything/application";
import { calculateDaemonArtifactIdentity, daemonBuildProvenanceFilename, resolveDaemonArtifactRoot } from "./daemon-artifact-identity.ts";

interface BuildProvenance {
  readonly kind: "build-manifest" | "snapshot-manifest";
  readonly sourceRoot: string | null;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
}

type CommandRunner = (command: string, args: ReadonlyArray<string>) => string;

export function captureDaemonDeploymentStatus(input: {
  readonly entrypoint: string;
  readonly loadedIdentity: string;
  readonly installedIdentity: string;
  readonly supervisor?: string;
  readonly pid?: number;
  readonly runCommand?: CommandRunner;
}): DaemonDeploymentStatus {
  const entrypoint = realpathSync(input.entrypoint);
  const artifactRoot = resolveDaemonArtifactRoot(entrypoint);
  const runCommand = input.runCommand ?? systemCommand;
  const manifest = readProvenance(artifactRoot);
  const directSource = isSourceEntrypoint(entrypoint, artifactRoot);
  const provenance: DaemonDeploymentStatus["provenance"] = manifest
    ? {
        kind: manifest.kind,
        sourceCommit: manifest.sourceCommit,
        sourceDirty: manifest.sourceDirty,
        sourceFingerprint: manifest.sourceFingerprint,
        contentFingerprint: manifest.contentFingerprint,
        contentMatchesLoaded: manifest.contentFingerprint === input.loadedIdentity,
        reason: manifest.contentFingerprint === input.loadedIdentity
          ? "recorded artifact fingerprint matches the bytes loaded at daemon start"
          : "recorded artifact fingerprint does not match the bytes loaded at daemon start"
      }
    : directSource
      ? directSourceProvenance(artifactRoot, input.loadedIdentity, runCommand)
      : {
          kind: "unavailable",
          sourceCommit: null,
          sourceDirty: null,
          sourceFingerprint: null,
          contentFingerprint: null,
          contentMatchesLoaded: null,
          reason: "artifact has no verified build or snapshot provenance manifest"
        };
  const checkout = checkoutStatus(manifest?.sourceRoot ?? (directSource ? artifactRoot : null), provenance, runCommand);
  const supervision = inspectDaemonSupervision(input.supervisor, input.pid ?? process.pid, runCommand);
  const failures: DaemonDeploymentStatus["failures"][number][] = [];
  if (input.installedIdentity !== input.loadedIdentity || provenance.contentMatchesLoaded === false) failures.push("artifact-drift");
  if (checkout.matchesProvenance === false) failures.push("checkout-drift");
  if (provenance.sourceDirty === true) failures.push("dirty-build");
  if (provenance.kind === "unavailable") failures.push("provenance-unavailable");
  if (!supervision.matchesPid) failures.push("supervision-unverified");
  return { entrypoint, artifactRoot, provenance, checkout, supervision, healthy: failures.length === 0, failures: [...new Set(failures)] };
}

function directSourceProvenance(sourceRoot: string, loadedIdentity: string, runCommand: CommandRunner): DaemonDeploymentStatus["provenance"] {
  try {
    return {
      kind: "direct-source",
      sourceCommit: git(runCommand, sourceRoot, ["rev-parse", "HEAD"]),
      sourceDirty: git(runCommand, sourceRoot, ["status", "--porcelain"]).length > 0,
      sourceFingerprint: loadedIdentity,
      contentFingerprint: loadedIdentity,
      contentMatchesLoaded: true,
      reason: "daemon is executing the fingerprinted source tree directly"
    };
  } catch {
    return {
      kind: "unavailable", sourceCommit: null, sourceDirty: null, sourceFingerprint: loadedIdentity,
      contentFingerprint: loadedIdentity, contentMatchesLoaded: true,
      reason: "source bytes are fingerprinted but their Git commit cannot be resolved"
    };
  }
}

function checkoutStatus(sourceRoot: string | null, provenance: DaemonDeploymentStatus["provenance"], runCommand: CommandRunner): DaemonDeploymentStatus["checkout"] {
  if (!sourceRoot || !existsSync(sourceRoot)) {
    return { root: sourceRoot, currentCommit: null, currentDirty: null, currentSourceFingerprint: null, matchesProvenance: null };
  }
  try {
    const root = realpathSync(sourceRoot);
    const sourceEntrypoint = path.join(root, "packages", "cli", "src", "index.ts");
    const currentCommit = git(runCommand, root, ["rev-parse", "HEAD"]);
    const currentDirty = git(runCommand, root, ["status", "--porcelain"]).length > 0;
    const currentSourceFingerprint = existsSync(sourceEntrypoint) ? calculateDaemonArtifactIdentity(sourceEntrypoint).identity : null;
    return {
      root, currentCommit, currentDirty, currentSourceFingerprint,
      matchesProvenance: provenance.sourceCommit !== null && provenance.sourceFingerprint !== null
        && currentSourceFingerprint !== null && currentCommit === provenance.sourceCommit
        && currentSourceFingerprint === provenance.sourceFingerprint
    };
  } catch {
    return { root: sourceRoot, currentCommit: null, currentDirty: null, currentSourceFingerprint: null, matchesProvenance: false };
  }
}

export function inspectDaemonSupervision(specification: string | undefined, pid: number, runCommand: CommandRunner = systemCommand): DaemonDeploymentStatus["supervision"] {
  const match = /^(systemd-system|systemd-user|launchd|windows-service):([A-Za-z0-9_.@:-]+)$/u.exec(specification?.trim() ?? "");
  if (!match) return { kind: "unverified", unit: null, managerState: null, observedPid: null, matchesPid: false, reason: "daemon has no valid service-manager witness declaration" };
  const kind = match[1] as Exclude<DaemonDeploymentStatus["supervision"]["kind"], "unverified">;
  const unit = match[2]!;
  try {
    const observed = kind.startsWith("systemd-") ? inspectSystemd(kind as "systemd-system" | "systemd-user", unit, runCommand)
      : kind === "launchd" ? inspectLaunchd(unit, runCommand) : inspectWindowsService(unit, runCommand);
    const matchesPid = observed.pid === pid && (kind.startsWith("systemd-") ? observed.state === "active" : observed.state.toLowerCase() === "running");
    return {
      kind, unit, managerState: observed.state, observedPid: observed.pid, matchesPid,
      reason: matchesPid ? "service manager reports this daemon PID as its active main process"
        : `service manager does not report daemon pid=${pid} as the active main process`
    };
  } catch (error) {
    return {
      kind, unit, managerState: null, observedPid: null, matchesPid: false,
      reason: `service-manager query failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function inspectSystemd(kind: "systemd-system" | "systemd-user", unit: string, runCommand: CommandRunner): { state: string; pid: number | null } {
  const output = runCommand("systemctl", [...(kind === "systemd-user" ? ["--user"] : []), "show", unit, "--property=ActiveState", "--property=MainPID", "--no-pager"]);
  return { state: keyValue(output, "ActiveState") ?? "unknown", pid: positivePid(keyValue(output, "MainPID")) };
}

function inspectLaunchd(unit: string, runCommand: CommandRunner): { state: string; pid: number | null } {
  const uid = process.getuid?.();
  const domains = [...(uid === undefined ? [] : [`gui/${uid}/${unit}`]), `system/${unit}`];
  let lastError: unknown;
  for (const domain of domains) {
    try {
      const output = runCommand("launchctl", ["print", domain]);
      return { state: /^\s*state\s*=\s*(\S+)/mu.exec(output)?.[1] ?? "unknown", pid: positivePid(/^\s*pid\s*=\s*(\d+)/mu.exec(output)?.[1]) };
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("launchd unit was not found");
}

function inspectWindowsService(unit: string, runCommand: CommandRunner): { state: string; pid: number | null } {
  const output = runCommand("sc.exe", ["queryex", unit]);
  return { state: /^\s*STATE\s*:\s*\d+\s+(\S+)/mu.exec(output)?.[1] ?? "unknown", pid: positivePid(/^\s*PID\s*:\s*(\d+)/mu.exec(output)?.[1]) };
}

function readProvenance(artifactRoot: string): BuildProvenance | undefined {
  const buildPath = path.join(artifactRoot, daemonBuildProvenanceFilename);
  if (existsSync(buildPath)) return decodeBuildProvenance(readJson(buildPath));
  const snapshotPath = path.join(path.dirname(artifactRoot), "manifest.json");
  if (!existsSync(snapshotPath)) return undefined;
  const value = readJson(snapshotPath);
  if (!isDeploymentManifestRecord(value) || value.schema !== "daemon-snapshot-manifest/v1" || typeof value.sourceCommit !== "string"
    || typeof value.sourceDirty !== "boolean" || typeof value.sourceFingerprint !== "string" || typeof value.contentFingerprint !== "string") return undefined;
  return { kind: "snapshot-manifest", sourceRoot: null, sourceCommit: value.sourceCommit, sourceDirty: value.sourceDirty, sourceFingerprint: value.sourceFingerprint, contentFingerprint: value.contentFingerprint };
}

function decodeBuildProvenance(value: unknown): BuildProvenance | undefined {
  if (!isDeploymentManifestRecord(value) || value.schema !== "daemon-build-provenance/v1" || typeof value.sourceRoot !== "string" || !path.isAbsolute(value.sourceRoot)
    || typeof value.sourceCommit !== "string" || typeof value.sourceDirty !== "boolean" || typeof value.sourceFingerprint !== "string"
    || typeof value.contentFingerprint !== "string") return undefined;
  return { kind: "build-manifest", sourceRoot: value.sourceRoot, sourceCommit: value.sourceCommit, sourceDirty: value.sourceDirty, sourceFingerprint: value.sourceFingerprint, contentFingerprint: value.contentFingerprint };
}

function isSourceEntrypoint(entrypoint: string, artifactRoot: string): boolean {
  return artifactRoot !== path.dirname(entrypoint) && [".ts", ".mts", ".cts", ".tsx"].includes(path.extname(entrypoint));
}
function git(runCommand: CommandRunner, cwd: string, args: ReadonlyArray<string>): string { return runCommand("git", ["-C", cwd, ...args]).trim(); }
function keyValue(output: string, key: string): string | undefined { return new RegExp(`^${key}=(.*)$`, "mu").exec(output)?.[1]?.trim(); }
function positivePid(value: string | undefined): number | null { const pid = Number.parseInt(value ?? "", 10); return Number.isSafeInteger(pid) && pid > 0 ? pid : null; }
function readJson(filePath: string): unknown { try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return undefined; } }
function isDeploymentManifestRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function systemCommand(command: string, args: ReadonlyArray<string>): string { return execFileSync(command, [...args], { encoding: "utf8", windowsHide: true }).trim(); }

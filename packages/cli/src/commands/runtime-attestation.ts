// Runtime attestation for `ha doctor`. Read-only diagnostics that compare the
// current checkout, the CLI dist artifact and the running daemon process so
// the two historical incident families (daemon silently serving stale code,
// socket unlinked while the process stays alive) surface before they bite.
//
// All checks are read-only: no kills, no restarts, no socket cleanup. Each
// finding carries one explicit repair hint a worker can paste. The inner
// inspection helpers are exported as pure functions so positive-control
// fixtures can drive them against synthetic stale dist / orphan socket setups.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  calculateDaemonArtifactIdentity,
  daemonBuildProvenanceFilename,
  daemonIdFromEnv,
  daemonUserRootForRepo,
  localUserDaemonEndpoint,
  readDaemonSocketOwner
} from "@harness-anything/daemon";
import {
  displayHomePath,
  displaySocketEndpoint,
  extractEntrypointFromCommand,
  gitStatusPorcelain,
  hasFilesUnder,
  latestMtimeIso,
  nullableGitOutput,
  readJsonFile,
  readPsField,
  readPsLstartIso,
  realpathSafe,
  relativeOrAbsolute
} from "./runtime-attestation-helpers.ts";

export type RuntimeAttestationFindingCode =
  | "cli_dist_missing"
  | "cli_dist_stale"
  | "daemon_socket_orphan"
  | "daemon_socket_missing_with_owner"
  | "daemon_socket_owner_unknown"
  | "daemon_process_stale"
  | "daemon_provenance_unavailable"
  | "daemon_provenance_drift"
  | "daemon_user_root_unresolvable";

export interface RuntimeAttestationFinding {
  readonly findingCode: RuntimeAttestationFindingCode;
  readonly severity: "warning";
  readonly message: string;
  readonly repairHint: string;
}

export interface GitRuntimeAttestation {
  readonly insideWorkTree: boolean;
  readonly headCommit: string | null;
  readonly dirty: boolean | null;
  readonly worktree: {
    readonly isLinkedWorktree: boolean;
    readonly commonDirRelative: string | null;
    readonly binding: { readonly taskId: string; readonly branchName: string } | null;
  } | null;
}

export interface CliDistFreshnessAttestation {
  readonly packageRootDisplay: string;
  readonly srcMtimeIso: string | null;
  readonly distMtimeIso: string | null;
  readonly stale: boolean;
  readonly missing: boolean;
}

export interface DaemonRuntimeAttestation {
  readonly userRootDisplay: string;
  readonly socket: {
    readonly endpointDisplay: string;
    readonly exists: boolean;
    readonly owner: { readonly pid: number; readonly alive: boolean } | null;
  };
  readonly process: {
    readonly pid: number;
    readonly startedAtIso: string | null;
    readonly entrypointDisplay: string | null;
    readonly entrypointRaw: string | null;
    readonly staleProcess: boolean;
    readonly referenceMtimeIso: string | null;
  } | null;
  readonly provenance: {
    readonly manifestPathDisplay: string;
    readonly exists: boolean;
    readonly sourceCommit: string | null;
    readonly sourceDirty: boolean | null;
    readonly contentFingerprint: string | null;
    readonly recomputedFingerprint: string | null;
    readonly matches: boolean | null;
  };
}

export interface RuntimeAttestationReport {
  readonly schema: "runtime-attestation/v1";
  readonly readOnly: true;
  readonly checkedAtIso: string;
  readonly platform: NodeJS.Platform;
  readonly git: GitRuntimeAttestation;
  readonly cliDistFreshness: CliDistFreshnessAttestation;
  readonly daemon: DaemonRuntimeAttestation;
  readonly findings: ReadonlyArray<RuntimeAttestationFinding>;
  readonly ok: boolean;
}

interface WorktreeBindingFile {
  readonly schema?: unknown;
  readonly taskId?: unknown;
  readonly branchName?: unknown;
  readonly worktreePath?: unknown;
}

const srcFreshnessExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const distFreshnessExtensions = new Set([".js", ".mjs", ".cjs", ".json"]);

export type DaemonOwnerReader = (
  endpoint: string,
  platform: NodeJS.Platform
) => { readonly pid: number; readonly alive: boolean } | undefined;

export interface CollectRuntimeAttestationInput {
  readonly rootDir: string;
  readonly cliPackageRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly bindingRoot?: string;
  readonly daemonEndpointOverride?: string;
  readonly readDaemonOwner?: DaemonOwnerReader;
}

export function collectRuntimeAttestation(input: CollectRuntimeAttestationInput): RuntimeAttestationReport {
  const checkedAtIso = (input.now ?? (() => new Date()))().toISOString();
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const srcRoot = path.join(input.cliPackageRoot, "src");
  const distRoot = path.join(input.cliPackageRoot, "dist");
  const cliDistFreshness = checkCliDistFreshness(srcRoot, distRoot);
  const distMtimeMs = cliDistFreshness.distMtimeIso ? Date.parse(cliDistFreshness.distMtimeIso) : null;
  const daemonResolution = tryResolveDaemonUserRoot(input.rootDir, env);
  const daemon = inspectDaemonRuntime({
    userRoot: daemonResolution.userRoot,
    daemonId: daemonIdFromEnv(env),
    platform,
    distMtimeMs,
    cliPackageRoot: input.cliPackageRoot,
    endpointOverride: input.daemonEndpointOverride,
    readDaemonOwner: input.readDaemonOwner
  });
  const git = inspectGitRuntime({
    rootDir: input.rootDir,
    bindingRoot: input.bindingRoot ?? path.join(input.rootDir, ".harness", "generated", "worktree-bindings")
  });
  const findings = collectFindings({ cliDistFreshness, daemon, daemonResolutionOk: daemonResolution.ok });
  return {
    schema: "runtime-attestation/v1",
    readOnly: true,
    checkedAtIso,
    platform,
    git,
    cliDistFreshness,
    daemon,
    findings,
    ok: findings.length === 0
  };
}

export function checkCliDistFreshness(srcRoot: string, distRoot: string): CliDistFreshnessAttestation {
  const packageRootDisplay = displayHomePath(path.dirname(srcRoot));
  const srcMtimeIso = latestMtimeIso(srcRoot, srcFreshnessExtensions);
  if (!existsSync(distRoot) || !hasFilesUnder(distRoot, distFreshnessExtensions)) {
    return { packageRootDisplay, srcMtimeIso, distMtimeIso: null, stale: false, missing: true };
  }
  const distMtimeIso = latestMtimeIso(distRoot, distFreshnessExtensions);
  const stale = srcMtimeIso !== null && distMtimeIso !== null && Date.parse(srcMtimeIso) > Date.parse(distMtimeIso);
  return { packageRootDisplay, srcMtimeIso, distMtimeIso, stale, missing: false };
}

export interface InspectDaemonSocketInput {
  readonly endpoint: string;
  readonly platform: NodeJS.Platform;
  readonly readDaemonOwner?: DaemonOwnerReader;
}

export interface DaemonSocketInspection {
  readonly endpointDisplay: string;
  readonly exists: boolean;
  readonly owner: { readonly pid: number; readonly alive: boolean } | null;
}

export function inspectDaemonSocket(input: InspectDaemonSocketInput): DaemonSocketInspection {
  const reader = input.readDaemonOwner ?? readDaemonSocketOwner;
  return {
    endpointDisplay: displaySocketEndpoint(input.endpoint, input.platform),
    exists: existsSync(input.endpoint),
    owner: reader(input.endpoint, input.platform) ?? null
  };
}

export interface InspectDaemonProcessInput {
  readonly pid: number;
  readonly distMtimeMs: number | null;
  readonly platform: NodeJS.Platform;
}

export interface DaemonProcessInspection {
  readonly pid: number;
  readonly startedAtIso: string | null;
  readonly entrypointDisplay: string | null;
  readonly entrypointRaw: string | null;
  readonly staleProcess: boolean;
  readonly referenceMtimeIso: string | null;
}

export function inspectDaemonProcess(input: InspectDaemonProcessInput): DaemonProcessInspection | null {
  const command = readPsField(input.pid, input.platform, "command=");
  if (command === null) return null;
  const entrypointRaw = extractEntrypointFromCommand(command);
  const startedAtIso = readPsLstartIso(input.pid, input.platform);
  const referenceMtimeIso = input.distMtimeMs === null ? null : new Date(input.distMtimeMs).toISOString();
  let staleProcess = false;
  if (startedAtIso !== null && input.distMtimeMs !== null) {
    const startedMs = Date.parse(startedAtIso);
    if (Number.isFinite(startedMs) && startedMs < input.distMtimeMs) {
      staleProcess = true;
    }
  }
  return {
    pid: input.pid,
    startedAtIso,
    entrypointDisplay: entrypointRaw ? displayHomePath(entrypointRaw) : null,
    entrypointRaw,
    staleProcess,
    referenceMtimeIso
  };
}

export interface InspectDaemonProvenanceInput {
  readonly artifactRoot: string;
  readonly entrypoint?: string | null;
}

export interface DaemonProvenanceInspection {
  readonly manifestPathDisplay: string;
  readonly exists: boolean;
  readonly sourceCommit: string | null;
  readonly sourceDirty: boolean | null;
  readonly contentFingerprint: string | null;
  readonly recomputedFingerprint: string | null;
  readonly matches: boolean | null;
}

export function inspectDaemonProvenance(input: InspectDaemonProvenanceInput): DaemonProvenanceInspection {
  const manifestPath = path.join(input.artifactRoot, daemonBuildProvenanceFilename);
  const manifestPathDisplay = displayHomePath(manifestPath);
  if (!existsSync(manifestPath)) return emptyProvenance(manifestPathDisplay);
  const parsed = readJsonFile(manifestPath);
  if (!isBuildProvenanceFile(parsed)) return emptyProvenance(manifestPathDisplay);
  const recomputed = input.entrypoint ? safeRecomputeFingerprint(input.entrypoint) : null;
  return {
    manifestPathDisplay,
    exists: true,
    sourceCommit: parsed.sourceCommit,
    sourceDirty: parsed.sourceDirty,
    contentFingerprint: parsed.contentFingerprint,
    recomputedFingerprint: recomputed,
    matches: recomputed === null ? null : recomputed === parsed.contentFingerprint
  };
}

export function collectFindings(input: {
  readonly cliDistFreshness: CliDistFreshnessAttestation;
  readonly daemon: DaemonRuntimeAttestation;
  readonly daemonResolutionOk: boolean;
}): ReadonlyArray<RuntimeAttestationFinding> {
  const findings: RuntimeAttestationFinding[] = [];
  const { cliDistFreshness: cli, daemon, daemonResolutionOk } = input;
  if (cli.missing) {
    findings.push({
      findingCode: "cli_dist_missing",
      severity: "warning",
      message: `CLI dist is missing under ${cli.packageRootDisplay}; the daemon may be running from source or an older artifact elsewhere.`,
      repairHint: "Rebuild the CLI before relying on its output: npm -w @harness-anything/cli run build."
    });
  } else if (cli.stale) {
    findings.push({
      findingCode: "cli_dist_stale",
      severity: "warning",
      message: `CLI dist is older than source (src ${cli.srcMtimeIso} vs dist ${cli.distMtimeIso}); a daemon started before this rebuild would still serve the previous artifact.`,
      repairHint: "Rebuild and restart: npm -w @harness-anything/cli run build && ha daemon restart."
    });
  }
  if (!daemonResolutionOk) {
    findings.push({
      findingCode: "daemon_user_root_unresolvable",
      severity: "warning",
      message: "Daemon user root could not be resolved for this checkout; skipping daemon socket attestation.",
      repairHint: "Confirm HARNESS_DAEMON_USER_ROOT or HARNESS_DAEMON_PROFILE is set to a supported value."
    });
    return findings;
  }
  const { socket, process: proc, provenance } = daemon;
  if (socket.exists && socket.owner && !socket.owner.alive) {
    findings.push({
      findingCode: "daemon_socket_orphan",
      severity: "warning",
      message: `Daemon socket at ${socket.endpointDisplay} has a recorded owner pid ${socket.owner.pid} that is no longer alive; the daemon exited without releasing the socket, or the socket file is stale.`,
      repairHint: "Restart the daemon so the socket and owner record converge: ha daemon restart."
    });
  }
  if (!socket.exists && socket.owner && socket.owner.alive) {
    findings.push({
      findingCode: "daemon_socket_missing_with_owner",
      severity: "warning",
      message: `Daemon owner file claims pid ${socket.owner.pid} is alive but the socket at ${socket.endpointDisplay} is gone; the process is unreachable.`,
      repairHint: "Restart the daemon to rebind the socket: ha daemon restart."
    });
  }
  if (socket.exists && !socket.owner) {
    findings.push({
      findingCode: "daemon_socket_owner_unknown",
      severity: "warning",
      message: `Daemon socket at ${socket.endpointDisplay} exists without a readable owner record; another user's daemon or a leftover socket may be present.`,
      repairHint: "Inspect the .owner file beside the endpoint; restart the daemon if it is yours."
    });
  }
  if (proc?.staleProcess) {
    findings.push({
      findingCode: "daemon_process_stale",
      severity: "warning",
      message: `Daemon pid ${proc.pid} started at ${proc.startedAtIso}, before the current dist mtime ${proc.referenceMtimeIso}; it is serving the previous artifact.`,
      repairHint: "Restart the daemon so it reloads the rebuilt dist: ha daemon restart."
    });
  }
  if (provenance.exists) {
    if (provenance.matches === false) {
      findings.push({
        findingCode: "daemon_provenance_drift",
        severity: "warning",
        message: `Daemon build provenance at ${provenance.manifestPathDisplay} records content ${provenance.contentFingerprint ?? "?"} but the same tree currently hashes to ${provenance.recomputedFingerprint ?? "?"}.`,
        repairHint: "Rebuild the CLI so provenance matches the bytes on disk: npm -w @harness-anything/cli run build."
      });
    }
  } else if (daemon.process) {
    findings.push({
      findingCode: "daemon_provenance_unavailable",
      severity: "warning",
      message: `No daemon-build-provenance.json found at ${provenance.manifestPathDisplay}; the running daemon's source commit cannot be verified.`,
      repairHint: "Rebuild the CLI so provenance is written: npm -w @harness-anything/cli run build."
    });
  }
  return findings;
}

interface DaemonResolution {
  readonly ok: boolean;
  readonly userRoot: string | null;
}

function tryResolveDaemonUserRoot(rootDir: string, env: NodeJS.ProcessEnv): DaemonResolution {
  try {
    return { ok: true, userRoot: daemonUserRootForRepo(rootDir, env) };
  } catch {
    return { ok: false, userRoot: null };
  }
}

function inspectDaemonRuntime(input: {
  readonly userRoot: string | null;
  readonly daemonId: string;
  readonly platform: NodeJS.Platform;
  readonly distMtimeMs: number | null;
  readonly cliPackageRoot: string;
  readonly endpointOverride?: string;
  readonly readDaemonOwner?: DaemonOwnerReader;
}): DaemonRuntimeAttestation {
  if (!input.userRoot) {
    return {
      userRootDisplay: "(unresolvable)",
      socket: { endpointDisplay: "(unresolvable)", exists: false, owner: null },
      process: null,
      provenance: emptyProvenance("(unresolvable)")
    };
  }
  const endpoint = input.endpointOverride ?? localUserDaemonEndpoint(input.userRoot, input.daemonId, input.platform);
  const socket = inspectDaemonSocket({
    endpoint,
    platform: input.platform,
    readDaemonOwner: input.readDaemonOwner
  });
  let processInfo: DaemonProcessInspection | null = null;
  if (socket.owner && socket.owner.alive) {
    processInfo = inspectDaemonProcess({
      pid: socket.owner.pid,
      distMtimeMs: input.distMtimeMs,
      platform: input.platform
    });
  }
  const artifactRoot = path.join(input.cliPackageRoot, "dist");
  const entrypoint = processInfo?.entrypointRaw ?? null;
  const provenance = inspectDaemonProvenance({ artifactRoot, entrypoint });
  return {
    userRootDisplay: displayHomePath(input.userRoot),
    socket,
    process: processInfo,
    provenance
  };
}

function inspectGitRuntime(input: {
  readonly rootDir: string;
  readonly bindingRoot: string;
}): GitRuntimeAttestation {
  const insideWorkTree = nullableGitOutput(input.rootDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!insideWorkTree) {
    return { insideWorkTree: false, headCommit: null, dirty: null, worktree: null };
  }
  const headCommit = nullableGitOutput(input.rootDir, ["rev-parse", "HEAD"]);
  const dirty = gitStatusPorcelain(input.rootDir).length > 0;
  const absoluteGitDir = nullableGitOutput(input.rootDir, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = nullableGitOutput(input.rootDir, ["rev-parse", "--git-common-dir"]);
  const isLinkedWorktree = computeIsLinkedWorktree(absoluteGitDir, commonDir);
  const binding = isLinkedWorktree ? findBindingForWorktree(input.bindingRoot, input.rootDir) : null;
  return {
    insideWorkTree: true,
    headCommit,
    dirty,
    worktree: {
      isLinkedWorktree,
      commonDirRelative: commonDir ? relativeOrAbsolute(input.rootDir, commonDir) : null,
      binding
    }
  };
}

function computeIsLinkedWorktree(absoluteGitDir: string | null, commonDir: string | null): boolean {
  if (!absoluteGitDir || !commonDir) return false;
  const normalizedCommon = path.resolve(commonDir);
  const normalizedGitDir = path.resolve(absoluteGitDir);
  if (normalizedCommon === normalizedGitDir) return false;
  return normalizedGitDir.startsWith(`${normalizedCommon}${path.sep}worktrees${path.sep}`);
}

function findBindingForWorktree(bindingRoot: string, rootDir: string): { readonly taskId: string; readonly branchName: string } | null {
  if (!existsSync(bindingRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(bindingRoot);
  } catch {
    return null;
  }
  const realRoot = realpathSafe(rootDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const parsed = readJsonFile(path.join(bindingRoot, entry)) as WorktreeBindingFile;
    if (!parsed || parsed.schema !== "task-worktree-binding/v1") continue;
    if (typeof parsed.taskId !== "string" || typeof parsed.branchName !== "string" || typeof parsed.worktreePath !== "string") continue;
    if (realpathSafe(parsed.worktreePath) === realRoot) {
      return { taskId: parsed.taskId, branchName: parsed.branchName };
    }
  }
  return null;
}

function safeRecomputeFingerprint(entrypoint: string): string | null {
  try {
    return calculateDaemonArtifactIdentity(entrypoint).identity;
  } catch {
    return null;
  }
}

function isBuildProvenanceFile(value: unknown): value is {
  readonly schema: "daemon-build-provenance/v1";
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schema === "daemon-build-provenance/v1"
    && typeof record.sourceCommit === "string"
    && typeof record.sourceDirty === "boolean"
    && typeof record.sourceFingerprint === "string"
    && typeof record.contentFingerprint === "string";
}

function emptyProvenance(manifestPathDisplay: string): DaemonProvenanceInspection {
  return {
    manifestPathDisplay,
    exists: false,
    sourceCommit: null,
    sourceDirty: null,
    contentFingerprint: null,
    recomputedFingerprint: null,
    matches: null
  };
}

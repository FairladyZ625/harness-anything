import type * as AccessStatus from "@harness-anything/kernel/internal/domain/access-status.ts";
// `ha edge join <link>`: authenticate the invited person over the center's pinned TLS channel,
// then register and sync one local mirror for each repository carried by the invitation.
import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileDurably } from "@harness-anything/storage";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { runProcessExitAsync, runProcessTextAsync } from "../process-port.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { OidcLoginAuthority } from "@harness-anything/kernel";
import { decodeEdgeJoinLink } from "./edge-join.ts";
import { probeFleetEdgeCenterAddress, requestFleetEdgeJoinPinned, requestFleetEdgeJoinStatusPinned } from "./peer.ts";
import { fetchWithTlsCa, systemCaCertificates } from "../tls-ca-certificate.ts";
import { fleetEdgeRepositoryGitFailure, isSupportedFleetGitRemote } from "../fleet-edge-git-preflight.ts";

const DEFAULT_QUOTA_FRACTION = daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinQuotaFraction;

/** One repository's stage inside a running join; observation only, it never steers the join. */
export interface EdgeJoinRepositoryProgress {
  readonly repoId: string;
  readonly phase: AccessStatus.EdgeJoinRepositoryPhase;
}

/** The phases of the one join a daemon is currently running, for a read-only viewer poll. */
export interface EdgeJoinProgressSnapshot {
  readonly joinId: string;
  readonly repositories: readonly EdgeJoinRepositoryProgress[];
}

/**
 * Keeps the running join's per-repository phases in memory so a reader can paint progress while
 * `joinFleetEdge` is still awaiting register/sync. Transient: never persisted, never steers a join.
 */
export function createEdgeJoinProgressTap(): {
  readonly record: (event: { readonly joinId: string; readonly repository: EdgeJoinRepositoryProgress }) => void;
  readonly read: () => EdgeJoinProgressSnapshot | { readonly repositories: readonly [] };
} {
  let snapshot: { joinId: string; repositories: EdgeJoinRepositoryProgress[] } | undefined;
  return {
    record: ({ joinId, repository }) => {
      const current = snapshot?.joinId === joinId ? snapshot.repositories : [];
      snapshot = {
        joinId,
        repositories: [...current.filter((row) => row.repoId !== repository.repoId), repository],
      };
    },
    read: () => snapshot ?? { repositories: [] },
  };
}

export interface EdgeJoinClientPorts {
  /** The person signed in on this daemon, if any. */
  readonly session: (loginTarget: string) => Promise<
    | {
        readonly accessToken: string;
        readonly authority: {
          readonly url: string;
          readonly realm: string;
          readonly certificate?: string;
          readonly servername?: string;
        };
      }
    | undefined
  >;
  readonly beginLogin: (authority: OidcLoginAuthority, loginTarget: string) => Promise<Record<string, unknown>>;
  readonly register: (rootDir: string, repoId: string) => Promise<unknown>;
  readonly sync: (payload: JsonObject) => Promise<Record<string, unknown>>;
  readonly join?: typeof requestFleetEdgeJoinPinned;
  readonly status?: typeof requestFleetEdgeJoinStatusPinned;
  readonly probeCenter?: typeof probeFleetEdgeCenterAddress;
  readonly probeLogin?: (authority: OidcLoginAuthority) => Promise<void>;
  readonly homeDir?: string;
  /** Test seam for the filesystem capacity used by the derived quota. */
  readonly availableBytes?: (rootDir: string) => number;
  /** Receives each repository's phase as the join loop advances, so a viewer can show progress. */
  readonly onProgress?: (progress: {
    readonly joinId: string;
    readonly repository: EdgeJoinRepositoryProgress;
  }) => void;
}

export async function joinFleetEdge(
  request: {
    readonly link: string;
    readonly workspaceRoot?: string;
    readonly quotaBytes?: number;
    readonly originUrls?: Readonly<Record<string, string>>;
  },
  ports: EdgeJoinClientPorts,
): Promise<Record<string, unknown>> {
  const link = decodeEdgeJoinLink(request.link);
  if (request.quotaBytes !== undefined && (!Number.isSafeInteger(request.quotaBytes) || request.quotaBytes <= 0))
    throw Object.assign(new Error("Edge join quota must be a positive integer."), { code: "edge_join_quota_invalid" });
  const authority = {
    url: link.loginUrl,
    realm: link.loginRealm,
    clientId: link.loginClientId,
    ...(link.loginServername ? { servername: link.loginServername } : {}),
    ...(link.loginBrowserUrl ? { browserUrl: link.loginBrowserUrl } : {}),
    ...(link.loginCertificate ? { certificate: link.loginCertificate } : {}),
  };
  const loginTarget = edgeWorkspaceRoot(link.repoIds[0]!, request.workspaceRoot, ports.homeDir ?? homedir());
  const center = new URL(link.centerOrigin),
    centerServername = link.centerServername ?? center.hostname,
    centerProbe = Promise.resolve().then(() =>
      (ports.probeCenter ?? probeFleetEdgeCenterAddress)({
        hostname: center.hostname,
        port: Number(center.port || 443),
        servername: centerServername,
        spkiSha256: link.spkiSha256,
      }),
    ),
    loginProbe = Promise.resolve().then(() => (ports.probeLogin ?? probeLoginAddress)(authority)),
    [centerResult, loginResult] = await Promise.allSettled([centerProbe, loginProbe]),
    failedAddresses = [
      ...(centerResult.status === "rejected" ? [{ address: "Center service", error: centerResult.reason }] : []),
      ...(loginResult.status === "rejected" ? [{ address: "Sign-in service", error: loginResult.reason }] : []),
    ];
  if (failedAddresses.length === 1) throw failedAddresses[0]!.error;
  if (failedAddresses.length > 1)
    throw Object.assign(
      new Error(
        failedAddresses
          .map(
            ({ address, error }) =>
              address + " address check failed: " + (error instanceof Error ? error.message : String(error)),
          )
          .join(" "),
      ),
      {
        code: "edge_join_addresses_unreachable",
        cause: new AggregateError(
          failedAddresses.map(({ error }) => error),
          "Both invitation addresses are unreachable.",
        ),
      },
    );
  const session = await ports.session(loginTarget);
  // An invitation CA is authoritative when present; public-trust invitations leave CA rotation unpinned.
  if (
    !session ||
    session.authority.url !== authority.url ||
    session.authority.realm !== authority.realm ||
    session.authority.servername !== authority.servername ||
    (link.loginCertificate !== undefined && session.authority.certificate !== link.loginCertificate)
  ) {
    const login = await ports.beginLogin(authority, loginTarget);
    return {
      ...login,
      command: "edge-join",
      ...(link.transport ? { transport: link.transport } : {}),
      ...(link.transport === "ssh-reverse" && authority.browserUrl && typeof login.verificationUri === "string"
        ? { browserApprovalUri: login.verificationUri }
        : {}),
    };
  }
  const port = Number(center.port || 443),
    address = {
      hostname: center.hostname,
      port,
      servername: centerServername,
      spkiSha256: link.spkiSha256,
      joinId: link.joinId,
      accessToken: session.accessToken,
    },
    join = ports.join ?? requestFleetEdgeJoinPinned;
  const admitted = await join({ ...address, ...(link.token === undefined ? {} : { inviteToken: link.token }) }).catch(
    async (error: unknown) => {
      if ((error as { code?: string }).code !== "already_consumed") throw error;
      const status = await (ports.status ?? requestFleetEdgeJoinStatusPinned)(address);
      if (status.state !== "consumed" || !status.nodeId) throw error;
      const saved = link.repoIds
        .map((repoId) =>
          readFleetEdgeConfig(edgeWorkspaceRoot(repoId, request.workspaceRoot, ports.homeDir ?? homedir())),
        )
        .find(
          (config) =>
            config !== null &&
            config.nodeId === status.nodeId &&
            config.host === center.hostname &&
            config.port === port &&
            (config.servername ?? center.hostname) === centerServername,
        );
      return join({
        ...address,
        recovery: { nodeId: status.nodeId, ...(saved ? { credential: saved.credential } : {}) },
      });
    },
  );
  const certificate = new X509Certificate(Buffer.from(admitted.certificate, "base64")).toString(),
    repositories = [] as {
      readonly repoId: string;
      readonly workspaceRoot: string;
      readonly mirrorOutcome?: unknown;
      readonly knownHead?: unknown;
      readonly ok: boolean;
      readonly code?: unknown;
      readonly error?: unknown;
      readonly needsOrigin?: boolean;
      readonly defaultBranch?: string;
      readonly centerOrigin?: string;
    }[];

  for (const repository of admitted.repositories) {
    const root = edgeWorkspaceRoot(repository.repoId, request.workspaceRoot, ports.homeDir ?? homedir()),
      caPath = path.join(root, "fleet-center-ca.pem"),
      report = (phase: EdgeJoinRepositoryProgress["phase"]) =>
        ports.onProgress?.({ joinId: admitted.joinId, repository: { repoId: repository.repoId, phase } });
    report("workspace");
    const workspaceFailure = await prepareJoinWorkspace(root, repository, request.originUrls?.[repository.repoId]);
    if (workspaceFailure !== null) {
      const failedWorkspace = workspaceFailure;
      report("failed");
      repositories.push({
        repoId: repository.repoId,
        workspaceRoot: root,
        ok: false,
        ...edgeJoinSyncFailure(repository.repoId, failedWorkspace),
        ...(failedWorkspace.needsOrigin === true ? { needsOrigin: true } : {}),
        ...(failedWorkspace.defaultBranch ? { defaultBranch: failedWorkspace.defaultBranch } : {}),
        ...(failedWorkspace.centerOrigin ? { centerOrigin: failedWorkspace.centerOrigin } : {}),
      });
      continue;
    }
    // The pinned certificate and join receipt are local trust/configuration, never part of the Git checkout.
    const previous = readFleetEdgeConfig(root),
      saved = previous?.nodeId === admitted.nodeId ? previous : null,
      savedWaitTimeoutMs = saved?.waitTimeoutMs,
      savedMaxAgeMs = saved?.maxAgeMs,
      savedMaxLagRevisions = saved?.maxLagRevisions,
      quotaBytes =
        request.quotaBytes ??
        saved?.quotaBytes ??
        deriveEdgeJoinQuotaBytes(root, ports.availableBytes ?? ((directory) => availableFilesystemBytes(directory)));
    writeFileDurably(caPath, certificate);
    writeFleetEdgeConfig(root, {
      ...(savedWaitTimeoutMs === undefined ? {} : { waitTimeoutMs: savedWaitTimeoutMs }),
      ...(savedMaxAgeMs === undefined ? {} : { maxAgeMs: savedMaxAgeMs }),
      ...(savedMaxLagRevisions === undefined ? {} : { maxLagRevisions: savedMaxLagRevisions }),
      repoId: repository.repoId,
      host: center.hostname,
      port,
      servername: centerServername,
      caPath,
      nodeId: admitted.nodeId,
      credential: admitted.credential,
      loginUrl: authority.url,
      loginRealm: authority.realm,
      ...(authority.servername ? { loginServername: authority.servername } : {}),
      ...(authority.browserUrl ? { loginBrowserUrl: authority.browserUrl } : {}),
      ...(authority.certificate ? { loginCertificate: authority.certificate } : {}),
      viewRoot: `${root}-view`,
      quotaBytes,
    });
    report("register");
    await ports.register(root, repository.repoId);
    const preflightFailure = await fleetEdgeRepositoryGitFailure({
      rootDir: root,
      center: repository,
      operation: "edge sync",
    });
    if (preflightFailure) {
      report("failed");
      repositories.push({
        repoId: repository.repoId,
        workspaceRoot: root,
        ok: false,
        ...edgeJoinSyncFailure(repository.repoId, preflightFailure),
      });
      continue;
    }
    report("sync");
    const synced = await ports.sync({
      repoId: repository.repoId,
      workspaceRoot: root,
      host: center.hostname,
      port,
      servername: centerServername,
      caPath,
      nodeId: admitted.nodeId,
      credential: admitted.credential,
      viewRoot: `${root}-view`,
      quotaBytes,
      timeoutMs: daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinTimeoutMs,
    });
    if (synced.ok === false) {
      report("failed");
      repositories.push({
        repoId: repository.repoId,
        workspaceRoot: root,
        ok: false,
        ...edgeJoinSyncFailure(repository.repoId, synced),
      });
      continue;
    }
    report("synced");
    repositories.push({
      repoId: repository.repoId,
      workspaceRoot: root,
      ok: true,
      ...(synced.mirrorOutcome === undefined ? {} : { mirrorOutcome: synced.mirrorOutcome }),
      ...(synced.knownHead === undefined ? {} : { knownHead: synced.knownHead }),
    });
  }
  const failure = repositories.find((repository) => !repository.ok);
  // Missing origin is an intentional pause: the GUI must keep the receipt so the operator can
  // supply a reachable address and retry. Any other failed repository is a real join failure and
  // must propagate to CLI/GUI callers instead of being reported as a successful partial join.
  const recoverable = repositories.every((repository) => repository.ok || repository.needsOrigin === true),
    failureReply: { readonly code?: string; readonly error?: unknown } = recoverable
      ? {}
      : { code: "edge_join_sync_failed", error: failure?.error };
  return {
    ok: recoverable,
    ...failureReply,
    command: "edge-join",
    joinId: admitted.joinId,
    state: repositories.every((repository) => repository.ok) ? "synced" : "partial",
    repoIds: repositories.map((repository) => repository.repoId),
    repositories,
    nodeId: admitted.nodeId,
    personId: admitted.personId,
  };
}

function edgeJoinSyncFailure(repoId: string, error: unknown): { readonly code: string; readonly error: JsonObject } {
  const observed = error as { readonly code?: unknown; readonly message?: unknown; readonly error?: unknown } | null,
    code = typeof observed?.code === "string" ? observed.code : "replica_sync_failed",
    nested = observed?.error as { readonly hint?: unknown; readonly code?: unknown } | null,
    message =
      typeof nested?.hint === "string"
        ? nested.hint
        : error instanceof Error
          ? error.message
          : typeof observed?.message === "string"
            ? observed.message
            : typeof error === "string"
              ? error
              : code,
    quotaAction = /disk quota/u.test(message)
      ? " Increase the quota with ha daemon fleet edge sync --quota-bytes <bytes>, then retry."
      : " Resolve the reported cause, then retry with ha daemon fleet edge sync.";
  return {
    code,
    error: { code, hint: `Edge repository ${repoId} failed during initial sync: ${message}.${quotaAction}` },
  };
}

export function deriveEdgeJoinQuotaBytes(rootDir: string, availableBytes: (rootDir: string) => number): number {
  const available = availableBytes(rootDir);
  if (!Number.isSafeInteger(available) || available <= 0)
    throw Object.assign(new Error(`Unable to determine available disk space for ${rootDir}.`), {
      code: "edge_join_disk_space_unavailable",
    });
  const quota = Math.floor(available * DEFAULT_QUOTA_FRACTION);
  if (quota <= 0)
    throw Object.assign(new Error(`No usable disk space is available for edge repository ${rootDir}.`), {
      code: "edge_join_disk_space_unavailable",
    });
  return quota;
}

function availableFilesystemBytes(rootDir: string): number {
  const stats = statfsSync(rootDir);
  return stats.bavail * stats.bsize;
}

async function prepareJoinWorkspace(
  root: string,
  repository: {
    readonly harnessYaml: string;
    readonly originUrl: string | null;
    readonly originAddress?: string | null;
    readonly defaultBranch: string | null;
    readonly defaultBranchCommit: string | null;
  },
  originUrl: string | undefined,
): Promise<{
  readonly code: string;
  readonly message: string;
  readonly needsOrigin?: boolean;
  readonly defaultBranch?: string;
  readonly centerOrigin?: string;
} | null> {
  /* @gate-identity non-state/environment-io.6cc0d5c726eb11a2 */ mkdirSync(root, { recursive: true });
  const hasGit = existsSync(path.join(root, ".git"));
  if (!repository.originUrl) {
    if (!hasGit) await prepareWorkspace(root, repository.harnessYaml, repository.defaultBranch ?? "main");
    return null;
  }

  if (!hasGit && readdirSync(root).length > 0)
    return {
      code: "edge_workspace_not_empty",
      message: `The workspace ${root} contains files and cannot be cloned over. Move those files or choose an empty workspace, then retry.`,
    };
  const currentOrigin = hasGit
    ? await runProcessTextAsync("git", ["-C", root, "remote", "get-url", "origin"]).catch(() => "")
    : "";
  if (currentOrigin.trim()) {
    ensureCenterLayout(root, repository.harnessYaml);
    return null;
  }
  if (!repository.defaultBranch || !repository.defaultBranchCommit)
    return {
      code: "center_default_branch_unavailable",
      message: "The center did not provide a readable default branch head. Repair the center repository and retry.",
    };
  const needsOrigin = {
    needsOrigin: true,
    defaultBranch: repository.defaultBranch,
    ...(repository.originAddress ? { centerOrigin: repository.originAddress } : {}),
  };
  if (!originUrl) {
    if (hasGit) ensureCenterLayout(root, repository.harnessYaml);
    return {
      code: "edge_origin_missing",
      message: `${root} needs a Git origin that can reach the center repository. Enter a reachable Git address; it will be checked before cloning.`,
      ...needsOrigin,
    };
  }
  const addressFailure = await validateFleetOriginAddress(root, originUrl, repository.defaultBranch);
  if (addressFailure) return { ...addressFailure, ...needsOrigin };
  if (hasGit) {
    try {
      await runProcessTextAsync("git", ["-C", root, "remote", "add", "origin", originUrl]);
    } catch {
      return {
        code: "edge_origin_add_failed",
        message:
          "The checked Git address could not be added because the workspace changed. Inspect its remotes, then retry.",
      };
    }
    ensureCenterLayout(root, repository.harnessYaml);
    return null;
  }
  try {
    await runProcessTextAsync("git", [
      "clone",
      "--quiet",
      "--single-branch",
      "--branch",
      repository.defaultBranch,
      "--",
      originUrl,
      root,
    ]);
    ensureCenterLayout(root, repository.harnessYaml);
    return null;
  } catch {
    return {
      code: "edge_origin_clone_failed",
      message:
        "The Git address passed ls-remote but the default branch could not be cloned. Check repository read access, then retry.",
      ...needsOrigin,
    };
  }
}

function ensureCenterLayout(root: string, harnessYaml: string): void {
  const layout = path.join(root, "harness", "harness.yaml");
  if (existsSync(layout)) return;
  /* @gate-identity non-state/environment-io.983af9eb1df07bc2 */ mkdirSync(path.dirname(layout), { recursive: true });
  writeFileDurably(layout, harnessYaml);
}

async function validateFleetOriginAddress(
  rootDir: string,
  address: string,
  defaultBranch: string | null,
): Promise<{ readonly code: string; readonly message: string } | null> {
  const trimmed = address.trim();
  if (!defaultBranch || !isSupportedFleetGitRemote(trimmed))
    return {
      code: "edge_origin_invalid",
      message: "Enter a valid HTTPS, SSH, Git, or local Git address and ensure the center default branch is available.",
    };
  const result = await runProcessExitAsync(
    "git",
    ["ls-remote", "--exit-code", "--heads", trimmed, `refs/heads/${defaultBranch}`],
    rootDir,
    { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    undefined,
    undefined,
    { timeoutMs: daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinAddressTimeoutMs },
  ).catch(() => null);
  if (!result || result.exitCode !== 0)
    return {
      code: "edge_origin_unreachable",
      message: `Git could not reach the supplied address or find the center default branch ${defaultBranch}. Check the address and repository read access, then retry.`,
    };
  return null;
}

async function probeLoginAddress(authority: OidcLoginAuthority): Promise<void> {
  const realmUrl = new URL(`realms/${encodeURIComponent(authority.realm)}`, `${authority.url.replace(/\/$/u, "")}/`),
    address = new URL(authority.url).origin;
  try {
    const request = authority.servername
      ? fetchWithTlsCa(
          fetch,
          authority.certificate ?? systemCaCertificates(),
          realmUrl,
          { signal: AbortSignal.timeout(5_000) },
          authority.servername,
        )
      : authority.certificate
        ? fetchWithTlsCa(fetch, authority.certificate, realmUrl, { signal: AbortSignal.timeout(5_000) })
        : fetch(realmUrl, { signal: AbortSignal.timeout(5_000) });
    const response = await request;
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw Object.assign(
      new Error(
        `Login service address ${address} is unreachable or refused its realm check; check its DNS, routing, port mapping, HTTPS certificate, and realm.`,
      ),
      { code: "login_address_unreachable", cause: error },
    );
  }
}

function edgeWorkspaceRoot(repoId: string, requestedRoot: string | undefined, homeDir: string): string {
  if (!requestedRoot) return path.join(homeDir, "harness-edge", repoId);
  const base = path.resolve(requestedRoot);
  return path.join(base, repoId);
}

/** A remote-edge registration needs the center's layout file inside a Git repository with a branch. */
async function prepareWorkspace(root: string, harnessYaml: string, defaultBranch: string): Promise<void> {
  ensureCenterLayout(root, harnessYaml);
  // A local-only center has no history to clone; keep the branch empty rather than creating a forked commit.
  if (existsSync(path.join(root, ".git"))) return;
  const git = (...args: readonly string[]) => runProcessTextAsync("git", ["-C", root, ...args]);
  await git("init", "-q", "-b", defaultBranch);
  await git("add", "harness/harness.yaml");
}

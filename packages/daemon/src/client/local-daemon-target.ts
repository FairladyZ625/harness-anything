import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonRegistryRepo } from "@harness-anything/kernel";
import {
  canonicalRoot as bindCanonicalRoot,
  endpointIdentity,
  workspaceId,
  type CanonicalRoot,
  type EndpointIdentity,
  type WorkspaceId,
} from "../protocol/daemon-protocol.contract.ts";

export interface LocalDaemonTarget {
  readonly repoId: WorkspaceId;
  readonly canonicalRoot: CanonicalRoot;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly socketPath: EndpointIdentity;
}
export interface LocalDaemonTargetInput {
  readonly rootDir: string;
  readonly repoIdOverride?: string;
  /** The registration mode the caller needs; named in the unregistered-workspace remedy. */
  readonly registrationMode?: "remote-edge";
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly env?: NodeJS.ProcessEnv;
}
export function localUserDaemonEndpoint(
  userRoot = daemonUserRoot(),
  daemonId = daemonIdFromEnv(),
  platform: NodeJS.Platform = process.platform,
): EndpointIdentity {
  const id = localDaemonTargetKey(userRoot, daemonId);
  return endpointIdentity(platform === "win32" ? `\\\\.\\pipe\\harness-anything-${id}` : defaultUnixSocketPath(id));
}
/** What makes one (user root, daemon id) a distinct daemon on this machine: its endpoint and its service unit share it. */
export function localDaemonTargetKey(userRoot: string, daemonId: string): string {
  return `u-${localDaemonTargetHash(`${path.resolve(userRoot)}\0${daemonId}`)}`;
}
export function daemonUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.HARNESS_DAEMON_USER_ROOT || path.join(os.homedir(), ".harness"));
}
export function daemonIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_DAEMON_ID || "default";
}
export function resolveLocalDaemonEndpoint(input: {
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoId?: string;
  readonly canonicalRoot?: string;
}): EndpointIdentity {
  const env = input.env ?? process.env,
    userRoot = path.resolve(input.userRoot ?? daemonUserRoot(env)),
    daemonId = input.daemonId ?? daemonIdFromEnv(env),
    expected = localUserDaemonEndpoint(userRoot, daemonId),
    injected = env.HARNESS_DAEMON_ENDPOINT?.trim();
  if (!injected) {
    if (env.HARNESS_DAEMON_RELAY === "1")
      throw Object.assign(new Error("daemon_relay_target_required"), {
        code: "daemon_target_conflict",
        params: { endpoint: null, repoId: input.repoId ?? null },
      });
    return expected;
  }
  const endpoint = endpointIdentity(injected);
  // An explicitly injected POSIX socket may live in a different directory. In relay mode the
  // endpoint must be this user's per-dispatch callback relay; otherwise its basename
  // carries the hash of the sealed (userRoot, daemonId) pair.
  const accepted =
    env.HARNESS_DAEMON_RELAY === "1"
      ? isDispatchRelayEndpoint(endpoint)
      : process.platform !== "win32"
        ? path.basename(endpoint) === path.basename(expected)
        : endpoint === expected;
  if (accepted) return endpoint;
  throw Object.assign(new Error("daemon_target_conflict"), {
    code: "daemon_target_conflict",
    params: {
      endpoint,
      expected,
      userRoot,
      daemonId,
      repoId: input.repoId ?? null,
      canonicalRoot: input.canonicalRoot ?? null,
    },
  });
}
export async function resolveLocalDaemonTarget(input: LocalDaemonTargetInput): Promise<LocalDaemonTarget> {
  const env = input.env ?? process.env;
  const userRoot = path.resolve(input.userRoot ?? daemonUserRoot(env));
  return resolveLocalDaemonTargetFromRepos(input, await readRegisteredRepos(userRoot));
}

export function resolveLocalDaemonTargetFromRepos(
  input: LocalDaemonTargetInput,
  repos: ReadonlyArray<DaemonRegistryRepo>,
): LocalDaemonTarget {
  const env = input.env ?? process.env,
    userRoot = path.resolve(input.userRoot ?? daemonUserRoot(env));
  const daemonId = input.daemonId ?? daemonIdFromEnv(env),
    registeredRepos = repos.filter(
      (repo): repo is DaemonRegistryRepo & { readonly canonicalRoot: string } => repo.canonicalRoot !== null,
    );
  const requested = input.repoIdOverride ?? env.HARNESS_DAEMON_REPO_ID;
  const rootDir = bindCanonicalRoot(input.rootDir);
  const rootedRepos = registeredRepos
    .filter(
      (candidate) => candidate.canonicalRoot === rootDir || rootDir.startsWith(`${candidate.canonicalRoot}${path.sep}`),
    )
    .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length);
  const repo = input.repoIdOverride
    ? registeredRepos.find((candidate) => candidate.repoId === requested && candidate.state === "enabled")
    : env.HARNESS_DAEMON_REPO_ID
      ? (registeredRepos.find(
          (candidate) =>
            candidate.repoId === requested &&
            candidate.state === "enabled" &&
            (candidate.canonicalRoot === rootDir || rootDir.startsWith(`${candidate.canonicalRoot}${path.sep}`)),
        ) ?? rootedRepos[0])
      : rootedRepos[0];
  if (!repo || repo.state !== "enabled")
    throw Object.assign(
      new Error(
        repo
          ? `workspace is blocked by disabled repoId ${JSON.stringify(repo.repoId)} at ` +
            `${JSON.stringify(repo.canonicalRoot)}; run ha repo unbind ${repo.repoId} to remove it`
          : `workspace is not registered; run ha daemon repo register --repo-id <id> --root ` +
            JSON.stringify(path.resolve(input.rootDir)) +
            (input.registrationMode ? ` --mode ${input.registrationMode}` : ""),
      ),
      { code: "workspace_not_registered" },
    );
  const socketPath = resolveLocalDaemonEndpoint({
    userRoot,
    daemonId,
    env,
    repoId: repo.repoId,
    canonicalRoot: repo.canonicalRoot,
  });
  return {
    repoId: workspaceId(repo.repoId),
    canonicalRoot: bindCanonicalRoot(repo.canonicalRoot),
    userRoot,
    daemonId,
    socketPath,
  };
}
export async function readRegisteredRepos(
  userRoot: string,
): Promise<ReadonlyArray<DaemonRegistryRepo & { readonly canonicalRoot: string }>> {
  if (!existsSync(path.join(userRoot, "registry.json"))) return [];
  const { readDaemonRegistry } = await import("@harness-anything/kernel/daemon-registry");
  return readDaemonRegistry({ userRoot }).repos.filter(
    (repo): repo is DaemonRegistryRepo & { readonly canonicalRoot: string } => repo.canonicalRoot !== null,
  );
}
function localDaemonTargetHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
/** An injected relay endpoint is accepted only at the per-dispatch location under this user's
 * socket root: the directory is owner-only (0700, ownership-checked at creation) and the name
 * carries the dispatch id, so any other socket — another user's, another dispatch's, or an
 * arbitrary one — fails the shape. The sandboxed worker cannot write there at all, so no
 * per-component symlink walk is needed to keep the endpoint from being redirected. */
function isDispatchRelayEndpoint(endpoint: string): boolean {
  const resolved = path.resolve(endpoint);
  return path.dirname(resolved) === perUserSocketRoot() && /^r-[a-f0-9]{24}\.sock$/u.test(path.basename(resolved));
}

export function perUserSocketRoot(uid = process.getuid?.() ?? 0): string {
  // Socket endpoints live here rather than under TMPDIR or a repository path: both have
  // unbounded length and macOS caps a unix-socket address at 104 bytes.
  return path.join("/tmp", `harness-anything-${uid}`);
}

export function defaultUnixSocketPath(daemonId: string, uid = process.getuid?.() ?? 0): string {
  // TMPDIR can exceed the Unix socket path limit and differ between clients and the daemon.
  return path.join(perUserSocketRoot(uid), `daemon-${uid}-${daemonId.replace(/[^A-Za-z0-9_.-]/gu, "-")}.sock`);
}

/** The daemon socket and the per-dispatch callback relays bind under the per-user socket root.
 * Its /tmp parent is sticky: any local user can pre-create the directory name before the real
 * owner does, so an existing directory is accepted only when it is a real directory owned by
 * this uid, and it is tightened to 0700 before any socket binds inside it. */
export function mkdirSecurely(target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  assertOwnedSocketDirectory(target);
  if (process.platform !== "win32") chmodSync(target, 0o700);
}

/** The connect-time twin of mkdirSecurely: a client refuses to open a socket whose parent
 * directory another local user could have planted, so the hello credential — which names this
 * user — never reaches an impostor socket. A missing directory stays silent: the connect itself
 * reports the native error callers already handle while the daemon is down. */
export function assertOwnedSocketDirectory(target: string): void {
  if (process.platform === "win32") return;
  const uid = process.getuid?.(),
    info = lstatSync(target, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
    throw new Error(`socket directory is unsafe: ${target} is not a directory owned by uid ${uid}`);
}

/** A relay is bound before dispatch: mkdirSecurely verifies its owner and sets 0700.
 * The daemon injects that exact endpoint into the worker, whose sandbox cannot read or
 * replace its parent. Reuse the bind-time check for this endpoint rather than requiring
 * filesystem access to /tmp just to connect. Ordinary clients still verify the owner. */
export function assertDaemonSocketDirectory(endpoint: string, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform === "win32" || !path.isAbsolute(endpoint)) return;
  if (env.HARNESS_DAEMON_RELAY === "1" && endpoint === resolveLocalDaemonEndpoint({ env })) return;
  assertOwnedSocketDirectory(path.dirname(endpoint));
}

/** Remote secrets use the existing user-managed loopback tunnel, never a bare remote TCP host. */
export function assertRuntimeCredentialEndpoint(endpoint: string): void {
  if (!endpoint.startsWith("tcp://")) return;
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, "");
  if (hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."))) return;
  throw Object.assign(
    new Error(
      "New API keys require a local socket or a protected loopback endpoint. Configure the existing SSH tunnel to the selected server socket first.",
    ),
    { code: "runtime_credential_transport_unsafe" },
  );
}

import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
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
} from "../protocol/daemon-protocol-identifiers.ts";

/** A sibling local socket; shares the existing owner-only directory and transport boundary. */
export function daemonDiagnosticsEndpoint(endpoint: string): string {
  return endpoint.endsWith(".sock") ? `${endpoint.slice(0, -5)}.diag` : `${endpoint}.diag`;
}

export interface LocalDaemonTarget {
  readonly repoId: WorkspaceId;
  readonly canonicalRoot: CanonicalRoot;
  readonly remoteEdge?: boolean;
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
  // A sealed runtime is handed its route by the daemon that dispatched it. The registry names the
  // same route, but it belongs to the host and is not readable from inside the sandbox, so a
  // relayed command locates its repo from the injection instead of reading it. The daemon still
  // authorizes the request against the dispatch execution scope; these fields only carry location.
  if (env.HARNESS_DAEMON_RELAY === "1") return resolveRelayedDaemonTarget(input, env, userRoot);
  return resolveLocalDaemonTargetFromRepos(input, await readRegisteredRepos(userRoot));
}

/** Route the dispatching daemon already bound for this dispatch. Every missing or out-of-scope
 * field is refused here as a route conflict: deriving a repository from the host registry, or
 * falling back to the implicit user socket, would answer a question this caller did not ask. */
function resolveRelayedDaemonTarget(
  input: LocalDaemonTargetInput,
  env: NodeJS.ProcessEnv,
  userRoot: string,
): LocalDaemonTarget {
  const daemonId = input.daemonId ?? daemonIdFromEnv(env),
    injectedRepoId = env.HARNESS_DAEMON_REPO_ID?.trim() || null,
    injectedRoot = env.HARNESS_CANONICAL_ROOT?.trim() || null,
    fail = (reason: string): Error =>
      Object.assign(new Error(`daemon_relay_route_required: ${reason}`), {
        code: "daemon_target_conflict",
        params: {
          route: "relay",
          reason,
          endpoint: env.HARNESS_DAEMON_ENDPOINT?.trim() || null,
          userRoot,
          daemonId,
          repoId: injectedRepoId,
          canonicalRoot: injectedRoot,
        },
      });
  if (!env.HARNESS_DAEMON_ENDPOINT?.trim()) throw fail("HARNESS_DAEMON_ENDPOINT is not set");
  if (!injectedRepoId) throw fail("HARNESS_DAEMON_REPO_ID is not set");
  if (input.repoIdOverride && input.repoIdOverride !== injectedRepoId)
    throw fail(
      `repoId ${JSON.stringify(input.repoIdOverride)} does not match the dispatched repo ` +
        JSON.stringify(injectedRepoId),
    );
  if (!injectedRoot) throw fail("HARNESS_CANONICAL_ROOT is not set");
  const canonicalRoot = bindRelayedRoot(injectedRoot, fail),
    selectedRoot = bindCanonicalRoot(input.rootDir);
  if (selectedRoot !== canonicalRoot && !selectedRoot.startsWith(`${canonicalRoot}${path.sep}`))
    throw fail(
      `selected root ${JSON.stringify(selectedRoot)} is outside the dispatched canonical root ` +
        JSON.stringify(canonicalRoot),
    );
  let socketPath: EndpointIdentity;
  try {
    socketPath = resolveLocalDaemonEndpoint({ userRoot, daemonId, env, repoId: injectedRepoId, canonicalRoot });
  } catch (error) {
    if (!isDaemonTargetConflict(error)) throw error;
    throw fail("HARNESS_DAEMON_ENDPOINT is not this dispatch's per-dispatch relay socket");
  }
  return {
    repoId: workspaceId(injectedRepoId),
    canonicalRoot,
    userRoot,
    daemonId,
    socketPath,
    ...(env.HARNESS_DAEMON_REMOTE_EDGE === "1" ? { remoteEdge: true } : {}),
  };
}

function isDaemonTargetConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "daemon_target_conflict"
  );
}

function bindRelayedRoot(value: string, fail: (reason: string) => Error): CanonicalRoot {
  try {
    return bindCanonicalRoot(value);
  } catch {
    throw fail(`HARNESS_CANONICAL_ROOT ${JSON.stringify(value)} is not a usable workspace root`);
  }
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
    remoteEdge: repo.mode === "remote-edge",
    userRoot,
    daemonId,
    socketPath,
  };
}
export const daemonRegistryUnreadableCode = "daemon_registry_unreadable";
function registryUnreadable(registryPath: string, error: unknown): Error {
  // A registry that cannot be opened, parsed or decoded is a local state failure, not an
  // unreachable daemon: callers must be able to tell the operator which one broke.
  return Object.assign(
    new Error(
      `daemon registry at ${registryPath} could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    ),
    { code: daemonRegistryUnreadableCode, cause: error },
  );
}
export async function readRegisteredRepos(
  userRoot: string,
): Promise<ReadonlyArray<DaemonRegistryRepo & { readonly canonicalRoot: string }>> {
  const registryPath = path.join(userRoot, "registry.json");
  // stat, not existsSync: a sandbox-denied directory reports EACCES here instead of a silent
  // "missing", so an unreadable host root is not mistaken for an unregistered workspace.
  let present: boolean;
  try {
    present = statSync(registryPath, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    throw registryUnreadable(registryPath, error);
  }
  if (!present) return [];
  const { readDaemonRegistry } = await import("@harness-anything/kernel/daemon-registry");
  try {
    return readDaemonRegistry({ userRoot }).repos.filter(
      (repo): repo is DaemonRegistryRepo & { readonly canonicalRoot: string } => repo.canonicalRoot !== null,
    );
  } catch (error) {
    throw registryUnreadable(registryPath, error);
  }
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
  /* @gate-identity non-state/environment-io.5ac349285e591d4c */ mkdirSync(target, { recursive: true, mode: 0o700 });
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

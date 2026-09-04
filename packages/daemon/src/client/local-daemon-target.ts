import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonRegistryRepo } from "../../../kernel/src/index.ts";
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
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly env?: NodeJS.ProcessEnv;
}
export function localUserDaemonEndpoint(
  userRoot = daemonUserRoot(),
  daemonId = daemonIdFromEnv(),
  platform: NodeJS.Platform = process.platform,
): EndpointIdentity {
  const id = `u-${localDaemonTargetHash(`${path.resolve(userRoot)}\0${daemonId}`)}`;
  return endpointIdentity(
    platform === "win32" ? `\\\\.\\pipe\\harness-anything-${safeDaemonId(id)}` : unixEndpoint(id),
  );
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
  if (!injected) return expected;
  const endpoint = endpointIdentity(injected);
  // An enforced runtime changes TMPDIR, so a matching POSIX socket may live in a different
  // directory. Its basename still carries the hash of the sealed (userRoot, daemonId) pair.
  if (process.platform !== "win32" ? path.basename(endpoint) === path.basename(expected) : endpoint === expected)
    return endpoint;
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
  const userRoot = path.resolve(input.userRoot ?? daemonUserRoot(input.env ?? process.env));
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
  const repo = requested
    ? registeredRepos.find((candidate) => candidate.repoId === requested && candidate.state === "enabled")
    : registeredRepos
        .filter(
          (candidate) =>
            candidate.canonicalRoot === rootDir || rootDir.startsWith(`${candidate.canonicalRoot}${path.sep}`),
        )
        .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
  if (!repo || repo.state !== "enabled")
    throw Object.assign(
      new Error(
        repo
          ? `workspace is blocked by disabled repoId ${JSON.stringify(repo.repoId)} at ` +
            `${JSON.stringify(repo.canonicalRoot)}; run ha daemon repo unregister --repo-id ${repo.repoId} ` +
            "twice to remove it"
          : `workspace is not registered; run ha daemon repo register --repo-id <id> --root ${JSON.stringify(path.resolve(input.rootDir))}`,
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
  const { readDaemonRegistry } = await import("../../../kernel/src/index.ts");
  return readDaemonRegistry({ userRoot }).repos.filter(
    (repo): repo is DaemonRegistryRepo & { readonly canonicalRoot: string } => repo.canonicalRoot !== null,
  );
}
function localDaemonTargetHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function safeDaemonId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
function unixEndpoint(id: string): string {
  return path.join(os.tmpdir(), "harness-anything", `daemon-${process.getuid?.() ?? 0}-${safeDaemonId(id)}.sock`);
}

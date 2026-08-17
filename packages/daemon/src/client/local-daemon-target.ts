import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRoot as bindCanonicalRoot, endpointIdentity, workspaceId, type CanonicalRoot, type EndpointIdentity, type WorkspaceId } from "../protocol/daemon-protocol.contract.ts";

export interface LocalDaemonTarget {
  readonly repoId: WorkspaceId;
  readonly canonicalRoot: CanonicalRoot;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly socketPath: EndpointIdentity;
}
export function localUserDaemonEndpoint(userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv(), platform: NodeJS.Platform = process.platform): EndpointIdentity {
  const id = `u-${localDaemonTargetHash(`${path.resolve(userRoot)}\0${daemonId}`)}`;
  return endpointIdentity(platform === "win32" ? `\\\\.\\pipe\\harness-anything-${safeDaemonId(id)}` : unixEndpoint(id));
}
export function daemonUserRoot(env: NodeJS.ProcessEnv = process.env): string { return path.resolve(env.HARNESS_DAEMON_USER_ROOT || path.join(os.homedir(), ".harness")); }
export function daemonIdFromEnv(env: NodeJS.ProcessEnv = process.env): string { return env.HARNESS_DAEMON_ID || "default"; }
export function resolveLocalDaemonTarget(input: { readonly rootDir: string; readonly repoIdOverride?: string; readonly userRoot?: string;
  readonly daemonId?: string; readonly env?: NodeJS.ProcessEnv }): LocalDaemonTarget {
  const env = input.env ?? process.env, userRoot = path.resolve(input.userRoot ?? daemonUserRoot(env));
  const daemonId = input.daemonId ?? daemonIdFromEnv(env), repos = readRegisteredRepos(userRoot);
  const requested = input.repoIdOverride ?? env.HARNESS_DAEMON_REPO_ID;
  const rootDir = bindCanonicalRoot(input.rootDir);
  const repo = requested ? repos.find((candidate) => candidate.repoId === requested && candidate.state === "enabled")
    : repos.filter((candidate) => candidate.canonicalRoot === rootDir || rootDir.startsWith(`${candidate.canonicalRoot}${path.sep}`))
      .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
  if (!repo || repo.state !== "enabled") throw new Error(`workspace is not registered; run ha daemon repo register --repo-id <id> --root ${JSON.stringify(path.resolve(input.rootDir))}`);
  return { repoId: workspaceId(repo.repoId), canonicalRoot: bindCanonicalRoot(repo.canonicalRoot), userRoot, daemonId, socketPath: localUserDaemonEndpoint(userRoot, daemonId) };
}
function readRegisteredRepos(userRoot: string): readonly { readonly repoId: string; readonly canonicalRoot: string; readonly state: string }[] {
  const registryPath = path.join(userRoot, "registry.json");
  if (!existsSync(registryPath)) return [];
  const value: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!daemonRegistryRecord(value) || value.schema !== "harness-daemon-registry/v1" || !Array.isArray(value.repos)) throw new Error(`invalid daemon registry at ${registryPath}`);
  return value.repos.filter((repo): repo is { repoId: string; canonicalRoot: string; state: string } => daemonRegistryRecord(repo)
    && typeof repo.repoId === "string" && typeof repo.canonicalRoot === "string" && typeof repo.state === "string");
}
function daemonRegistryRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function localDaemonTargetHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function safeDaemonId(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/gu, "-"); }
function unixEndpoint(id: string): string { return path.join(os.tmpdir(), "harness-anything", `daemon-${process.getuid?.() ?? 0}-${safeDaemonId(id)}.sock`); }

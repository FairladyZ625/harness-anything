import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EndpointIdentity } from "./protocol/daemon-protocol-identifiers.ts";

// The largest payload this transport carries in one frame is the entity content read's 2 MiB UTF-8 ceiling.
export const JSON_LINE_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export function daemonDiagnosticsEndpoint(endpoint: string): string {
  return endpoint.endsWith(".sock") ? `${endpoint.slice(0, -5)}.diag` : `${endpoint}.diag`;
}

export function daemonUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.HARNESS_DAEMON_USER_ROOT || path.join(os.homedir(), ".harness"));
}

export function daemonIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_DAEMON_ID || "default";
}

function localDaemonTargetHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function localDaemonTargetKey(userRoot: string, daemonId: string): string {
  return `u-${localDaemonTargetHash(`${path.resolve(userRoot)}\0${daemonId}`)}`;
}

export function perUserSocketRoot(uid = process.getuid?.() ?? 0): string {
  return path.join("/tmp", `harness-anything-${uid}`);
}

export function defaultUnixSocketPath(daemonId: string, uid = process.getuid?.() ?? 0): string {
  return path.join(perUserSocketRoot(uid), `daemon-${uid}-${daemonId.replace(/[^A-Za-z0-9_.-]/gu, "-")}.sock`);
}

export function localUserDaemonEndpoint(
  userRoot = daemonUserRoot(),
  daemonId = daemonIdFromEnv(),
  platform: NodeJS.Platform = process.platform,
): EndpointIdentity {
  const id = localDaemonTargetKey(userRoot, daemonId),
    raw = platform === "win32" ? `\\\\.\\pipe\\harness-anything-${id}` : defaultUnixSocketPath(id);
  if (!raw.trim()) throw new Error("Endpoint identity is required.");
  return raw as EndpointIdentity;
}

export function mkdirSecurely(target: string): void {
  /* @gate-identity non-state/environment-io.5ac349285e591d4c */ mkdirSync(target, { recursive: true, mode: 0o700 });
  assertOwnedSocketDirectory(target);
  if (process.platform !== "win32") chmodSync(target, 0o700);
}

export function assertOwnedSocketDirectory(target: string): void {
  if (process.platform === "win32") return;
  const uid = process.getuid?.(),
    info = lstatSync(target, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
    throw new Error(`socket directory is unsafe: ${target} is not a directory owned by uid ${uid}`);
}

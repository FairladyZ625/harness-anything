import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AuthorizationPolicyGroup, type AuthorizationGrant } from "@harness-anything/kernel";

export interface BuiltinUser {
  readonly userId: string;
  readonly personId: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly roles: readonly string[];
}
export interface BuiltinSessionRecord {
  readonly tokenHash: string;
  readonly personId: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly sessionExpiresAt: number | null;
  readonly roles: readonly string[];
}
export interface BuiltinState {
  readonly schema: "harness-builtin-identity/v1";
  readonly centerTokenHashes: readonly string[];
  readonly users: readonly BuiltinUser[];
  readonly groups: readonly AuthorizationPolicyGroup[];
  readonly grants: readonly AuthorizationGrant[];
  readonly sessions: readonly BuiltinSessionRecord[];
  readonly repositoryOwners: Readonly<Record<string, string>>;
  readonly sessionLifetimeSeconds: number;
}
export interface BuiltinConfig {
  readonly schema: "harness-builtin-rbac/v1";
  readonly mode: "builtin";
  readonly url: string;
  readonly realm: "local";
  readonly clientId: "harness-center";
}

export const builtinSessionLifetimeBounds = Object.freeze({
  defaultSeconds: 21_600,
  minimumSeconds: 300,
  maximumSeconds: 2_592_000,
});
export const builtinConfig = (userRoot: string): BuiltinConfig => ({
  schema: "harness-builtin-rbac/v1",
  mode: "builtin",
  url: builtinAuthorityUrl(userRoot),
  realm: "local",
  clientId: "harness-center",
});
export function builtinAuthorityUrl(userRoot: string): string {
  return `builtin://local/${Buffer.from(path.resolve(userRoot), "utf8").toString("base64url")}`;
}
export function userRootFromBuiltinUrl(url: string): string | undefined {
  if (!url.startsWith("builtin://local/")) return undefined;
  const encodedUrl = url.slice("builtin://local/".length);
  if (!encodedUrl || !/^[A-Za-z0-9_-]+$/u.test(encodedUrl)) return undefined;
  const encoded = encodedUrl.replace(/-/gu, "+").replace(/_/gu, "/"),
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!decoded || !path.isAbsolute(decoded) || Buffer.from(decoded, "utf8").toString("base64url") !== encodedUrl)
    return undefined;
  return decoded;
}
export function stateFile(userRoot: string): string {
  return path.join(userRoot, "rbac", "builtin-state.json");
}
export function sessionFile(userRoot: string): string {
  return path.join(userRoot, "rbac", "builtin-session.json");
}
export function defaultState(): BuiltinState {
  return {
    schema: "harness-builtin-identity/v1",
    centerTokenHashes: [],
    users: [],
    groups: [],
    grants: [],
    sessions: [],
    repositoryOwners: {},
    sessionLifetimeSeconds: builtinSessionLifetimeBounds.defaultSeconds,
  };
}
export function readState(userRoot: string): BuiltinState {
  const file = stateFile(userRoot);
  if (!existsSync(file)) return defaultState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as BuiltinState & {
    readonly users?: readonly (BuiltinUser & { readonly teamIds?: readonly string[] })[];
  };
  if (parsed.schema !== "harness-builtin-identity/v1") return defaultState();
  const {
    teams: _teams,
    nodes: _nodes,
    users = [],
    ...state
  } = parsed as BuiltinState & {
    readonly teams?: unknown;
    readonly nodes?: unknown;
  };
  return {
    ...state,
    users: users.map((candidate) => {
      const { teamIds: _teamIds, ...user } = candidate as BuiltinUser & { readonly teamIds?: readonly string[] };
      return user;
    }),
  };
}
export function writeState(userRoot: string, state: BuiltinState): void {
  const root = path.join(userRoot, "rbac"),
    file = stateFile(userRoot),
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}
export function ensureBuiltinConfig(userRoot: string): BuiltinConfig {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "config.json"),
    config = builtinConfig(userRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  if (!existsSync(stateFile(userRoot))) writeState(userRoot, defaultState());
  return config;
}
export function hashSecret(
  value: string,
  salt = randomBytes(16).toString("hex"),
): { readonly salt: string; readonly hash: string } {
  return { salt, hash: scryptSync(value, salt, 32).toString("hex") };
}
export function verifySecret(value: string, salt: string, expected: string): boolean {
  try {
    const actual = scryptSync(value, salt, 32),
      wanted = Buffer.from(expected, "hex");
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}
export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function opaqueToken(prefix: string): string {
  return `${prefix}.${randomBytes(32).toString("base64url")}`;
}
export function findSession(state: BuiltinState, token: string): BuiltinSessionRecord | undefined {
  const hash = hashToken(token),
    found = state.sessions.find((session) => session.tokenHash === hash);
  return found &&
    found.expiresAt > Date.now() &&
    (found.sessionExpiresAt === null || found.sessionExpiresAt > Date.now())
    ? found
    : undefined;
}

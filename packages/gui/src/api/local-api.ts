import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const localApiBindHost = "127.0.0.1";
export const localApiMaxBodyBytes = 256 * 1024;

export interface LocalApiSession {
  readonly bindHost: "127.0.0.1";
  readonly sessionToken: string;
  readonly corsAllowedOrigins: readonly [];
  readonly maxBodyBytes: number;
}

export interface LocalApiRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bodyBytes: number;
}

export interface ProjectPathDecision {
  readonly ok: boolean;
  readonly normalizedPath: string;
  readonly reason?: "path_outside_project" | "path_is_private" | "body_too_large";
}

export function createLocalApiSession(): LocalApiSession {
  return {
    bindHost: localApiBindHost,
    sessionToken: randomBytes(32).toString("base64url"),
    corsAllowedOrigins: [],
    maxBodyBytes: localApiMaxBodyBytes
  };
}

export function authorizeLocalApiRequest(session: LocalApiSession, request: LocalApiRequest): boolean {
  if (request.bodyBytes > session.maxBodyBytes) return false;
  return request.headers.authorization === `Bearer ${session.sessionToken}`;
}

export function validateProjectPath(projectRoot: string, candidatePath: string): ProjectPathDecision {
  const root = normalizeExistingPath(projectRoot);
  const candidate = normalizePossiblyMissingPath(root, candidatePath);
  if (!isInside(root, candidate)) {
    return { ok: false, normalizedPath: candidate, reason: "path_outside_project" };
  }
  if (isPrivateHarnessPath(root, candidate)) {
    return { ok: false, normalizedPath: candidate, reason: "path_is_private" };
  }
  return { ok: true, normalizedPath: candidate };
}

export function isPrivateHarnessPath(projectRoot: string, candidatePath: string): boolean {
  const root = normalizeExistingPath(projectRoot);
  const relativePath = path.relative(root, candidatePath).split(path.sep).join("/");
  return relativePath === ".harness-private" || relativePath.startsWith(".harness-private/");
}

function normalizeExistingPath(inputPath: string): string {
  return realpathSync(path.resolve(inputPath));
}

function normalizePossiblyMissingPath(root: string, inputPath: string): string {
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) return realpathSync(resolved);
    return realpathSync(resolved);
  }

  const missingSegments: string[] = [];
  let nearestExistingParent = resolved;
  while (!existsSync(nearestExistingParent)) {
    const nextParent = path.dirname(nearestExistingParent);
    if (nextParent === nearestExistingParent) break;
    missingSegments.unshift(path.basename(nearestExistingParent));
    nearestExistingParent = nextParent;
  }

  const realParent = realpathSync(nearestExistingParent);
  return path.resolve(realParent, ...missingSegments);
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

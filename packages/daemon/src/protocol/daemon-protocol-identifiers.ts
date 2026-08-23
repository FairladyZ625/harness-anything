import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DaemonProtocolContractError } from "./json-rpc-types.ts";

declare const safePathBrand: unique symbol,
  canonicalRootBrand: unique symbol,
  endpointIdentityBrand: unique symbol,
  workspaceIdBrand: unique symbol;

export type SafePath = string & { readonly [safePathBrand]: true };

export type CanonicalRoot = SafePath & { readonly [canonicalRootBrand]: true };

export type EndpointIdentity = string & {
  readonly [endpointIdentityBrand]: true;
};

export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };

export interface DaemonSessionEnvironment extends Readonly<Record<string, string | undefined>> {
  readonly CLAUDE_CODE_SESSION_ID?: string;
  readonly CODEX_THREAD_ID?: string;
  readonly CODEX_SESSION_ID?: string;
}

export function safePath(value: string): SafePath {
  return path.resolve(value) as SafePath;
}

export function canonicalRoot(value: string, allowMissing = false): CanonicalRoot {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) return realpathSync.native(resolved) as CanonicalRoot;
  const parent = path.dirname(resolved);
  if (!allowMissing || !existsSync(parent))
    throw new DaemonProtocolContractError("invalid_root", `Canonical root does not exist: ${resolved}`);
  return path.join(realpathSync.native(parent), path.basename(resolved)) as CanonicalRoot;
}

export function endpointIdentity(value: string): EndpointIdentity {
  if (!value.trim()) throw new DaemonProtocolContractError("invalid_endpoint", "Endpoint identity is required.");
  return value as EndpointIdentity;
}

export function workspaceId(value: string): WorkspaceId {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(value))
    throw new DaemonProtocolContractError("invalid_workspace", "Workspace id is invalid.");
  return value as WorkspaceId;
}

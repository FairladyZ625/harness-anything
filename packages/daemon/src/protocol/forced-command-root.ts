import { realpathSync } from "node:fs";
import path from "node:path";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt } from "./receipt-envelope.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

interface RepoNamespace {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export function commandRootMismatch(
  payload: JsonObject | undefined,
  repo: RepoNamespace,
  authContext: DaemonAuthenticationContext | undefined
): ReturnType<typeof failureReceipt> | undefined {
  const command = isJsonObject(payload?.command) ? payload.command : undefined;
  const rootDir = typeof command?.rootDir === "string" ? command.rootDir : undefined;
  if (!rootDir || sameRoot(rootDir, repo.canonicalRoot)) return undefined;
  const forcedRoot = authContext?.sshForcedCommand?.canonicalRoot;
  return failureReceipt("repo.command.run", forcedRoot ? "forced_command_root_mismatch" : "repo_command_root_mismatch", forcedRoot
    ? "Client --root is invalid because it does not match the canonical root pinned by the SSH forced command. Reconnect with `ha --root <canonical-root> daemon connect --stdio`."
    : "payload.command.rootDir is invalid because it does not match params.repo.repoId. Retry the CLI command with `ha --root <registered-root> <command>`.", {
    repo: { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot },
    command: { rootDir },
    ...(forcedRoot ? { forcedCommand: { canonicalRoot: forcedRoot } } : {})
  });
}

export function validateForcedCommandRoot(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  repo: RepoNamespace | undefined,
  authContext: DaemonAuthenticationContext | undefined
): ReturnType<typeof failureReceipt> | undefined {
  const forcedRoot = authContext?.sshForcedCommand?.canonicalRoot;
  if (!contract.requiresRepo || !repo || !forcedRoot) return undefined;
  const requestedRoot = isJsonObject(params.repo) && typeof params.repo.canonicalRoot === "string"
    ? params.repo.canonicalRoot
    : undefined;
  if (!requestedRoot) {
    return failureReceipt(contract.method, "forced_command_root_required", "SSH forced-command requests require the server root configured by authorized_keys, but params.repo.canonicalRoot is missing. Reconnect with `ha --root <canonical-root> daemon connect --stdio`.", {
      forcedCommand: { canonicalRoot: forcedRoot }
    });
  }
  if (!sameRoot(requestedRoot, forcedRoot)) {
    return failureReceipt(contract.method, "forced_command_root_mismatch", "Client --root is invalid because it does not match the canonical root pinned by the SSH forced command. Reconnect with `ha --root <canonical-root> daemon connect --stdio`.", {
      requested: { canonicalRoot: requestedRoot },
      forcedCommand: { canonicalRoot: forcedRoot }
    });
  }
  if (sameRoot(forcedRoot, repo.canonicalRoot)) return undefined;
  return failureReceipt(contract.method, "forced_command_root_mismatch", "The requested repo is invalid because it does not match the canonical root pinned by the SSH forced command. Register that root with `ha daemon repo register --root <canonical-root>` before reconnecting.", {
    repo: { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot },
    forcedCommand: { canonicalRoot: forcedRoot }
  });
}

function sameRoot(left: string, right: string): boolean {
  return realpathOrResolve(left) === realpathOrResolve(right);
}

function realpathOrResolve(rootDir: string): string {
  try {
    return realpathSync.native(rootDir);
  } catch {
    return path.resolve(rootDir);
  }
}

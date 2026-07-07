import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import type { LockLease, LockRegistry, LockRegistryError, LockRequest } from "../ports/lock-registry.ts";

export function makeLocalLockRegistry(rootInput: HarnessLayoutInput): LockRegistry {
  return {
    acquire: (request) => Effect.try({
      try: () => acquireLocalLock(rootInput, request),
      catch: (cause): LockRegistryError => ({
        _tag: "LockRegistryError",
        kind: request.kind,
        key: request.key,
        cause
      })
    })
  };
}

function acquireLocalLock(rootInput: HarnessLayoutInput, request: LockRequest): LockLease {
  const lockPath = externalAdoptClaimPath(rootInput, request);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  mkdirSync(lockPath, { recursive: false });
  return {
    release: () => Effect.try({
      try: () => {
        rmSync(lockPath, { recursive: true, force: true });
      },
      catch: (cause): LockRegistryError => ({
        _tag: "LockRegistryError",
        kind: request.kind,
        key: request.key,
        cause
      })
    })
  };
}

function externalAdoptClaimPath(rootInput: HarnessLayoutInput, request: LockRequest): string {
  return path.join(resolveHarnessLayout(rootInput).claimsRoot, request.namespace, stablePayloadHash(request.key));
}

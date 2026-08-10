import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

export function canonicalProductionAuthorityRoot(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

export function authorityManifestSourceDigest(manifestPath: string): string {
  return createHash("sha256")
    .update("ha/authority-production-manifest-source/v1\0", "utf8")
    .update(readFileSync(manifestPath))
    .digest("hex");
}

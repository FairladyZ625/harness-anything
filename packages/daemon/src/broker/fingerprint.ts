import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { ManagedFingerprint } from "./types.ts";
import { isMissing } from "./errno.ts";

const tombstoneDigest = sha256(new Uint8Array());

export function fingerprintBytes(bytes: Uint8Array, logicalMode = 0o644): ManagedFingerprint {
  return {
    objectKind: "file",
    logicalMode: logicalMode & 0o777,
    byteSize: bytes.byteLength,
    blobDigest: sha256(bytes)
  };
}

export function tombstoneFingerprint(): ManagedFingerprint {
  return { objectKind: "tombstone", logicalMode: 0, byteSize: 0, blobDigest: tombstoneDigest };
}

export async function fingerprintPath(filePath: string): Promise<ManagedFingerprint> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`managed path is not a regular file: ${filePath}`);
    return fingerprintBytes(await readFile(filePath), stat.mode);
  } catch (error) {
    if (isMissing(error)) return tombstoneFingerprint();
    throw error;
  }
}

export function sameFingerprint(left: ManagedFingerprint, right: ManagedFingerprint): boolean {
  return left.objectKind === right.objectKind
    && left.logicalMode === right.logicalMode
    && left.byteSize === right.byteSize
    && left.blobDigest === right.blobDigest;
}

export function fingerprintDigest(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}


import path from "node:path";
import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { localContentObjectFileSystem } from "../local/local-layout-file-system.ts";
import { TaskEventStoreError, type CanonicalContentBlob } from "./task-event-store-types.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";

export function prepareContentObjects(
  objectRoot: string,
  events: readonly CanonicalEventV1[],
  blobs: readonly CanonicalContentBlob[],
): void {
  const supplied = new Map(blobs.map((blob) => [blob.sha256, blob])),
    pending = new Map<string, Uint8Array>();
  for (const event of events)
    for (const claim of contentClaims(event)) {
      const target = objectPath(objectRoot, claim.sha256);
      if (localContentObjectFileSystem.exists(target)) continue;
      const blob = supplied.get(claim.sha256),
        bytes = blob === undefined ? null : typeof blob.body === "string" ? Buffer.from(blob.body) : blob.body;
      if (!blob || !bytes || blob.size !== claim.size || bytes.byteLength !== claim.size)
        throw new TaskEventStoreError("invalid_write_plan", `event content object ${claim.sha256} is missing`);
      pending.set(target, bytes);
    }
  const entries = [...pending].map(([target, body]) => ({ path: target, body }));
  for (let offset = 0; offset < entries.length; offset += 128)
    localContentObjectFileSystem.replaceMany(entries.slice(offset, offset + 128));
}

export function objectPath(objectRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("content object hash is invalid");
  return path.join(objectRoot, sha256.slice(0, 2), sha256.slice(2));
}

export function readContentObject(objectRoot: string, sha256: string): Uint8Array | null {
  const target = objectPath(objectRoot, sha256);
  return localContentObjectFileSystem.exists(target) ? localContentObjectFileSystem.readBytes(target) : null;
}

export function listContentObjectDigests(objectRoot: string): readonly string[] {
  if (!localContentObjectFileSystem.exists(objectRoot)) return [];
  return localContentObjectFileSystem
    .readNames(objectRoot)
    .filter((prefix) => /^[0-9a-f]{2}$/u.test(prefix))
    .flatMap((prefix) =>
      localContentObjectFileSystem
        .readNames(path.join(objectRoot, prefix))
        .filter((name) => /^[0-9a-f]{62}$/u.test(name))
        .map((name) => `${prefix}${name}`),
    )
    .sort();
}

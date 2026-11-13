import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ContentBinding, ContentIdentity, ContentProgress, ContentSink } from "./fleet/transport-contract.ts";
import type { FleetDescriptor } from "./fleet/command-protocol.ts";

export interface FleetDocContentMetadata {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** Immutable document revision; repository source watermarks are not content identity. */
  readonly workspaceRevision: number;
  readonly encoding: "utf8" | "base64";
}

const metadataSuffix = ".json",
  partSuffix = ".part",
  sealedSuffix = ".sealed";

function transferRoot(rootDir: string): string {
  const root = path.resolve(rootDir);
  /* @gate-identity state-store/document.fleet-edge-content */ mkdirSync(root, { recursive: true });
  return root;
}

function paths(
  rootDir: string,
  key: string,
): { readonly metadata: string; readonly part: string; readonly sealed: string } {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(key)) throw new Error("Fleet content transfer key is invalid");
  const root = transferRoot(rootDir),
    base = path.join(root, key);
  return { metadata: `${base}${metadataSuffix}`, part: `${base}${partSuffix}`, sealed: `${base}${sealedSuffix}` };
}

export function readFleetDocContentMetadata(rootDir: string, key: string): FleetDocContentMetadata | null {
  const target = paths(rootDir, key);
  if (!existsSync(target.metadata)) return null;
  const value = JSON.parse(readFileSync(target.metadata, "utf8")) as Partial<FleetDocContentMetadata>;
  if (
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.workspaceRevision !== "number" ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    value.workspaceRevision < 1 ||
    (value.encoding !== "utf8" && value.encoding !== "base64")
  )
    throw new Error("Fleet content transfer metadata is malformed");
  return value as FleetDocContentMetadata;
}

function writeMetadata(target: string, value: FleetDocContentMetadata): void {
  const temporary = `${target}.${process.pid}.tmp`;
  /* @gate-identity state-store/document.fleet-edge-content */ writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  /* @gate-identity state-store/document.fleet-edge-content */ renameSync(temporary, target);
}

function fileSize(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

function error(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function digestFile(file: string, expectedSize: number): string {
  const fd = /* @gate-identity state-store/document.fleet-edge-content */ openSync(file, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    /* @gate-identity state-store/document.fleet-edge-content */ closeSync(fd);
  }
  if (offset !== expectedSize) throw error("content_claim_mismatch", "Sealed Fleet content has the wrong size");
  return hash.digest("hex");
}

export interface FleetDocContentSink {
  readonly metadata: FleetDocContentMetadata;
  readonly sink: ContentSink;
  readonly sealedPath: string;
  readonly openSealed: () => ReturnType<typeof createReadStream>;
  readonly cleanup: () => void;
}

export function openFleetDocContentSink(options: {
  readonly rootDir: string;
  readonly key: string;
  readonly metadata: FleetDocContentMetadata;
  readonly nodeId: string;
  readonly repoId: string;
  readonly opId: string;
}): FleetDocContentSink {
  const target = paths(options.rootDir, options.key),
    existing = readFleetDocContentMetadata(options.rootDir, options.key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(options.metadata))
    throw error("content_changed", "Fleet content transfer identity changed during resume");
  if (!existing) writeMetadata(target.metadata, options.metadata);
  const identity: ContentIdentity = {
      sha256: options.metadata.sha256,
      size: options.metadata.size,
      mediaType: options.metadata.encoding === "base64" ? "application/octet-stream" : "text/plain",
      purpose: options.metadata.encoding === "base64" ? "artifact" : "document",
    },
    binding: ContentBinding = {
      transferId: options.key,
      nodeId: options.nodeId,
      repoId: options.repoId,
      opId: options.opId,
      direction: "center-to-edge",
      content: identity,
    };
  let sealed = existsSync(target.sealed);
  const status = async (): Promise<ContentProgress> => {
    const file = sealed ? target.sealed : target.part;
    return { receivedOffset: fileSize(file), durableOffset: fileSize(file), sealed };
  };
  const sink: ContentSink = {
    binding,
    status,
    write: async (offset, bytes) => {
      const current = fileSize(target.part);
      if (offset > current)
        throw error("upload_gap", `Fleet content gap at offset ${offset}; durable offset is ${current}`);
      if (offset < current) {
        const overlap = Math.min(bytes.byteLength, current - offset),
          fd = /* @gate-identity state-store/document.fleet-edge-content */ openSync(target.part, "r"),
          existingBytes = Buffer.allocUnsafe(overlap);
        try {
          readSync(fd, existingBytes, 0, overlap, offset);
        } finally {
          /* @gate-identity state-store/document.fleet-edge-content */ closeSync(fd);
        }
        if (!existingBytes.equals(Buffer.from(bytes).subarray(0, overlap)))
          throw error("upload_replay_mismatch", `Fleet content replay differs at offset ${offset}`);
        if (overlap === bytes.byteLength) return status();
        bytes = bytes.subarray(overlap);
      }
      const fd = /* @gate-identity state-store/document.fleet-edge-content */ openSync(target.part, "a");
      try {
        /* @gate-identity state-store/document.fleet-edge-content */ writeFileSync(fd, bytes);
      } finally {
        /* @gate-identity state-store/document.fleet-edge-content */ closeSync(fd);
      }
      return status();
    },
    flush: async () => {
      const fd = /* @gate-identity state-store/document.fleet-edge-content */ openSync(target.part, "r+");
      try {
        /* @gate-identity state-store/document.fleet-edge-content */ fsyncSync(fd);
      } finally {
        /* @gate-identity state-store/document.fleet-edge-content */ closeSync(fd);
      }
      return fileSize(target.part);
    },
    seal: async (): Promise<FleetDescriptor> => {
      if (sealed) return { ref: target.sealed, ...identity };
      await sink.flush(new AbortController().signal);
      if (fileSize(target.part) !== identity.size || digestFile(target.part, identity.size) !== identity.sha256)
        throw error("content_claim_mismatch", "Fleet content does not match its accepted identity");
      /* @gate-identity state-store/document.fleet-edge-content */ renameSync(target.part, target.sealed);
      sealed = true;
      return { ref: target.sealed, ...identity };
    },
    abort: async () => {
      for (const file of [target.part, target.sealed, target.metadata])
        if (existsSync(file)) /* @gate-identity state-store/document.fleet-edge-content */ unlinkSync(file);
      sealed = false;
    },
  };
  return {
    metadata: options.metadata,
    sink,
    sealedPath: target.sealed,
    openSealed: () => {
      if (!sealed || !existsSync(target.sealed)) throw error("content_claim_mismatch", "Fleet content is not sealed");
      return createReadStream(target.sealed, { highWaterMark: 64 * 1024 });
    },
    cleanup: () => {
      for (const file of [target.part, target.sealed, target.metadata])
        if (existsSync(file)) /* @gate-identity state-store/document.fleet-edge-content */ unlinkSync(file);
    },
  };
}

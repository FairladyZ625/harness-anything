import { createHash } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import * as tar from "tar";
import { BASE_BACKUP_ARCHIVE_ROOT } from "@harness-anything/storage";

export interface StreamingZstdUnpackInput {
  readonly stagingDir: string;
  readonly quotaBytes: number;
  readonly expectedSize: number;
  readonly expectedSha256: string;
}

export interface StreamingZstdUnpackResult {
  readonly receivedBytes: number;
  readonly sha256: string;
  readonly expandedBytes: number;
}

export interface StreamingZstdUnpacker {
  readonly pushChunk: (chunk: Buffer) => Promise<void>;
  readonly finish: () => Promise<StreamingZstdUnpackResult>;
  readonly abort: (reason?: unknown) => Promise<void>;
}

/**
 * Streams a `fleet-basebackup/v4` zstd tar archive directly from network chunks into `stagingDir`:
 * `wire -> Tee(sha256 + byteCount) -> ZstdDecompress -> tar.Unpack`, avoiding any intermediate
 * `archive.part` file write and eliminating receiver-side 2x disk write amplification.
 */
export function createStreamingZstdUnpacker(input: StreamingZstdUnpackInput): StreamingZstdUnpacker {
  const digest = createHash("sha256");
  let receivedBytes = 0;
  let expandedBytes = 0;
  let pipelineError: unknown = null;
  let finished = false;
  let ended = false;

  // Bounded 1-chunk handoff queue providing natural backpressure from tar.Unpack back to pushChunk().
  let pendingChunk: { readonly chunk: Buffer; readonly ack: () => void } | null = null;
  let consumerWaiter: (() => void) | null = null;

  async function* chunkSource(): AsyncGenerator<Buffer> {
    for (;;) {
      if (pipelineError !== null) throw pipelineError;
      if (pendingChunk !== null) {
        const next = pendingChunk;
        pendingChunk = null;
        next.ack();
        yield next.chunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        consumerWaiter = resolve;
      });
    }
  }

  const wakeConsumer = (): void => {
    const waiter = consumerWaiter;
    consumerWaiter = null;
    waiter?.();
  };

  const hashTee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > input.expectedSize) {
        callback(new Error("base backup stream exceeds declared byte size"));
        return;
      }
      Reflect.apply(digest.update, digest, [chunk]);
      callback(null, chunk);
    },
  });

  const zstd = createZstdDecompress();
  const unpack = new tar.Unpack({
    cwd: input.stagingDir,
    strict: true,
    preservePaths: false,
    filter: (name, entry) => {
      const segments = name.split("/");
      if (
        name.startsWith("/") ||
        name.includes("\\") ||
        segments.includes("..") ||
        !("type" in entry) ||
        !["File", "Directory"].includes(entry.type)
      ) {
        unpack.abort(new Error("invalid base backup archive member"));
        return false;
      }
      if (
        name !== "backup.json" &&
        name !== BASE_BACKUP_ARCHIVE_ROOT &&
        !name.startsWith(`${BASE_BACKUP_ARCHIVE_ROOT}/`)
      ) {
        unpack.abort(new Error("unexpected base backup archive member"));
        return false;
      }
      expandedBytes += entry.size;
      if (expandedBytes > input.quotaBytes) {
        unpack.abort(new Error("base backup exceeds disk quota"));
        return false;
      }
      return true;
    },
  });

  const sourceStream = Readable.from(chunkSource(), { highWaterMark: 2 });
  const pipelinePromise = pipeline(sourceStream, hashTee, zstd, unpack).catch((error: unknown) => {
    pipelineError = error;
    const pending = pendingChunk;
    pendingChunk = null;
    pending?.ack();
    wakeConsumer();
    throw error;
  });
  // Prevent unhandled rejection if caller aborts or errors before awaiting finish().
  pipelinePromise.catch(() => undefined);

  return {
    async pushChunk(chunk: Buffer): Promise<void> {
      if (pipelineError !== null) throw pipelineError;
      if (chunk.byteLength === 0) return;
      await new Promise<void>((resolve) => {
        pendingChunk = { chunk, ack: resolve };
        wakeConsumer();
      });
      if (pipelineError !== null) throw pipelineError;
    },

    async finish(): Promise<StreamingZstdUnpackResult> {
      if (finished) throw new Error("streaming zstd unpacker already finished");
      finished = true;
      ended = true;
      wakeConsumer();
      await pipelinePromise;
      const computedSha256 = digest.digest("hex");
      if (receivedBytes !== input.expectedSize || computedSha256 !== input.expectedSha256) {
        throw new Error(
          `base backup archive is incomplete or corrupt (received=${receivedBytes}, expected=${input.expectedSize})`,
        );
      }
      return {
        receivedBytes,
        sha256: computedSha256,
        expandedBytes,
      };
    },

    async abort(reason?: unknown): Promise<void> {
      if (finished) return;
      finished = true;
      ended = true;
      const err = reason instanceof Error ? reason : new Error(String(reason ?? "stream unpack aborted"));
      pipelineError ??= err;
      const pending = pendingChunk;
      pendingChunk = null;
      pending?.ack();
      wakeConsumer();
      sourceStream.destroy(err);
      zstd.destroy(err);
      unpack.abort(err);
      await pipelinePromise.catch(() => undefined);
    },
  };
}

export function v4DirectStagingDirectory(baseDir: string, sha256: string): string {
  return path.join(baseDir, `${sha256}.staging`);
}

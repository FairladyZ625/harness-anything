import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { consumeKnownError } from "../../kernel/src/index.ts";

export const dispatchStreamSchema = "runtime-dispatch-stream/v1" as const;
export const dispatchStreamReadLimitBytes = 200 * 1024 * 1024;
const dispatchStreamWriteLimitBytes = 500 * 1024 * 1024;

export function readDispatchStreamIncrement(
  target: string,
  offset: number,
): { readonly bytes: Buffer; readonly size: number } | null {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > dispatchStreamReadLimitBytes) return null;
  const descriptor = openSync(target, fsConstants.O_RDONLY);
  try {
    const size = fstatSync(descriptor).size;
    if (size > dispatchStreamReadLimitBytes || size <= offset) return { bytes: Buffer.alloc(0), size };
    const bytes = Buffer.alloc(size - offset);
    const read = readSync(descriptor, bytes, 0, bytes.length, offset);
    return { bytes: bytes.subarray(0, read), size };
  } finally {
    closeSync(descriptor);
  }
}

export function readRuntimeWorkerChunk(target: string, offset: number, limit = 1024 * 1024): Buffer {
  const descriptor = openSync(target, fsConstants.O_RDONLY);
  try {
    const size = fstatSync(descriptor).size;
    if (size <= offset) return Buffer.alloc(0);
    const bytes = Buffer.alloc(Math.min(size - offset, limit));
    const read = readSync(descriptor, bytes, 0, bytes.length, offset);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

export interface DispatchStreamAppender {
  readonly append: (value: Readonly<Record<string, unknown>>) => void;
  readonly close: () => void;
}

export function openDispatchStreamAppender(
  target: string,
  input: {
    readonly invalidateSummary: () => void;
    readonly scrub: (value: unknown) => unknown;
    readonly unbounded: (value: Readonly<Record<string, unknown>>) => boolean;
    readonly warnDroppedOutput: () => void;
  },
): DispatchStreamAppender {
  let descriptor: number | null = null;
  return {
    append: (value) => {
      input.invalidateSummary();
      const owned = descriptor !== null,
        handle = descriptor ?? openSync(target, fsConstants.O_APPEND | fsConstants.O_WRONLY);
      try {
        const size = fstatSync(handle).size;
        if (size >= dispatchStreamWriteLimitBytes && input.unbounded(value)) {
          input.warnDroppedOutput();
          if (!owned) closeSync(handle);
          return;
        }
        writeFileSync(handle, `${JSON.stringify(input.scrub({ schema: dispatchStreamSchema, ...value }))}\n`, "utf8");
      } catch (error) {
        descriptor = null;
        try {
          closeSync(handle);
        } catch (closeError) {
          consumeKnownError(closeError);
        }
        throw error;
      }
      descriptor = handle;
    },
    close: () => {
      if (descriptor === null) return;
      const handle = descriptor;
      descriptor = null;
      closeSync(handle);
    },
  };
}

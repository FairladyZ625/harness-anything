import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WriteFence = <T>(operation: () => T) => T;

// Windows refuses fsync on a handle that was not opened for writing: FlushFileBuffers needs
// write access, so `openSync(target, "r")` followed by fsync raises EPERM and takes the whole
// write down before the bytes it was meant to make durable can be observed (#1586, measured on
// Windows 11 / Node 24). Two consequences, and they differ:
//
//   - A file can always be flushed -- open it "r+" and every platform agrees. No branch needed.
//   - A directory has no writable handle on Windows at all. Windows makes the rename durable on
//     its own, so skipping the flush there is not a weaker guarantee, and the branch is real.
//
// Every durable write in this package goes through here. The rule was previously restated in
// six modules and had drifted in three of them, so it is stated once instead.
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = /* @gate-identity state-store/legacy.3ec23ab4fb0e7f1d */ openSync(directory, "r");
  try {
    /* @gate-identity state-store/legacy.5cb5153da54a5730 */ fsyncSync(descriptor);
  } finally {
    /* @gate-identity state-store/legacy.df4d1bb1ec1f6d38 */ closeSync(descriptor);
  }
}

export function syncFile(file: string): void {
  const descriptor = /* @gate-identity state-store/legacy.8231acaf3b7a8204 */ openSync(file, "r+");
  try {
    /* @gate-identity state-store/legacy.6c80319470c33d2f */ fsyncSync(descriptor);
  } finally {
    /* @gate-identity state-store/legacy.53d5de9fc6dfc0d9 */ closeSync(descriptor);
  }
}

export function writeFileDurably(file: string, body: string | Uint8Array, mode?: number, withFence?: WriteFence): void {
  writeFileDurablyFrom(
    file,
    { write: (descriptor) => /* @gate-identity state-store/legacy.9684824f1ec4567b */ writeFileSync(descriptor, body) },
    mode,
    withFence,
  );
}

/** Publish incrementally-produced bytes with the same atomic replacement as a complete body. */
export function writeFileDurablyFrom(
  file: string,
  writer: { readonly write: (descriptor: number) => void },
  mode?: number,
  withFence?: WriteFence,
): void {
  const directory = path.dirname(file);
  /* @gate-identity state-store/legacy.2a195a59ec16925b */ mkdirSync(directory, { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor =
    mode === undefined
      ? /* @gate-identity state-store/legacy.d8c1a448fcd8a8bd */ openSync(temp, "wx")
      : /* @gate-identity state-store/legacy.b295ff7297e801f6 */ openSync(temp, "wx", mode);
  // The temp name carries this process's pid, so no second party will ever reclaim it.
  // A throw between the open and the rename therefore has to take its own leftover with it,
  // or the file outlives the process that owned it (F-FAED015B measured one such orphan
  // surviving 7h46m under a fleet edge .staging/ after its writer was killed).
  try {
    try {
      writer.write(descriptor);
      /* @gate-identity state-store/legacy.c09cf498e82fdf04 */ fsyncSync(descriptor);
    } finally {
      /* @gate-identity state-store/legacy.043ba876dc23028d */ closeSync(descriptor);
    }
    // Byte preparation and flush may be slow; ownership must hold only for publication.
    const publish = () => /* @gate-identity state-store/legacy.67b1d8e97cfc08db */ renameSync(temp, file);
    if (withFence) withFence(publish);
    else publish();
  } catch (error) {
    /* @gate-identity state-store/legacy.0fa6bcfd73656226 */ rmSync(temp, { force: true });
    throw error;
  }
  syncDirectory(directory);
}

// Positioned read for replay comparison: both fleet upload paths retry one
// chunk against a durable prefix that can be far larger than the contested
// window. A short read returns the shorter buffer so callers can reject it by
// comparison. This is the only read-only file handle outside the flush ports
// above (#1586: one implementation per capability).
export function readFileWindow(file: string, offset: number, length: number): Buffer {
  const descriptor = /* @gate-identity state-store/legacy.996414bfe555b302 */ openSync(file, "r");
  try {
    const window = Buffer.alloc(length);
    const read = readSync(descriptor, window, 0, length, offset);
    return read === length ? window : window.subarray(0, read);
  } finally {
    /* @gate-identity state-store/legacy.1b59753db03c76bb */ closeSync(descriptor);
  }
}

/** Run a bounded synchronous reader while the shared file port owns the read-only handle. */
export function withReadOnlyFile<Value>(file: string, read: (descriptor: number) => Value): Value {
  const descriptor = /* @gate-identity state-store/legacy.5be374441d1f5c78 */ openSync(file, "r");
  try {
    return read(descriptor);
  } finally {
    /* @gate-identity state-store/legacy.f987e0b1e4057aaa */ closeSync(descriptor);
  }
}

/** Delete one private object and durably publish the directory entry change. */
export function removeFileDurably(file: string, withFence?: WriteFence): void {
  const remove = () => /* @gate-identity state-store/legacy.01af7dfeff14f25e */ rmSync(file, { force: true });
  if (withFence) withFence(remove);
  else remove();
  syncDirectory(path.dirname(file));
}

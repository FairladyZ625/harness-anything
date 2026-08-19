import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function syncFile(file: string): void {
  const descriptor = openSync(file, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function writeFileDurably(file: string, body: string | Uint8Array, mode?: number): void {
  const directory = path.dirname(file); mkdirSync(directory, { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = mode === undefined ? openSync(temp, "wx") : openSync(temp, "wx", mode);
  try { writeFileSync(descriptor, body); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temp, file); syncDirectory(directory);
}

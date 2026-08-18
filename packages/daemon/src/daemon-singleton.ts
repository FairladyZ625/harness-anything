import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { daemonSocketProbe } from "./client/daemon-autostart.ts";

// The daemon singleton is one process per (userRoot, daemonId). The claim is a
// pidfile created with O_EXCL (atomic test-and-set): the second serve reads the
// holder pid, verifies liveness with kill(pid, 0), and defers to it. A holder
// that is provably dead is replaced, so a crashed daemon never wedges the slot.
export interface DaemonSingletonHeld { readonly claim: "acquired"; readonly release: () => void }
export interface DaemonSingletonIncumbent { readonly claim: "incumbent"; readonly pid: number | null; readonly witness: "unix-socket" | "singleton-lock" }
export type DaemonSingletonOutcome = DaemonSingletonHeld | DaemonSingletonIncumbent;
export function daemonPidPath(userRoot: string, daemonId: string): string { return path.join(userRoot, `daemon-${safeRuntimeId(daemonId)}.pid`); }
export function daemonSingletonLockPath(userRoot: string, daemonId: string): string { return path.join(userRoot, `daemon-${safeRuntimeId(daemonId)}.singleton.lock`); }
export function readDaemonPid(userRoot: string, daemonId: string): number | null { return readPidFile(daemonPidPath(userRoot, daemonId)); }
export async function acquireDaemonSingleton(input: { readonly userRoot: string; readonly daemonId: string; readonly endpoint: string; readonly pid?: number; readonly probe?: (socketPath: string) => Promise<boolean> }): Promise<DaemonSingletonOutcome> {
  const pid = input.pid ?? process.pid, probe = input.probe ?? daemonSocketProbe, lockPath = daemonSingletonLockPath(input.userRoot, input.daemonId);
  mkdirSync(input.userRoot, { recursive: true });
  // A socket that accepts connections is a live incumbent even when the lock
  // bookkeeping is absent (a daemon started by an older build holds no lock).
  if (await probe(input.endpoint)) return { claim: "incumbent", pid: readDaemonPid(input.userRoot, input.daemonId), witness: "unix-socket" };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { writeFileSync(lockPath, `${pid}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      consumeKnownError(error);
      const holder = await readHolderPid(lockPath);
      if (holder !== null && holder !== pid && processAlive(holder)) return { claim: "incumbent", pid: holder, witness: "singleton-lock" };
      try { unlinkSync(lockPath); } catch (cleanup) { if (!isCode(cleanup, "ENOENT")) throw cleanup; consumeKnownError(cleanup); }
      continue;
    }
    // The slot was free when probed, but an older-build daemon may have bound
    // the socket while we were claiming the lock; it still outranks this claim.
    if (await probe(input.endpoint)) { releaseIfHeld(lockPath, pid); return { claim: "incumbent", pid: readDaemonPid(input.userRoot, input.daemonId), witness: "unix-socket" }; }
    return { claim: "acquired", release: () => releaseIfHeld(lockPath, pid) };
  }
  throw singletonError(`The daemon singleton lock at ${lockPath} could not be claimed after repeated stale-holder replacement.`);
}
// An empty or unparsable lock body is usually a creator between its atomic
// create and its pid write; give that window a short grace before replacing.
async function readHolderPid(lockPath: string): Promise<number | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) { const pid = readPidFile(lockPath); if (pid !== null) return pid; await new Promise((resolve) => setTimeout(resolve, 25)); }
  return readPidFile(lockPath);
}
function readPidFile(target: string): number | null {
  try { const pid = Number(readFileSync(target, "utf8").trim()); return Number.isInteger(pid) && pid > 0 ? pid : null; }
  catch (error) { consumeKnownError(error); return null; }
}
function releaseIfHeld(lockPath: string, pid: number): void { if (readPidFile(lockPath) === pid) try { unlinkSync(lockPath); } catch (error) { if (!isCode(error, "ENOENT")) throw error; consumeKnownError(error); } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if (!isCode(error, "EPERM")) consumeKnownError(error); return isCode(error, "EPERM"); } }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code; }
function singletonError(text: string): Error { const error = new Error(text) as Error & { code: string }; error.code = "daemon_singleton_lock_failed"; return error; }
function safeRuntimeId(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/gu, "-"); }

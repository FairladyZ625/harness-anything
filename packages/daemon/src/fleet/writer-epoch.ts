import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../../kernel/src/index.ts";

export interface WriterEpochLease { readonly repoId: string; readonly holderId: string; readonly epoch: number; readonly version: number; readonly issuedAt: string }
export interface PersistentWriterEpoch {
  readonly acquire: (repoId: string) => WriterEpochLease;
  readonly current: (repoId: string) => WriterEpochLease | null;
  readonly assert: (repoId: string, epoch: number, holderId?: string) => void;
  readonly status: () => readonly WriterEpochLease[];
  readonly close: () => void;
}
export class WriterEpochError extends Error {
  readonly code: "writer_epoch_stale" | "writer_epoch_busy" | "writer_epoch_invalid";
  constructor(code: WriterEpochError["code"], message: string) { super(message); this.name = "WriterEpochError"; this.code = code; }
}
type EpochState = { readonly schema: "fleet-writer-epoch/v1"; readonly repos: Record<string, WriterEpochLease> };
const schema = "fleet-writer-epoch/v1" as const;

export function openPersistentWriterEpoch(options: { readonly stateRoot: string; readonly holderId?: string; readonly now?: () => string }): PersistentWriterEpoch {
  mkdirSync(options.stateRoot, { recursive: true });
  const stateFile = path.join(options.stateRoot, "writer-epochs.json"), lockFile = path.join(options.stateRoot, "writer-epochs.lock"), holderId = options.holderId ?? `center-${process.pid}-${randomUUID()}`, now = options.now ?? (() => new Date().toISOString());
  let closed = false;
  const read = (): EpochState => readState(stateFile);
  const write = (state: EpochState): void => writeWriterEpochState(stateFile, state);
  const acquire = (repoId: string): WriterEpochLease => {
    if (closed) throw new WriterEpochError("writer_epoch_invalid", "writer epoch authority is closed");
    if (!repoId) throw new WriterEpochError("writer_epoch_invalid", "repoId is required for writer epoch allocation");
    return withLock(lockFile, () => { const state = read(), previous = state.repos[repoId], lease: WriterEpochLease = { repoId, holderId, epoch: (previous?.epoch ?? 0) + 1, version: (previous?.version ?? 0) + 1, issuedAt: now() }; write({ schema, repos: { ...state.repos, [repoId]: lease } }); return lease; });
  };
  const current = (repoId: string): WriterEpochLease | null => read().repos[repoId] ?? null;
  const assert = (repoId: string, epoch: number, expectedHolderId = holderId): void => {
    const observed = current(repoId);
    if (!observed || observed.epoch !== epoch || observed.holderId !== expectedHolderId) throw new WriterEpochError("writer_epoch_stale", `writer epoch ${epoch} for ${repoId} is stale; current epoch is ${observed?.epoch ?? "missing"}. Query the receipt or reacquire the writer epoch before retrying.`);
  };
  const status = (): readonly WriterEpochLease[] => Object.values(read().repos).sort((left, right) => left.repoId.localeCompare(right.repoId));
  return { acquire, current, assert, status, close: () => { closed = true; } };
}

function readState(file: string): EpochState {
  if (!existsSync(file)) return { schema, repos: {} };
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new WriterEpochError("writer_epoch_invalid", `writer epoch state is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { schema?: unknown }).schema !== schema || !isRecord((value as { repos?: unknown }).repos)) throw new WriterEpochError("writer_epoch_invalid", "writer epoch state has an invalid durable shape");
  const repos: Record<string, WriterEpochLease> = {};
  for (const [repoId, raw] of Object.entries((value as { repos: Record<string, unknown> }).repos)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WriterEpochError("writer_epoch_invalid", `writer epoch row ${repoId} is invalid`);
    const row = raw as Record<string, unknown>;
    if (row.repoId !== repoId || typeof row.holderId !== "string" || !row.holderId || !Number.isSafeInteger(row.epoch) || Number(row.epoch) <= 0 || !Number.isSafeInteger(row.version) || Number(row.version) <= 0 || typeof row.issuedAt !== "string") throw new WriterEpochError("writer_epoch_invalid", `writer epoch row ${repoId} is invalid`);
    repos[repoId] = row as unknown as WriterEpochLease;
  }
  return { schema, repos };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function withLock<T>(file: string, operation: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 200 && fd === undefined; attempt += 1) {
    try { fd = openSync(file, "wx", 0o600); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      let alive = false;
      if (Number.isSafeInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch (error) { consumeKnownError(error); alive = false; } }
      if (!alive) { try { unlinkSync(file); } catch (retryError) { consumeKnownError(retryError); if ((retryError as NodeJS.ErrnoException).code !== "ENOENT") throw retryError; } continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (fd === undefined) throw new WriterEpochError("writer_epoch_busy", "another center is allocating a writer epoch");
  try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); return operation(); }
  finally { closeSync(fd); try { unlinkSync(file); } catch (error) { consumeKnownError(error); } }
}
function writeWriterEpochState(file: string, value: unknown): void { const temp = `${file}.${process.pid}.${randomUUID()}.tmp`, fd = openSync(temp, "w", 0o600); try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, file); const dir = openSync(path.dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }

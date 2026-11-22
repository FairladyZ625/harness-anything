import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManagedPostgresBinaries } from "@harness-anything/authorization/keycloak/managed-rbac-service";

const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 25;
const LOCK_EMPTY_GRACE_MS = 5_000;

export interface DirLockOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly emptyGraceMs?: number;
}

interface LockOwnerRecord {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

let cachedBinaries: ManagedPostgresBinaries | null = null;
const cachedTemplateByBin = new Map<string, string>();

function uidTag(): string {
  return String(process.getuid?.() ?? "user");
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function tryUnlink(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

function tryRemoveEmptyDir(dirPath: string): boolean {
  try {
    rmdirSync(dirPath);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function readOwnerRecord(ownerPath: string): LockOwnerRecord | null {
  let raw: string;
  try {
    raw = readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwnerRecord>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.acquiredAt === "number"
    ) {
      return parsed as LockOwnerRecord;
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function tryReclaimContendedLock(
  lockDir: string,
  emptyGraceMs: number,
): { readonly action: "retry" | "wait"; readonly livePid?: number } {
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { action: "retry" };
    throw error;
  }

  const ownerFile = entries.find((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
  if (ownerFile) {
    const ownerPath = path.join(lockDir, ownerFile);
    const owner = readOwnerRecord(ownerPath);
    if (owner) {
      if (isProcessAlive(owner.pid)) return { action: "wait", livePid: owner.pid };
      if (tryUnlink(ownerPath)) {
        tryUnlink(path.join(lockDir, `staging-${owner.token}.json`));
        tryRemoveEmptyDir(lockDir);
      }
      return { action: "retry" };
    }
    try {
      const ownerStat = statSync(ownerPath);
      if (Date.now() - ownerStat.mtimeMs < emptyGraceMs) return { action: "wait" };
      if (tryUnlink(ownerPath)) tryRemoveEmptyDir(lockDir);
      return { action: "retry" };
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return { action: "retry" };
      throw error;
    }
  }

  let dirStat;
  try {
    dirStat = statSync(lockDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { action: "retry" };
    throw error;
  }
  if (Date.now() - dirStat.mtimeMs < emptyGraceMs) return { action: "wait" };

  for (const entry of entries) {
    if (!entry.startsWith("staging-") || !entry.endsWith(".json")) continue;
    const stagingPath = path.join(lockDir, entry);
    try {
      const stagingStat = statSync(stagingPath);
      if (Date.now() - stagingStat.mtimeMs >= emptyGraceMs) tryUnlink(stagingPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  tryRemoveEmptyDir(lockDir);
  return { action: "retry" };
}

function sleepSyncOrAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes access to a shared PostgreSQL cache/template directory via an ownership-verified lock
 * directory. Live owners are never evicted on timeout; only dead owners (or abandoned unowned
 * directories past `emptyGraceMs`) may be reclaimed, and holders release only their own token.
 */
export async function withDirLock<T>(lockDir: string, fn: () => Promise<T>, options: DirLockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const emptyGraceMs = options.emptyGraceMs ?? LOCK_EMPTY_GRACE_MS;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  const ownerPath = path.join(lockDir, `owner-${token}.json`);
  const stagingPath = path.join(lockDir, `staging-${token}.json`);

  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      let finalized = false;
      try {
        writeFileSync(stagingPath, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }), {
          mode: 0o600,
        });
        renameSync(stagingPath, ownerPath);
        finalized = true;
      } finally {
        if (!finalized) {
          tryUnlink(stagingPath);
          tryRemoveEmptyDir(lockDir);
        }
      }
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const outcome = tryReclaimContendedLock(lockDir, emptyGraceMs);
      if (outcome.action === "retry") continue;
      if (Date.now() >= deadline) {
        const ownerDetail =
          outcome.livePid === undefined ? "an unowned lock directory" : `live process ${outcome.livePid}`;
        throw new Error(
          `Timed out after ${waitMs}ms waiting for PostgreSQL template lock ${lockDir} (${ownerDetail}).`,
        );
      }
      await sleepSyncOrAsync(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    if (tryUnlink(ownerPath)) tryRemoveEmptyDir(lockDir);
  }
}

function enforcePostgresPermissions(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      enforcePostgresPermissions(full);
    } else if (entry.isFile()) {
      chmodSync(full, 0o600);
    }
  }
}

export async function ensureCachedPostgresBinaries(
  installAtRoot: (cacheRoot: string) => Promise<ManagedPostgresBinaries>,
): Promise<ManagedPostgresBinaries> {
  if (
    cachedBinaries &&
    existsSync(cachedBinaries.initdb) &&
    existsSync(cachedBinaries.pgCtl) &&
    existsSync(cachedBinaries.postgres)
  ) {
    return cachedBinaries;
  }
  const cacheRoot = path.join(tmpdir(), `ha-pg-binaries-${process.platform}-${process.arch}-${uidTag()}-v1`);
  const lockDir = `${cacheRoot}.lock`;
  const resolved = await withDirLock(lockDir, async () => {
    const bins = await installAtRoot(cacheRoot);
    return bins;
  });
  cachedBinaries = resolved;
  return resolved;
}

export async function cloneOrInitPostgresCluster(
  binaries: ManagedPostgresBinaries,
  dataDirectory: string,
): Promise<void> {
  let versionStamp: string;
  try {
    const st = statSync(binaries.initdb);
    versionStamp = `${binaries.initdb}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    versionStamp = binaries.initdb;
  }
  const cacheKey = createHash("sha256").update(versionStamp).digest("hex").slice(0, 12);
  const templateDir =
    cachedTemplateByBin.get(cacheKey) ??
    path.join(tmpdir(), `ha-pg-initdb-${process.platform}-${process.arch}-${uidTag()}-${cacheKey}-v1`);

  if (!existsSync(path.join(templateDir, "PG_VERSION"))) {
    const lockDir = `${templateDir}.lock`;
    await withDirLock(lockDir, async () => {
      if (existsSync(path.join(templateDir, "PG_VERSION"))) return;
      const staging = `${templateDir}.staging-${process.pid}-${Date.now()}`;
      rmSync(staging, { recursive: true, force: true });
      try {
        execFileSync(
          binaries.initdb,
          ["-D", staging, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"],
          { encoding: "utf8" },
        );
        try {
          renameSync(staging, templateDir);
        } catch (error) {
          if (!existsSync(path.join(templateDir, "PG_VERSION"))) throw error;
          rmSync(staging, { recursive: true, force: true });
        }
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    });
  }
  cachedTemplateByBin.set(cacheKey, templateDir);

  if (existsSync(path.join(templateDir, "PG_VERSION"))) {
    rmSync(dataDirectory, { recursive: true, force: true });
    cpSync(templateDir, dataDirectory, { recursive: true, force: true });
    enforcePostgresPermissions(dataDirectory);
    if (existsSync(path.join(dataDirectory, "PG_VERSION"))) return;
  }

  rmSync(dataDirectory, { recursive: true, force: true });
  execFileSync(
    binaries.initdb,
    ["-D", dataDirectory, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"],
    { encoding: "utf8" },
  );
}

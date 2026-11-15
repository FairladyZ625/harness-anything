import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManagedPostgresBinaries } from "@harness-anything/authorization-keycloak/managed-rbac-service";

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 25;

let cachedBinaries: ManagedPostgresBinaries | null = null;
const cachedTemplateByBin = new Map<string, string>();

function uidTag(): string {
  return String(process.getuid?.() ?? "user");
}

function sleepSyncOrAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDirLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      try {
        writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n${Date.now()}`);
      } catch {
        // Best-effort owner stamp for stale lock recovery.
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleepSyncOrAsync(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
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

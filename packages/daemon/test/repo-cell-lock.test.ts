// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isRecycledPidLock,
  processStartTimeMs,
  staleWriterLock,
} from "../src/repo-cell-lock.ts";

function plantLock(dir: string, name: string, content: string, mtimeMs?: number): string {
  const target = path.join(dir, name);
  writeFileSync(target, content, "utf8");
  if (mtimeMs !== undefined) {
    const atime = new Date(mtimeMs);
    utimesSync(target, atime, atime);
  }
  return target;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-writer-lock-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a lock naming a dead pid is stale", () => {
  withTempDir((dir) => {
    assert.equal(staleWriterLock(plantLock(dir, "dead.lock", "2147483647\n")), true);
  });
});

test("a lock with unparseable content is not stale", () => {
  withTempDir((dir) => {
    assert.equal(staleWriterLock(plantLock(dir, "garbage.lock", "not-a-pid\n")), false);
  });
});

test("a fresh lock of a live holder is not stale", () => {
  // Mirrors the external-writer case: a holder that started before writing and is still
  // alive must never have its lock stolen, even by a newer daemon generation.
  withTempDir((dir) => {
    assert.equal(staleWriterLock(plantLock(dir, "live.lock", `${process.pid}\n`)), false);
  });
});

test("a lock older than its holder is stale (recycled pid)", () => {
  // The holder incarnation running now started after this lock was written, so it cannot
  // be the author: the pid was recycled, exactly the post-crash shape on Windows.
  withTempDir((dir) => {
    const target = plantLock(dir, "recycled.lock", `${process.pid}\n`, Date.now() - 20 * 60_1_000);
    assert.equal(staleWriterLock(target), true);
  });
});

test("an EPERM pid falls through to the recycle check instead of passing as live", async (t) => {
  // svchost-style: the pid exists but we may not signal it. The old code returned false
  // here and welded the repo; the recycle check below must decide instead.
  const originalKill = process.kill;
  t.after(() => {
    process.kill = originalKill;
  });
  (process as unknown as { kill: unknown }).kill = () => {
    const error = new Error("stubbed EPERM") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  };
  withTempDir((dir) => {
    const target = plantLock(dir, "eperm.lock", `${process.pid}\n`, Date.now() - 20 * 60_1_000);
    assert.equal(staleWriterLock(target), true);
  });
});

test("isRecycledPidLock compares holder start against lock mtime", () => {
  assert.equal(isRecycledPidLock(100, 200), true);
  assert.equal(isRecycledPidLock(200, 100), false);
  assert.equal(isRecycledPidLock(100, 100), false);
});

test("processStartTimeMs reports this process", () => {
  const startedAt = processStartTimeMs(process.pid);
  assert.ok(typeof startedAt === "number" && startedAt > 0 && startedAt <= Date.now());
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { withDirLock } from "./pg-cluster-template.fixture.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

function findOwnerFile(lockDir: string): string | undefined {
  return readdirSync(lockDir).find((name) => name.startsWith("owner-") && name.endsWith(".json"));
}

test("live holder cannot be displaced by aged mtime or waiter timeout and releases for the next waiter", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-lock-live-"));
  t.after(() => removeTempRepository(root));
  const lockDir = path.join(root, "binaries.lock");
  const enteredA = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const holderA = withDirLock(
    lockDir,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push("A-enter");
      enteredA.resolve();
      await releaseA.promise;
      order.push("A-exit");
      active -= 1;
    },
    { waitMs: 5_000, pollMs: 5, emptyGraceMs: 20 },
  );

  await enteredA.promise;
  const ownerFile = findOwnerFile(lockDir);
  assert.ok(ownerFile, "owner marker file must exist while lock is held");

  // Backdate directory and owner marker well past 120s to confirm mtime cannot evict a live holder.
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(lockDir, ownerFile), past, past);
  utimesSync(lockDir, past, past);

  let waiterBEntered = false;
  await assert.rejects(
    withDirLock(
      lockDir,
      async () => {
        waiterBEntered = true;
      },
      { waitMs: 60, pollMs: 5, emptyGraceMs: 10 },
    ),
    /Timed out after 60ms waiting for PostgreSQL template lock .* \(live process \d+\)\./u,
  );
  assert.equal(waiterBEntered, false);
  assert.equal(findOwnerFile(lockDir), ownerFile, "timed-out waiter must leave live owner marker intact");

  let waiterCEntered = false;
  const waiterC = withDirLock(
    lockDir,
    async () => {
      waiterCEntered = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push("C-enter");
      active -= 1;
    },
    { waitMs: 5_000, pollMs: 5, emptyGraceMs: 10 },
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(waiterCEntered, false, "queued waiter must not enter while A still holds lock");

  releaseA.resolve();
  await Promise.all([holderA, waiterC]);
  assert.deepEqual(order, ["A-enter", "A-exit", "C-enter"]);
  assert.equal(maxActive, 1);
  assert.equal(existsSync(lockDir), false);
});

test("live child process holding the lock cannot be displaced across processes and releases on exit", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-lock-child-"));
  t.after(() => removeTempRepository(root));
  const lockDir = path.join(root, "template.lock");
  const fixtureUrl = pathToFileURL(path.resolve(import.meta.dirname, "pg-cluster-template.fixture.ts")).href;
  const script = `
    import { withDirLock } from ${JSON.stringify(fixtureUrl)};
    await withDirLock(${JSON.stringify(lockDir)}, async () => {
      process.stdout.write("LOCKED\\n");
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once("end", resolve);
      });
    }, { waitMs: 5000, pollMs: 5, emptyGraceMs: 20 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("LOCKED\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`child exited before lock (${code}): ${stderr}`)));
  });

  const ownerFile = findOwnerFile(lockDir);
  assert.ok(ownerFile);
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(lockDir, ownerFile), past, past);
  utimesSync(lockDir, past, past);

  await assert.rejects(
    withDirLock(
      lockDir,
      async () => {
        throw new Error("should not displace live child holder");
      },
      { waitMs: 60, pollMs: 5, emptyGraceMs: 10 },
    ),
    new RegExp(`Timed out after 60ms waiting for PostgreSQL template lock .* \\(live process ${child.pid}\\)\\.`),
  );

  let enteredAfterChild = false;
  const waiter = withDirLock(
    lockDir,
    async () => {
      enteredAfterChild = true;
    },
    { waitMs: 5_000, pollMs: 5, emptyGraceMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(enteredAfterChild, false);

  child.stdin.end();
  const [exitCode] = await new Promise<[number | null]>((resolve) => child.once("exit", (code) => resolve([code])));
  assert.equal(exitCode, 0, stderr);
  await waiter;
  assert.equal(enteredAfterChild, true);
  assert.equal(existsSync(lockDir), false);
});

test("old holder eventual release does not delete a successor replacement lock", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-lock-successor-"));
  t.after(() => removeTempRepository(root));
  const lockDir = path.join(root, "binaries.lock");
  const enteredA = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const enteredB = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();

  const holderA = withDirLock(lockDir, async () => {
    enteredA.resolve();
    await releaseA.promise;
  });
  await enteredA.promise;
  const ownerA = findOwnerFile(lockDir);
  assert.ok(ownerA);

  // Simulate an external replacement before A finishes its critical section.
  unlinkSync(path.join(lockDir, ownerA));
  rmdirSync(lockDir);

  const holderB = withDirLock(lockDir, async () => {
    enteredB.resolve();
    await releaseB.promise;
  });
  await enteredB.promise;
  const ownerB = findOwnerFile(lockDir);
  assert.ok(ownerB);
  assert.notEqual(ownerB, ownerA);

  // When old holder A eventually releases, B's lock must remain intact and exclusive.
  releaseA.resolve();
  await holderA;
  assert.equal(existsSync(lockDir), true);
  assert.equal(findOwnerFile(lockDir), ownerB, "old holder A must not unlink or remove B's lock");

  await assert.rejects(
    withDirLock(
      lockDir,
      async () => {
        throw new Error("should not bypass successor lock B");
      },
      { waitMs: 50, pollMs: 5, emptyGraceMs: 10 },
    ),
    /Timed out after 50ms/u,
  );

  releaseB.resolve();
  await holderB;
  assert.equal(existsSync(lockDir), false);
});

test("reclaims a lock left by a demonstrably dead owner without overlapping concurrent waiters", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-lock-dead-"));
  t.after(() => removeTempRepository(root));
  const lockDir = path.join(root, "binaries.lock");

  const deadSpawn = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(deadSpawn.status, 0);
  const deadPid = deadSpawn.pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0);
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });

  mkdirSync(lockDir, { mode: 0o700 });
  writeFileSync(
    path.join(lockDir, "owner-dead-holder.json"),
    JSON.stringify({ pid: deadPid, token: "dead-holder", acquiredAt: Date.now() - 10_000 }),
  );

  let active = 0;
  let maxActive = 0;
  let completed = 0;
  await Promise.all([
    withDirLock(
      lockDir,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed += 1;
        active -= 1;
      },
      { waitMs: 2_000, pollMs: 5, emptyGraceMs: 500 },
    ),
    withDirLock(
      lockDir,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed += 1;
        active -= 1;
      },
      { waitMs: 2_000, pollMs: 5, emptyGraceMs: 500 },
    ),
  ]);
  assert.equal(completed, 2);
  assert.equal(maxActive, 1);
  assert.equal(existsSync(lockDir), false);
});

test("respects emptyGraceMs for in-flight lock directories and reclaims abandoned empty dirs", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-lock-empty-"));
  t.after(() => removeTempRepository(root));
  const lockDir = path.join(root, "binaries.lock");
  mkdirSync(lockDir, { mode: 0o700 });

  await assert.rejects(
    withDirLock(
      lockDir,
      async () => {
        throw new Error("must not reclaim fresh empty lock dir within grace window");
      },
      { waitMs: 40, pollMs: 5, emptyGraceMs: 250 },
    ),
    /Timed out after 40ms .* unowned lock directory/u,
  );
  assert.equal(existsSync(lockDir), true);

  const past = new Date(Date.now() - 5_000);
  utimesSync(lockDir, past, past);

  let ran = false;
  await withDirLock(
    lockDir,
    async () => {
      ran = true;
    },
    { waitMs: 500, pollMs: 5, emptyGraceMs: 250 },
  );
  assert.equal(ran, true);
  assert.equal(existsSync(lockDir), false);
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { localGitWorktreeSettlement } from "../../src/index.ts";
import { withTempStore, withTempStoreAsync } from "./helpers.ts";

function git(repoRoot: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function ledger(rootDir: string): string {
  const repoRoot = path.join(rootDir, "ledger");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet");
  return repoRoot;
}

/** Plants a leftover settlement marker exactly where a killed writer would have left it. */
function plant(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, name);
  writeFileSync(marker, "leaked", "utf8");
  return marker;
}

function markers(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith(".ha-"))
    .sort();
}

/** A pid that belonged to a process which has provably exited. */
function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { pid } = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a pid whose process has exited");
}

test(
  "settle reclaims the markers a SIGKILLed settlement left behind",
  { skip: process.platform === "win32" ? "requires POSIX SIGKILL semantics" : false },
  () => {
    withTempStore((rootDir) => {
      const repoRoot = ledger(rootDir),
        directory = path.join(repoRoot, "events", "ab"),
        moduleUrl = new URL("../../src/store/local-version-control-system.ts", import.meta.url).href,
        child = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            [
              `import { localGitWorktreeSettlement } from ${JSON.stringify(moduleUrl)};`,
              "localGitWorktreeSettlement.settle(process.env.HA_ROOT, [",
              "  { target: 'events/ab/first.json', body: 'first' },",
              "  { target: 'events/ab/second.json', body: 'second' },",
              "], { beforeRename: () => process.kill(process.pid, 'SIGKILL') });",
            ].join("\n"),
          ],
          { encoding: "utf8", env: { ...process.env, HA_ROOT: repoRoot } },
        );
      assert.equal(child.signal, "SIGKILL", child.stderr);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      // Negative control: the durable bodies exist under their marker names and nothing renamed them.
      assert.deepEqual(markers(directory), [`.ha-settle-${child.pid}-0`, `.ha-settle-${child.pid}-1`]);
      assert.equal(existsSync(path.join(directory, "first.json")), false);
      const untouched = plant(path.join(repoRoot, "objects", "zz"), `.ha-settle-${child.pid}-0`);

      localGitWorktreeSettlement.settle(repoRoot, [{ target: "events/ab/third.json", body: "third" }]);

      assert.deepEqual(markers(directory), []);
      assert.equal(readFileSync(path.join(directory, "third.json"), "utf8"), "third");
      assert.match(git(repoRoot, "ls-files", "--stage", "events/ab/third.json"), /^100644 /u);
      // Only the directories this settlement touched are swept; cold directories are left alone.
      assert.equal(existsSync(untouched), true);
    });
  },
);

test("settle keeps markers owned by live, own, or unparseable pids while reclaiming the dead one beside them", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoRoot = ledger(rootDir),
      directory = path.join(repoRoot, "events", "cd"),
      bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await once(bystander, "spawn");
      const live = plant(directory, `.ha-settle-${bystander.pid}-0`),
        own = plant(directory, `.ha-visible-${process.pid}-41`),
        garbage = plant(directory, ".ha-settle-not-a-pid-0"),
        zero = plant(directory, ".ha-settle-0-0"),
        dead = plant(directory, `.ha-settle-${deadPid()}-0`);

      localGitWorktreeSettlement.settle(repoRoot, [{ target: "events/cd/entry.json", body: "entry" }]);

      assert.equal(existsSync(live), true, "a live foreign writer keeps its in-flight marker");
      assert.equal(existsSync(own), true, "our own markers are only reclaimed by same-index reuse");
      assert.equal(existsSync(garbage), true, "names that do not parse as a marker are never touched");
      assert.equal(existsSync(zero), true, "pid 0 is not a marker owner");
      assert.equal(existsSync(dead), false, "the dead writer's marker is reclaimed");
      assert.equal(readFileSync(path.join(directory, "entry.json"), "utf8"), "entry");
    } finally {
      bystander.kill("SIGKILL");
    }
  });
});

test("settle keeps a marker whose owner it is not permitted to probe", (t) => {
  let probe: string | null = null;
  try {
    process.kill(1, 0);
  } catch (error) {
    probe = (error as NodeJS.ErrnoException).code ?? "unknown";
  }
  if (probe === "ESRCH") return t.skip("pid 1 is not visible on this platform");
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      directory = path.join(repoRoot, "events", "ef"),
      marker = plant(directory, ".ha-settle-1-0");

    localGitWorktreeSettlement.settle(repoRoot, [{ target: "events/ef/entry.json", body: "entry" }]);

    // EPERM (or a permitted probe of a live pid 1) must fail safe toward keeping the marker.
    assert.equal(existsSync(marker), true, `probe outcome ${probe ?? "permitted"} must not delete`);
    assert.equal(readFileSync(path.join(directory, "entry.json"), "utf8"), "entry");
  });
});

test("settle sweeps each directory once per process, so leftovers from a later death wait for the next process", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      directory = path.join(repoRoot, "events", "gh"),
      first = plant(directory, `.ha-settle-${deadPid()}-0`);
    localGitWorktreeSettlement.settle(repoRoot, [{ target: "events/gh/one.json", body: "one" }]);
    assert.equal(existsSync(first), false);

    const later = plant(directory, `.ha-settle-${deadPid()}-0`);
    localGitWorktreeSettlement.settle(repoRoot, [{ target: "events/gh/two.json", body: "two" }]);

    // Bounded cost: the readdir runs once per directory per process. The failure that
    // leaves markers behind (a killed writer) is always followed by a fresh process.
    assert.equal(existsSync(later), true);
    assert.equal(readFileSync(path.join(directory, "two.json"), "utf8"), "two");
  });
});

test("visible reclaims dead markers of both families in the directory it writes", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      directory = path.join(repoRoot, "tasks", "t1"),
      pid = deadPid(),
      settleMarker = plant(directory, `.ha-settle-${pid}-0`),
      visibleMarker = plant(directory, `.ha-visible-${pid}-3`);

    localGitWorktreeSettlement.visible(repoRoot, [{ target: "tasks/t1/INDEX.md", body: "# t1\n" }]);

    assert.equal(existsSync(settleMarker), false);
    assert.equal(existsSync(visibleMarker), false);
    assert.equal(readFileSync(path.join(directory, "INDEX.md"), "utf8"), "# t1\n");
  });
});

test("settle still writes, renames, deletes, and indexes with the sweep in its path", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    localGitWorktreeSettlement.settle(repoRoot, [
      { target: "events/ij/keep.json", body: "keep" },
      { target: "events/ij/old.json", body: "old" },
      { target: "events/ij/gone.json", body: "gone" },
    ]);
    const leftover = plant(path.join(repoRoot, "events", "kl"), `.ha-settle-${deadPid()}-0`);

    const touched = localGitWorktreeSettlement.settle(repoRoot, [
      { target: "events/kl/new.json", body: "new" },
      { from: "events/ij/old.json", to: "events/kl/moved.json" },
      { delete: "events/ij/gone.json" },
    ]);

    assert.equal(touched, 3 + 2, "three files across two directories");
    assert.equal(readFileSync(path.join(repoRoot, "events", "kl", "new.json"), "utf8"), "new");
    assert.equal(readFileSync(path.join(repoRoot, "events", "kl", "moved.json"), "utf8"), "old");
    assert.equal(readFileSync(path.join(repoRoot, "events", "ij", "keep.json"), "utf8"), "keep");
    assert.equal(existsSync(path.join(repoRoot, "events", "ij", "old.json")), false);
    assert.equal(existsSync(path.join(repoRoot, "events", "ij", "gone.json")), false);
    assert.equal(existsSync(leftover), false);
    assert.deepEqual(markers(path.join(repoRoot, "events", "ij")), []);
    assert.deepEqual(markers(path.join(repoRoot, "events", "kl")), []);
    assert.deepEqual(
      git(repoRoot, "ls-files", "--stage")
        .split("\n")
        .map((line) => line.split("\t")[1])
        .sort(),
      ["events/ij/keep.json", "events/kl/moved.json", "events/kl/new.json"],
    );
  });
});

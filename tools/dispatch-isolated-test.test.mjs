// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ubuntuQueueCommand,
  parseDispatchArgs,
  posixTestScript,
  powerShellTestScript,
  sourceArchiveArgs,
  sourceFileList,
  sourceRootFromCwd,
  prepareSource,
  sourceRsyncArgs,
  testRunnerArgs,
  untrackedSelectionError,
} from "./dispatch-isolated-test.mjs";

const rsyncSkip = (() => {
  const probe = spawnSync("rsync", ["--version"], { encoding: "utf8" });
  return probe.error?.code === "ENOENT"
    ? "requires the rsync executable; Windows isolation uses the tar archive path"
    : false;
})();

test("dispatcher defaults to Ubuntu and requires exactly one test selector", () => {
  assert.deepEqual(parseDispatchArgs(["--tier", "integration"]), {
    target: "ubuntu",
    tier: "integration",
    file: undefined,
    coverage: undefined,
  });
  assert.throws(() => parseDispatchArgs([]), /choose exactly one/u);
  assert.throws(() => parseDispatchArgs(["--tier", "fast", "--file", "tools/a.test.mjs"]), /choose exactly one/u);
});

test("dispatcher accepts all isolated targets and validates exact file paths", () => {
  for (const target of ["ubuntu", "docker", "windows"]) {
    assert.deepEqual(
      parseDispatchArgs(["--target", target, "--file", "packages/cli/test/daemon-autostart-cli.test.ts"]),
      {
        target,
        tier: undefined,
        file: "packages/cli/test/daemon-autostart-cli.test.ts",
        coverage: undefined,
      },
    );
  }
  assert.throws(() => parseDispatchArgs(["--target", "windows-vm", "--tier", "integration"]), /unknown target/u);
  assert.throws(() => parseDispatchArgs(["--file", "../outside.test.mjs"]), /repository-relative/u);
});

test("dispatcher builds runner commands for Node selectors and registered GUI files", () => {
  assert.deepEqual(testRunnerArgs({ tier: "integration", file: undefined }), [
    "node",
    "tools/run-node-tests.mjs",
    "--tier",
    "integration",
  ]);
  assert.deepEqual(testRunnerArgs({ tier: undefined, file: "tools/a.test.mjs" }), [
    "node",
    "tools/run-node-tests.mjs",
    "--file",
    "tools/a.test.mjs",
  ]);
  assert.deepEqual(testRunnerArgs({ tier: undefined, file: "packages/gui/test/task-pin-actions.vitest.ts" }), [
    "npm",
    "run",
    "test:gui",
    "--workspace",
    "@harness-anything/gui",
    "--",
    "test/task-pin-actions.vitest.ts",
  ]);
});

test("dispatcher sends coverage to an isolated path and rejects GUI coverage", () => {
  assert.deepEqual(parseDispatchArgs(["--file", "tools/run-node-tests.test.mjs", "--coverage", "/tmp/result.lcov"]), {
    target: "ubuntu",
    tier: undefined,
    file: "tools/run-node-tests.test.mjs",
    coverage: "/tmp/result.lcov",
  });
  assert.deepEqual(
    testRunnerArgs({ file: "tools/run-node-tests.test.mjs", coverageTarget: "/tmp/run/.test-coverage/lcov.info" }),
    [
      "node",
      "tools/run-node-tests.mjs",
      "--file",
      "tools/run-node-tests.test.mjs",
      "--coverage",
      "/tmp/run/.test-coverage/lcov.info",
    ],
  );
  assert.throws(
    () =>
      parseDispatchArgs(["--file", "packages/gui/test/task-pin-actions.vitest.ts", "--coverage", "/tmp/result.lcov"]),
    /only supported for Node/u,
  );
});

test("dispatcher rejects unregistered GUI files", () => {
  assert.throws(
    () => parseDispatchArgs(["--file", "packages/gui/test/unregistered.vitest.ts"]),
    /unknown GUI test file: packages\/gui\/test\/unregistered\.vitest\.ts/u,
  );
  assert.throws(
    () => testRunnerArgs({ tier: undefined, file: "packages/gui/test/unregistered.vitest.ts" }),
    /unknown GUI test file/u,
  );
});

test("dispatcher explains untracked --file selections instead of dispatching them", () => {
  const error = untrackedSelectionError("tools/untracked.test.mjs", ["packages/kept.ts", "tools/kept.txt"]);
  assert.match(error, /tools\/untracked\.test\.mjs is not tracked by git/u);
  assert.match(error, /only syncs git-tracked files/u);
  assert.match(error, /git add tools\/untracked\.test\.mjs/u);
  assert.equal(untrackedSelectionError("tools/kept.txt", ["packages/kept.txt", "tools/kept.txt"]), undefined);
  assert.equal(untrackedSelectionError(undefined, []), undefined);
});

test("GUI routing preserves native tests and accepts registered TSX", () => {
  const native = "packages/gui/test/local-doc-ipc.test.ts";
  assert.equal(parseDispatchArgs(["--file", native]).file, native);
  assert.deepEqual(testRunnerArgs({ file: native }), ["node", "tools/run-node-tests.mjs", "--file", native]);
  const tsx = "packages/gui/test/first-run-guide.vitest.tsx";
  assert.equal(parseDispatchArgs(["--file", tsx]).file, tsx);
  assert.deepEqual(testRunnerArgs({ file: tsx }), [
    "npm",
    "run",
    "test:gui",
    "--workspace",
    "@harness-anything/gui",
    "--",
    "test/first-run-guide.vitest.tsx",
  ]);
});

test("macOS source archives omit extended attributes while other hosts keep portable tar arguments", () => {
  assert.deepEqual(sourceArchiveArgs("darwin").slice(0, 2), ["--no-xattrs", "-cf"]);
  assert.equal(sourceArchiveArgs("linux").includes("--no-xattrs"), false);
});

test("source archives consume a structural NUL file list without exclusion patterns", () => {
  withFixture(({ source }) => {
    write(source, "packages/kept.txt");
    write(source, "tools/kept.txt");
    const args = sourceArchiveArgs("linux", source);
    assert.deepEqual(args, ["-cf", "-", "-C", source, "--null", "-T", "-"]);
    assert.equal(
      args.some((arg) => arg.startsWith("--exclude=")),
      false,
    );
  });
});

test("source discovery includes every tracked root and excludes untracked and ignored files", () => {
  withFixture(({ source }) => {
    seedRepository(source);
    write(source, "packages/untracked.ts");
    write(source, "dist/ignored.js");
    assert.deepEqual(sourceFileList(source), [
      ".gitignore",
      "future-root/space name.txt",
      "prettier.config.mjs",
      "tools/kept.txt",
    ]);
  });
});

test("source resolution follows the caller worktree when the tool is loaded elsewhere", () => {
  withFixture(({ source }) => {
    seedRepository(source);
    const linked = path.join(source, "linked");
    execFileSync("git", ["-C", source, "worktree", "add", "--quiet", "--detach", linked]);
    assert.equal(sourceRootFromCwd(linked), linked);
  });
});

for (const transport of ["tar", "rsync"]) {
  test(
    `${transport} preserves tracked content and independent Git identity from a linked worktree`,
    { skip: transport === "rsync" ? rsyncSkip : false },
    () => {
      withFixture(({ source, destination }) => {
        seedRepository(source);
        const worktree = path.join(source, "linked");
        execFileSync("git", ["-C", source, "worktree", "add", "--quiet", "--detach", worktree]);
        writeFileSync(path.join(worktree, "tools/kept.txt"), "dirty tracked content\n");
        write(worktree, "private/untracked.txt");
        const snapshot = path.join(source, "snapshot");
        const files = prepareSource(worktree, snapshot);
        assert.deepEqual(
          files.filter((file) => !file.startsWith(".git/")),
          sourceFileList(worktree),
        );
        const head = gitText(worktree, ["rev-parse", "HEAD"]);
        const parent = gitText(worktree, ["rev-parse", "HEAD^"]);
        if (transport === "tar") extractArchive(snapshot, destination, files);
        else syncWithRsync(snapshot, destination, files);
        rmSync(source, { recursive: true, force: true });
        assert.equal(gitText(destination, ["rev-parse", "HEAD"]), head);
        assert.equal(gitText(destination, ["rev-parse", "HEAD^"]), parent);
        assert.equal(gitText(destination, ["show", "HEAD:tools/kept.txt"]), "tools/kept.txt");
        assert.equal(gitText(destination, ["show", "HEAD^:tools/kept.txt"]), "tools/kept.txt");
        assert.match(gitText(destination, ["status", "--porcelain"]), /M tools\/kept.txt/u);
        assert.equal(readFileSync(path.join(destination, "tools/kept.txt"), "utf8"), "dirty tracked content\n");
        assert.equal(
          readFileSync(path.join(destination, "prettier.config.mjs"), "utf8").replace(/\r\n/gu, "\n"),
          "prettier.config.mjs\n",
        );
        assert.equal(existsSync(path.join(destination, "future-root/space name.txt")), true);
        assert.equal(existsSync(path.join(destination, "private")), false);
        assert.equal(gitText(destination, ["remote"]), "");
        console.log(`[${transport}-implementation] ${toolVersion(transport)}`);
      });
    },
  );
}

test("remote scripts preflight before executing tests with a dedicated root and id", () => {
  const options = { tier: "integration", file: undefined };
  const posix = posixTestScript("/tmp/run", "/tmp/run/.test-isolation-state", options);
  assert.match(posix, /npm ci --no-audit --no-fund/u);
  assert.match(posix, /test-hermetic-preflight\.mjs --user-root '\/tmp\/run\/.test-isolation-state'/u);
  assert.match(posix, /HARNESS_DAEMON_USER_ROOT='\/tmp\/run\/.test-isolation-state'/u);

  const powerShell = powerShellTestScript("C:\\Temp\\run", "C:\\Temp\\run\\.test-isolation-state", options);
  assert.match(powerShell, /\$ProgressPreference = 'SilentlyContinue'/u);
  assert.match(powerShell, /test-hermetic-preflight\.mjs --user-root 'C:\\Temp\\run\\\.test-isolation-state'/u);
  assert.match(powerShell, /\$env:HARNESS_DAEMON_USER_ROOT = 'C:\\Temp\\run\\\.test-isolation-state'/u);
});

test("remote scripts preserve the GUI workspace-relative file argument", () => {
  const options = { tier: undefined, file: "packages/gui/test/task-pin-actions.vitest.ts" };
  const posix = posixTestScript("/tmp/run", "/tmp/run/.test-isolation-state", options);
  const powerShell = powerShellTestScript("C:\\Temp\\run", "C:\\Temp\\run\\.test-isolation-state", options);
  assert.match(posix, /'test\/task-pin-actions\.vitest\.ts'/u);
  assert.match(powerShell, /'test\/task-pin-actions\.vitest\.ts'/u);
  assert.doesNotMatch(posix, /'packages\/gui\/test\/task-pin-actions\.vitest\.ts'/u);
  assert.doesNotMatch(powerShell, /'packages\/gui\/test\/task-pin-actions\.vitest\.ts'/u);
});

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-sync-"));
  const source = path.join(root, "source"),
    destination = path.join(root, "destination");
  mkdirSync(source);
  mkdirSync(destination);
  try {
    run({ source, destination });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root, relativePath) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${relativePath}\n`);
}

function seedRepository(root) {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Dispatch Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "dispatch@example.invalid"]);
  writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  for (const file of ["tools/kept.txt", "prettier.config.mjs", "future-root/space name.txt"]) write(root, file);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "test: seed sources"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "--allow-empty", "-m", "test: second generation"]);
}

function gitText(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function extractArchive(source, destination, files) {
  const archive = spawnSync("tar", sourceArchiveArgs(process.platform, source), {
    input: encodeFileList(files),
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, archive.stderr.toString());
  const extracted = spawnSync("tar", ["-xf", "-", "-C", destination], { input: archive.stdout });
  assert.equal(extracted.status, 0, extracted.stderr.toString());
}

function syncWithRsync(source, destination, files) {
  const result = spawnSync("rsync", sourceRsyncArgs(source, `${destination}/`), {
    input: encodeFileList(files),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function encodeFileList(files) {
  return Buffer.from(files.length === 0 ? "" : `${files.join("\0")}\0`);
}

function toolVersion(command) {
  return execFileSync(command, ["--version"], { encoding: "utf8" }).split(/\r?\n/u)[0];
}

const queueSkip =
  process.platform === "win32"
    ? "requires POSIX fork, process-group signals and kernel flock semantics"
    : spawnSync("python3", ["--version"]).error?.code === "ENOENT"
      ? "requires Python 3 for the Ubuntu target admission owner"
      : false;

test(
  "target admission bounds independent producers, queues FIFO, and reaps cancellation/crash",
  { skip: queueSkip, timeout: 20000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-queue-"));
    const jobs = [];
    function start(index) {
      const workspace = path.join(root, `harness-test-isolation-${index}`);
      // exec exposes the actual target supervisor PID for the SIGKILL case.
      const child = spawn("sh", ["-c", `exec ${ubuntuQueueCommand(workspace)}`], {
        env: { ...process.env, HOME: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        errors = "";
      const waiters = [];
      const events = [];
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        let newline;
        while ((newline = output.indexOf("\n")) !== -1) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (!line.startsWith("[test-isolation-queue] ")) continue;
          const event = JSON.parse(line.slice("[test-isolation-queue] ".length));
          events.push(event);
          for (const waiter of waiters) if (waiter.event === event.event) waiter.resolve(event);
        }
      });
      const closed = new Promise((resolve) =>
        child.on("close", (code, signal) => {
          resolve({ code, signal, errors });
          for (const waiter of waiters)
            waiter.reject(new Error(`target closed: code=${code} signal=${signal} ${errors}`));
        }),
      );
      function observe(event) {
        const found = events.find((entry) => entry.event === event);
        return found
          ? Promise.resolve(found)
          : new Promise((resolve, reject) => waiters.push({ event, resolve, reject }));
      }
      const job = { child, workspace, observe, closed, events };
      jobs.push(job);
      return job;
    }
    try {
      for (let index = 0; index < 4; index++) {
        const job = start(index);
        assert.equal((await job.observe("admitted")).capacity, 4);
        job.child.stdin.write(`${JSON.stringify("sleep 1000")}\n`);
        await job.observe("running");
      }
      const queued = start(4);
      assert.equal((await queued.observe("waiting")).position, 1);
      const cancelled = start(5);
      assert.equal((await cancelled.observe("waiting")).position, 2);
      cancelled.child.stdin.end();
      assert.equal((await cancelled.closed).code, 130);
      assert.equal(existsSync(cancelled.workspace), false);
      jobs[0].child.kill("SIGKILL");
      assert.equal((await jobs[0].closed).signal, "SIGKILL");
      await queued.observe("admitted");
      assert.equal(existsSync(jobs[0].workspace), false);
      const childPid = jobs[0].events.find((entry) => entry.event === "running").child_pid;
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      queued.child.stdin.write(`${JSON.stringify("exit 7")}\n`);
      assert.equal((await queued.observe("finished")).code, 7);
      queued.child.stdin.end();
      assert.equal((await queued.closed).code, 7);
      for (const job of jobs.slice(1, 4)) {
        job.child.stdin.end();
        assert.equal((await job.closed).code, 130);
        assert.equal(existsSync(job.workspace), false);
      }
      assert.equal(existsSync(queued.workspace), false);
      assert.deepEqual(readdirSync(path.join(root, ".cache/harness-test-isolation-queue")), ["admission.lock"]);
    } finally {
      for (const job of jobs) job.child.stdin.end();
      await Promise.all(jobs.map((job) => job.closed));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  serverQueueCommand,
  parseDispatchArgs,
  posixTestScript,
  powerShellTestScript,
  sourceArchiveArgs,
  sourceFileList,
  sourceRootFromCwd,
  prepareSource,
  testRunnerArgs,
  untrackedSelectionError,
} from "./dispatch-isolated-test.mjs";

const rsyncSkip = (() => {
  const probe = spawnSync("rsync", ["--version"], { encoding: "utf8" });
  return probe.error?.code === "ENOENT"
    ? "requires the rsync executable; Windows isolation uses the tar archive path"
    : false;
})();

test("dispatcher defaults to server and requires exactly one test selector", () => {
  assert.deepEqual(parseDispatchArgs(["--tier", "integration"]), {
    target: "server",
    tier: "integration",
    file: undefined,
    coverage: undefined,
  });
  assert.throws(() => parseDispatchArgs([]), /choose exactly one/u);
  assert.throws(() => parseDispatchArgs(["--tier", "fast", "--file", "tools/a.test.mjs"]), /choose exactly one/u);
});

test("dispatcher accepts all isolated targets and validates exact file paths", () => {
  for (const target of ["server", "windows"]) {
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
  for (const retired of ["ubuntu", "docker"])
    assert.throws(() => parseDispatchArgs(["--target", retired, "--tier", "fast"]), /unknown target/u);
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
    target: "server",
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
  assert.match(posix, /node tools\/isolated-test-dependencies\.mjs/u);
  assert.match(posix, /test-hermetic-preflight\.mjs --user-root '\/tmp\/run\/.test-isolation-state'/u);
  assert.match(posix, /HARNESS_DAEMON_USER_ROOT='\/tmp\/run\/.test-isolation-state'/u);

  const powerShell = powerShellTestScript("C:\\Temp\\run", "C:\\Temp\\run\\.test-isolation-state", options);
  assert.match(powerShell, /node tools\/isolated-test-dependencies\.mjs/u);
  assert.doesNotMatch(posix, /npm ci/u);
  assert.doesNotMatch(powerShell, /npm ci/u);
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
      ? "requires Python 3 for the server target admission owner"
      : false;

test(
  "target admission bounds independent producers, queues FIFO, and reaps cancellation/crash",
  { skip: queueSkip, timeout: 20000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-queue-"));
    const config = { ...JSON.parse(readFileSync(new URL("./isolated-test-server.json", import.meta.url))), root };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
    installFakeDocker(root);
    const jobs = [];
    function start(index, pauseCreate = false) {
      const workspace = path.join(root, "runs", `harness-test-isolation-${index}`);
      // exec exposes the actual target supervisor PID for the SIGKILL case.
      const child = spawn(
        "sh",
        ["-c", `exec ${serverQueueCommand(path.basename(workspace), path.join(root, "config.json"))}`],
        {
          env: {
            ...process.env,
            HOME: root,
            PATH: `${root}${path.delimiter}${process.env.PATH}`,
            FAKE_DOCKER_ROOT: root,
            ...(pauseCreate ? { FAKE_DOCKER_PAUSE_CREATE: "1" } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
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
      for (let index = 0; index < 3; index++) {
        const job = start(index);
        assert.equal((await job.observe("admitted")).capacity, 3);
        job.child.stdin.write(queueInput("sleep 1000"));
        await job.observe("running");
      }
      const queued = start(3);
      assert.equal((await queued.observe("waiting")).position, 1);
      const cancelled = start(4);
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
      queued.child.stdin.write(queueInput("exit 7"));
      assert.equal((await queued.observe("finished")).code, 7);
      queued.child.stdin.end();
      assert.equal((await queued.closed).code, 7);
      for (const job of jobs.slice(1, 3)) {
        job.child.stdin.end();
        assert.equal((await job.closed).code, 130);
        assert.equal(existsSync(job.workspace), false);
      }
      assert.equal(existsSync(queued.workspace), false);
      const operations = readFileSync(path.join(root, "docker.log"), "utf8").trim().split("\n").map(JSON.parse);
      for (const create of operations.filter((args) => args[0] === "create")) {
        assert.equal(create[create.indexOf("--cpus") + 1], "4");
        assert.equal(create[create.indexOf("--memory") + 1], "8g");
        assert.equal(create[create.indexOf("--memory-swap") + 1], "8g");
        assert.equal(create.includes("--init"), true);
      }
      assert.equal(operations.filter((args) => args[0] === "rm").length, 4);
      assert.deepEqual(readdirSync(path.join(root, "containers")), []);
      assert.deepEqual(readdirSync(path.join(root, "queue")), ["admission.lock"]);
      const upload = start(5);
      await upload.observe("admitted");
      upload.child.stdin.write("1048576\npartial-upload");
      await upload.observe("uploading");
      upload.child.kill("SIGKILL");
      assert.equal((await upload.closed).signal, "SIGKILL");
      assert.equal(existsSync(upload.workspace), false);
      const entered = new Promise((resolve) => {
        const watcher = watch(root, () => {
          if (existsSync(path.join(root, "create-entered"))) {
            watcher.close();
            resolve();
          }
        });
      });
      const creation = start(6, true);
      await creation.observe("admitted");
      creation.child.stdin.write(queueInput("sleep 1000"));
      await entered;
      creation.child.kill("SIGKILL");
      assert.equal(existsSync(creation.workspace), true);
      writeFileSync(path.join(root, "create-release"), "");
      assert.equal((await creation.closed).signal, "SIGKILL");
      assert.equal(existsSync(creation.workspace), false);
      assert.deepEqual(readdirSync(path.join(root, "containers")), []);
      assert.deepEqual(readdirSync(path.join(root, "queue")), ["admission.lock"]);
    } finally {
      for (const job of jobs) job.child.stdin.end();
      await Promise.all(jobs.map((job) => job.closed));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function installFakeDocker(root) {
  mkdirSync(path.join(root, "containers"));
  writeFileSync(
    path.join(root, "docker"),
    `#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['FAKE_DOCKER_ROOT'])
args = sys.argv[1:]
with open(root / 'docker.log', 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] == 'create':
    if os.environ.get('FAKE_DOCKER_PAUSE_CREATE'):
        (root / 'create-entered').touch()
        while not (root / 'create-release').exists(): time.sleep(0.01)
    (root / 'containers' / args[args.index('--name') + 1]).write_text(args[-1])
elif args[0] == 'start':
    script = (root / 'containers' / args[-1]).read_text()
    if os.environ.get('FAKE_DOCKER_IMMEDIATE'):
        workspace = root / 'runs' / args[-1]
        (workspace / '.test-coverage').mkdir()
        (workspace / '.test-coverage' / 'lcov.info').write_text('TN:remote-fixture')
        print('fixture-test-output', flush=True)
        sys.exit(int(os.environ['FAKE_DOCKER_IMMEDIATE']))
    if script == 'exit 7': sys.exit(7)
    while True: time.sleep(1)
elif args[0] == 'container':
    name = args[-1].removeprefix('name=^/').removesuffix('$')
    if (root / 'containers' / name).exists(): print(name)
elif args[0] == 'rm':
    if (root / 'fail-cleanup').exists(): sys.exit(19)
    (root / 'containers' / args[-1]).unlink()
else: sys.exit(23)
`,
    { mode: 0o755 },
  );
}

for (const privatePath of ["harness/secret.txt", ".harness-private/secret.txt", "AGENTS.md", "CLAUDE.md"]) {
  test(`outbound snapshot rejects tracked private path ${privatePath}`, () => {
    withFixture(({ source }) => {
      seedRepository(source);
      write(source, privatePath);
      execFileSync("git", ["-C", source, "add", "-f", privatePath]);
      assert.throws(() => prepareSource(source, path.join(source, "snapshot")), /private source path/u);
    });
  });
}

test("outbound snapshot rejects private history even after its path is deleted", () => {
  withFixture(({ source }) => {
    seedRepository(source);
    write(source, "harness/secret.txt");
    execFileSync("git", ["-C", source, "add", "-f", "harness/secret.txt"]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "test: private history"]);
    rmSync(path.join(source, "harness"), { recursive: true });
    execFileSync("git", ["-C", source, "add", "-u"]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "test: delete private path"]);
    assert.throws(() => prepareSource(source, path.join(source, "snapshot")), /private source path/u);
  });
});

for (const linkTarget of ["../outside.txt", "harness/secret.txt"]) {
  test(
    `outbound snapshot rejects source link to ${linkTarget}`,
    {
      skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
    },
    () => {
      withFixture(({ source }) => {
        seedRepository(source);
        write(source, linkTarget);
        symlinkSync(linkTarget, path.join(source, "link"));
        execFileSync("git", ["-C", source, "add", "link"]);
        assert.throws(
          () => prepareSource(source, path.join(source, "snapshot")),
          /private source path|leaves repository/u,
        );
      });
    },
  );
}

test(
  "cleanup failure is reported and retains admission until a subsequent owner cleans it",
  { skip: queueSkip, timeout: 10000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-queue-cleanup-"));
    const configPath = path.join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ ...JSON.parse(readFileSync(new URL("./isolated-test-server.json", import.meta.url))), root }),
    );
    installFakeDocker(root);
    writeFileSync(path.join(root, "fail-cleanup"), "");
    async function run(id, script) {
      const child = spawn("sh", ["-c", `exec ${serverQueueCommand(id, configPath)}`], {
        env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_ROOT: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        errors = "",
        sent = false;
      child.stdout.on("data", (data) => {
        output += data;
        if (!sent && output.includes('"event": "admitted"')) {
          sent = true;
          if (script) {
            child.stdin.write(queueInput(script));
          } else child.stdin.end();
        }
        if (output.includes('"event": "finished"')) child.stdin.end();
      });
      child.stderr.on("data", (data) => {
        errors += data;
      });
      return new Promise((resolve) => child.on("close", (code) => resolve({ code, output, errors })));
    }
    try {
      const failed = await run("harness-test-isolation-failed", "exit 7");
      assert.equal(failed.code, 1);
      assert.match(failed.errors, /isolation reaper failed|CalledProcessError/u);
      assert.equal(readdirSync(path.join(root, "queue")).length, 2);
      assert.equal(existsSync(path.join(root, "runs/harness-test-isolation-failed")), true);
      unlinkSync(path.join(root, "fail-cleanup"));
      const next = await run("harness-test-isolation-next");
      assert.equal(next.code, 130);
      assert.deepEqual(readdirSync(path.join(root, "containers")), []);
      assert.deepEqual(readdirSync(path.join(root, "runs")), []);
      assert.deepEqual(readdirSync(path.join(root, "queue")), ["admission.lock"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const code of [0, 7, "killed"]) {
  test(
    `dispatcher streams remote output and returns exit ${code} with owned cleanup`,
    { skip: queueSkip, timeout: 20000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-remote-"));
      writeFileSync(
        path.join(root, "config.json"),
        JSON.stringify({ ...JSON.parse(readFileSync(new URL("./isolated-test-server.json", import.meta.url))), root }),
      );
      installFakeDocker(root);
      writeFileSync(
        path.join(root, "ssh"),
        `#!/usr/bin/env python3
import os, sys
command = sys.argv[-1].replace('/srv/harness-tests/config.json', os.environ['FAKE_DOCKER_ROOT'] + '/config.json')
os.execlp('sh', 'sh', '-c', command)
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(root, "rsync"),
        `#!/usr/bin/env python3
import os, pathlib, shutil, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['FAKE_DOCKER_ROOT'])
def remote(value):
    return root / value.split('/srv/harness-tests/', 1)[1]
if '--files-from=-' in args:
    source, target = pathlib.Path(args[-2]), remote(args[-1])
    for name in sys.stdin.buffer.read().decode().split('\\0'):
        if not name: continue
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, destination)
else: shutil.copy2(remote(args[-2]), args[-1])
`,
        { mode: 0o755 },
      );
      try {
        const coverage = path.join(root, "returned.lcov");
        const child = spawn(
          process.execPath,
          [
            "tools/dispatch-isolated-test.mjs",
            "--file",
            "tools/dispatch-isolated-test.test.mjs",
            "--coverage",
            coverage,
          ],
          {
            env: {
              ...process.env,
              PATH: `${root}${path.delimiter}${process.env.PATH}`,
              FAKE_DOCKER_ROOT: root,
              ...(code === "killed" ? {} : { FAKE_DOCKER_IMMEDIATE: String(code) }),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "",
          errors = "";
        child.stdout.on("data", (data) => {
          output += data;
          if (code === "killed" && output.includes('"event": "running"')) child.kill("SIGKILL");
        });
        child.stderr.on("data", (data) => {
          errors += data;
        });
        const result = await new Promise((resolve) => child.on("close", resolve));
        assert.equal(result, code === "killed" ? null : code, errors);
        if (code !== "killed") assert.match(output, /fixture-test-output/u);
        assert.match(output, /target=server/u);
        assert.deepEqual(readdirSync(path.join(root, "containers")), []);
        assert.deepEqual(readdirSync(path.join(root, "runs")), []);
        assert.deepEqual(readdirSync(path.join(root, "queue")), ["admission.lock"]);
        if (code === 0) assert.equal(readFileSync(coverage, "utf8"), "TN:remote-fixture");
        else assert.equal(existsSync(coverage), false);
        const create = readFileSync(path.join(root, "docker.log"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse)
          .find((args) => args[0] === "create");
        if (code !== "killed") {
          assert.match(create.at(-1), /test-hermetic-preflight/u);
          assert.match(create.at(-1), /HARNESS_DAEMON_USER_ROOT='\/workspace\/.test-isolation-state'/u);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("snapshot reflects unstaged tracked deletions", () => {
  withFixture(({ source }) => {
    seedRepository(source);
    unlinkSync(path.join(source, "tools/kept.txt"));
    assert.equal(sourceFileList(source).includes("tools/kept.txt"), false);
    const snapshot = path.join(source, "snapshot");
    const files = prepareSource(source, snapshot);
    assert.equal(files.includes("tools/kept.txt"), false);
    assert.match(gitText(snapshot, ["status", "--porcelain"]), /D tools\/kept.txt/u);
  });
});

function queueInput(script) {
  const archive = spawnSync("tar", ["-cf", "-", "-T", "-"], { input: "" });
  assert.equal(archive.status, 0, archive.stderr.toString());
  return Buffer.concat([
    Buffer.from(`${archive.stdout.length}\n`),
    archive.stdout,
    Buffer.from(`${JSON.stringify(script)}\n`),
  ]);
}

// Archive equivalence fixture only; the production server uploads over its control pipe.
function sourceRsyncArgs(sourceRoot, destination) {
  return ["-a", "--delete", "--from0", "--files-from=-", `${sourceRoot}/`, destination];
}

test("outbound snapshot checks every exported merge parent for private history", () => {
  withFixture(({ source }) => {
    seedRepository(source);
    const branch = gitText(source, ["branch", "--show-current"]);
    execFileSync("git", ["-C", source, "checkout", "--quiet", "-b", "private-parent"]);
    write(source, "harness/secret.txt");
    execFileSync("git", ["-C", source, "add", "-f", "harness/secret.txt"]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "test: private second parent"]);
    execFileSync("git", ["-C", source, "checkout", "--quiet", branch]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "--allow-empty", "-m", "test: public first parent"]);
    execFileSync("git", ["-C", source, "merge", "--quiet", "--no-commit", "--no-ff", "private-parent"], {
      stdio: "ignore",
    });
    rmSync(path.join(source, "harness"), { recursive: true });
    execFileSync("git", ["-C", source, "add", "-u"]);
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "test: public merge"]);
    assert.throws(() => prepareSource(source, path.join(source, "snapshot")), /private source path/u);
  });
});

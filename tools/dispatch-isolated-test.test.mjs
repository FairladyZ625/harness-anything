// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseDispatchArgs,
  posixTestScript,
  powerShellTestScript,
  sourceArchiveArgs,
  sourceFileList,
  sourceRootAllowlist,
  sourceRsyncArgs,
  testRunnerArgs,
} from "./dispatch-isolated-test.mjs";

test("dispatcher defaults to Ubuntu and requires exactly one test selector", () => {
  assert.deepEqual(parseDispatchArgs(["--tier", "integration"]), {
    target: "ubuntu",
    tier: "integration",
    file: undefined,
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
      },
    );
  }
  assert.throws(() => parseDispatchArgs(["--target", "windows-vm", "--tier", "integration"]), /unknown target/u);
  assert.throws(() => parseDispatchArgs(["--file", "../outside.test.mjs"]), /repository-relative/u);
});

test("dispatcher builds runner commands for either supported selector", () => {
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
});

test("source root allowlist contains only current test inputs", () => {
  assert.deepEqual(sourceRootAllowlist, [
    ".github",
    ".gitignore",
    "README.md",
    "docs-release",
    "eslint.config.mjs",
    "package-lock.json",
    "package.json",
    "packages",
    "scripts",
    "skills",
    "tools",
    "tsconfig.json",
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

test("source file discovery keeps worktree changes but drops ignored output and unknown roots", () => {
  withFixture(({ source }) => {
    execFileSync("git", ["-C", source, "init", "--quiet"]);
    writeFileSync(path.join(source, ".gitignore"), "dist/\n");
    write(source, "packages/tracked.ts");
    write(source, "packages/untracked.ts");
    write(source, "packages/gui/dist/ignored.js");
    write(source, "future-private/untracked.txt");
    execFileSync("git", ["-C", source, "add", ".gitignore", "packages/tracked.ts"]);
    assert.deepEqual(sourceFileList(source), [".gitignore", "packages/tracked.ts", "packages/untracked.ts"]);
  });
});

test("tar copies the complete allowlist and rejects every other repository root", () => {
  withFixture(({ source, destination }) => {
    seedCompletePolicyFixture(source);
    extractArchive(source, destination, sourceRootAllowlist);
    assert.deepEqual(rootEntries(destination), ["packages", "tools"]);
    console.log(`[archive-implementation] ${toolVersion("tar")}`);
  });
});

test("tar file lists preserve a nested harness directory", () => {
  withFixture(({ source, destination }) => {
    write(source, "harness/root.txt");
    write(source, "tmp/benchmarks/codex-hostnet-patch/harness/nested.txt");
    extractArchive(source, destination, ["tmp"]);
    assert.equal(existsSync(path.join(destination, "harness")), false);
    assert.equal(existsSync(path.join(destination, "tmp/benchmarks/codex-hostnet-patch/harness/nested.txt")), true);
  });
});

test("rsync copies the complete allowlist and rejects every other repository root", () => {
  withFixture(({ source, destination }) => {
    seedCompletePolicyFixture(source);
    syncWithRsync(source, destination, sourceRootAllowlist);
    assert.deepEqual(rootEntries(destination), ["packages", "tools"]);
    console.log(`[rsync-implementation] ${toolVersion("rsync")}`);
  });
});

test("rsync file lists preserve a nested harness directory", () => {
  withFixture(({ source, destination }) => {
    write(source, "harness/root.txt");
    write(source, "tmp/benchmarks/codex-hostnet-patch/harness/nested.txt");
    syncWithRsync(source, destination, ["tmp"]);
    assert.equal(existsSync(path.join(destination, "harness")), false);
    assert.equal(existsSync(path.join(destination, "tmp/benchmarks/codex-hostnet-patch/harness/nested.txt")), true);
  });
});

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

function seedCompletePolicyFixture(root) {
  for (const entry of [
    "harness",
    ".harness",
    ".harness-private",
    ".worktrees",
    "tmp",
    ".harness-old-generation-20260818",
    "harness-old-generation-20260818",
    "future-private",
  ])
    write(root, `${entry}/excluded.txt`);
  write(root, "packages/kept.txt");
  write(root, "tools/kept.txt");
}

function extractArchive(source, destination, allowedRoots) {
  const files = sourceFileList(source, allowedRoots, fixtureFiles(source));
  const archive = spawnSync("tar", sourceArchiveArgs(process.platform, source), {
    input: encodeFileList(files),
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, archive.stderr.toString());
  const extracted = spawnSync("tar", ["-xf", "-", "-C", destination], { input: archive.stdout });
  assert.equal(extracted.status, 0, extracted.stderr.toString());
}

function syncWithRsync(source, destination, allowedRoots) {
  const files = sourceFileList(source, allowedRoots, fixtureFiles(source));
  const result = spawnSync("rsync", sourceRsyncArgs(source, `${destination}/`), {
    input: encodeFileList(files),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixtureFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...fixtureFiles(root, target));
    else files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files;
}

function encodeFileList(files) {
  return Buffer.from(files.length === 0 ? "" : `${files.join("\0")}\0`);
}

function rootEntries(root) {
  return readdirSync(root).sort((left, right) => left.localeCompare(right));
}

function toolVersion(command) {
  return execFileSync(command, ["--version"], { encoding: "utf8" }).split(/\r?\n/u)[0];
}

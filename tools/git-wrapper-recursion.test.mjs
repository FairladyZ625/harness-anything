// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnWithDeadline } from "./fixtures/deadline-spawn.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const gitShell = process.platform === "win32" ? findGitShell() : "sh";
const posixShellSkip = process.platform === "win32" && gitShell === null
  ? "requires Git for Windows' POSIX shell to execute the repository hook wrapper"
  : false;

// The wrapper honours a leading `-C <dir>` by cd-ing before it decides which repository a
// command targets. A relative PATH entry that named nothing at the shell cwd is therefore
// nothing for the self-exclusion filter to match, yet it names a real directory after that
// cd — including the wrapper's own `tools/git-hooks`, which is how the wrapper reached
// itself. The decoy stands in for that directory: reaching it at all is the defect.
test("the git wrapper resolves git before -C, so no PATH entry can capture it after the cd", { skip: posixShellSkip }, async (context) => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hook-post-cd-capture-"))),
    root = path.join(parent, "repo"),
    decoy = path.join(root, "tools", "git-hooks"),
    wrapper = path.join(parent, "wrapper"),
    captured = path.join(parent, "captured");
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(decoy, { recursive: true });
  mkdirSync(wrapper);
  installExecutable(path.join(repositoryRoot, "tools", "git-hooks", "git"), path.join(wrapper, "git"));
  writeExecutable(
    path.join(decoy, "git"),
    `#!/usr/bin/env sh\nprintf 'captured\\n' >> ${JSON.stringify(shellPath(captured))}\nexit 1\n`,
  );
  execFileSync("git", ["-C", root, "init", "-q"]);

  const result = await spawnGitWithDeadline(["-C", root, "rev-parse", "--show-toplevel"], {
    cwd: parent,
    env: {
      ...process.env,
      PATH: shellPathEntries([path.join("tools", "git-hooks"), wrapper, ...(process.env.PATH ?? "").split(path.delimiter)]),
    },
  });

  assert.equal(result.timedOut, false, `git wrapper did not terminate\n${result.stderr}`);
  assert.equal(
    existsSync(captured),
    false,
    "wrapper resolved git through a PATH entry that only named a directory after its -C cd",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout.trim()), root);
});

// An upstream PATH entry can lead back into the wrapper: a shim that execs `which git`
// (the shape of the git-version stub in packages/kernel/test/store/ledger-maintenance.test.ts)
// or a second copy of the wrapper installed into a temporary repository ahead of the
// canonical one. Filtering out only its own directory left the wrapper delegating to that
// upstream entry, so every repository probe forked the other party, which forked the wrapper
// again, without bound: the 2026-09-03 fork exhaustions. Delegating only downstream of its
// own PATH entry ends the cycle; the shim must be visited exactly once.
test("the git wrapper delegates only downstream of its own PATH entry, so an upstream shim cannot cycle back into it", { skip: posixShellSkip }, async (context) => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hook-upstream-shim-"))),
    root = path.join(parent, "repo"),
    wrapper = path.join(parent, "wrapper"),
    shim = path.join(parent, "shim"),
    visits = path.join(parent, "visits");
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(root);
  mkdirSync(wrapper);
  mkdirSync(shim);
  installExecutable(path.join(repositoryRoot, "tools", "git-hooks", "git"), path.join(wrapper, "git"));
  writeExecutable(
    path.join(shim, "git"),
    `#!/usr/bin/env sh\nprintf 'visit\\n' >> ${JSON.stringify(shellPath(visits))}\nexec ${JSON.stringify(shellPath(path.join(wrapper, "git")))} "$@"\n`,
  );
  execFileSync("git", ["-C", root, "init", "-q"]);

  // A per-user process ceiling keeps a regression from exhausting the machine; a green
  // wrapper never approaches it.
  const result = await spawnWithDeadline(
    gitShell,
    ["-c", 'ulimit -u $(( $(ps -U "$(id -un)" -o pid= | wc -l) + 256 )); script="$1"; shift; exec "$script" "$@"', "sh", shellPath(path.join(shim, "git")), "-C", root, "rev-parse", "--show-toplevel"],
    {
      cwd: parent,
      env: { ...process.env, PATH: shellPathEntries([shim, wrapper, ...(process.env.PATH ?? "").split(path.delimiter)]) },
    },
  );

  assert.equal(result.timedOut, false, `git wrapper did not terminate\n${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout.trim()), root);
  assert.equal(readFileSync(visits, "utf8"), "visit\n", "the wrapper delegated back upstream into the shim");
});

function findGitShell() {
  const result = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" });
  for (const gitPath of result.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const root = path.resolve(path.dirname(gitPath), "..");
    for (const candidate of [path.join(root, "bin", "sh.exe"), path.join(root, "usr", "bin", "sh.exe")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function shellPath(value) {
  if (process.platform !== "win32") return value;
  const normalized = value.replaceAll("\\", "/");
  return /^[A-Za-z]:\//u.test(normalized) ? `/${normalized[0].toLowerCase()}${normalized.slice(2)}` : normalized;
}

function shellPathEntries(entries) {
  return entries.filter((entry) => entry.length > 0).map(shellPath).join(process.platform === "win32" ? ":" : path.delimiter);
}

function spawnGitWithDeadline(args, options) {
  return process.platform === "win32"
    ? spawnWithDeadline(gitShell, ["-c", 'exec git "$@"', "sh", ...args], options)
    : spawnWithDeadline("git", args, options);
}

function installExecutable(source, destination) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  installWindowsShim(destination);
}

function writeExecutable(destination, body) {
  writeFileSync(destination, body);
  chmodSync(destination, 0o755);
  installWindowsShim(destination);
}

function installWindowsShim(destination) {
  if (process.platform !== "win32") return;
  const script = path.basename(destination);
  writeFileSync(`${destination}.cmd`, `@echo off\r\n"${gitShell}" "%~dp0${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
}

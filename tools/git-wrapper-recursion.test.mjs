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

// The wrapper honours a leading `-C <dir>` by cd-ing before it decides which repository a
// command targets. A relative PATH entry that named nothing at the shell cwd is therefore
// nothing for the self-exclusion filter to match, yet it names a real directory after that
// cd — including the wrapper's own `tools/git-hooks`, which is how the wrapper reached
// itself. The decoy stands in for that directory: reaching it at all is the defect.
test("the git wrapper resolves git before -C, so no PATH entry can capture it after the cd", async (context) => {
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
    `#!/usr/bin/env sh\nprintf 'captured\\n' >> ${JSON.stringify(captured)}\nexit 1\n`,
  );
  execFileSync("git", ["-C", root, "init", "-q"]);

  const result = await spawnWithDeadline("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    cwd: parent,
    env: {
      ...process.env,
      PATH: [path.join("tools", "git-hooks"), wrapper, process.env.PATH ?? ""].join(path.delimiter),
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
test("the git wrapper delegates only downstream of its own PATH entry, so an upstream shim cannot cycle back into it", async (context) => {
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
    `#!/usr/bin/env sh\nprintf 'visit\\n' >> ${JSON.stringify(visits)}\nexec ${JSON.stringify(path.join(wrapper, "git"))} "$@"\n`,
  );
  execFileSync("git", ["-C", root, "init", "-q"]);

  // A per-user process ceiling keeps a regression from exhausting the machine; a green
  // wrapper never approaches it.
  const result = await spawnWithDeadline(
    "sh",
    ["-c", 'ulimit -u $(( $(ps -U "$(id -un)" -o pid= | wc -l) + 256 )); exec git "$@"', "sh", "-C", root, "rev-parse", "--show-toplevel"],
    {
      cwd: parent,
      env: { ...process.env, PATH: [shim, wrapper, process.env.PATH ?? ""].join(path.delimiter) },
    },
  );

  assert.equal(result.timedOut, false, `git wrapper did not terminate\n${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout.trim()), root);
  assert.equal(readFileSync(visits, "utf8"), "visit\n", "the wrapper delegated back upstream into the shim");
});

function installExecutable(source, destination) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function writeExecutable(destination, body) {
  writeFileSync(destination, body);
  chmodSync(destination, 0o755);
}

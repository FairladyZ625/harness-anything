// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function installExecutable(source, destination) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function writeExecutable(destination, body) {
  writeFileSync(destination, body);
  chmodSync(destination, 0o755);
}

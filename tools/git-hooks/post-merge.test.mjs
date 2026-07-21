// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("./post-merge", import.meta.url));

test("post-merge delegates the observed commit range to the runtime build helper", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-post-merge-hook-"));
  try {
    run("git", ["init", "-q"], root);
    run("git", ["config", "user.email", "hook-test@example.com"], root);
    run("git", ["config", "user.name", "Hook Test"], root);
    writeFileSync(path.join(root, "README.md"), "one\n", "utf8");
    run("git", ["add", "README.md"], root);
    run("git", ["commit", "-qm", "one"], root);
    const previousHead = run("git", ["rev-parse", "HEAD"], root).trim();
    writeFileSync(path.join(root, "README.md"), "two\n", "utf8");
    run("git", ["commit", "-qam", "two"], root);
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${previousHead}\n`, "utf8");

    const binDir = path.join(root, "bin");
    const recordPath = path.join(root, "node-args.txt");
    mkdirSync(binDir);
    const fakeNode = path.join(binDir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$POST_MERGE_RECORD\"\n", "utf8");
    chmodSync(fakeNode, 0o755);

    execFileSync("sh", [hookPath], {
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, POST_MERGE_RECORD: recordPath },
      stdio: "pipe"
    });

    assert.equal(
      readFileSync(recordPath, "utf8").trim(),
      `tools/post-merge-runtime-refresh.mjs ${previousHead} HEAD`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

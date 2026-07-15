// harness-test-tier: fast
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Git fixture identity is explicit under the hermetic test runner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-xd7-git-fixture-"));
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", [
      "-C", root,
      "-c", "user.email=harness@example.test",
      "-c", "user.name=Harness Test",
      "commit", "--allow-empty", "-m", "fixture"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

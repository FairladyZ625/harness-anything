import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

if (
  process.env.HARNESS_RUNNER_STALL_FIXTURE === "post-complete-wedge"
  || process.env.HARNESS_RUNNER_STALL_FIXTURE === "post-complete-close-before-reap"
) {
  process.on("exit", () => {
    process.title = "ha-node-test-wedge tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}

test("post-complete wedge fixture passes before native-style exit deadlock", () => {});

test("publication reader fixture can intentionally leave one reader open", async () => {
  const root = process.env.HARNESS_PUBLICATION_READER_FIXTURE_ROOT;
  if (!root) return;
  const { readPublicationGitObject } = await import(
    "../../../packages/daemon/src/authority/production/publication-object-reader.ts"
  );
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Harness Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "harness@example.test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  await readPublicationGitObject(root, "HEAD:seed.txt");
});

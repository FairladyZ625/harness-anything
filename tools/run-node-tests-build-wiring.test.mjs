// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function runnerFixture(linked = true) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runner-build-wire-"));
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  for (const file of [
    "run-node-tests.mjs",
    "node-test-runner-lib.mjs",
    "test-tier-manifest.mjs",
    "tool-command-contract.mjs",
    "integration-test-shards.mjs",
    "integration-test-weights.json",
    "test-quarantine.mjs",
    "test-quarantine.json",
    "node-test-file-activity-reporter.mjs",
    "node-test-observation-reporter.mjs",
    "node-test-stall-report.mjs",
    "node-test-daemon-owner.mjs",
  ]) {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    copyFileSync(new URL(file, import.meta.url), path.join(root, "tools", file));
  }
  if (linked) write(".git", "gitdir: /fixture/.git/worktrees/test\n");
  else mkdirSync(path.join(root, ".git"));
  write("package.json", JSON.stringify({ private: true, workspaces: ["packages/daemon"] }));
  write("package-lock.json", "{}");
  write(
    "packages/daemon/package.json",
    JSON.stringify({
      name: "@harness-anything/daemon",
      scripts: { build: "node scripts/build.mjs" },
    }),
  );
  write(
    "packages/daemon/scripts/build.mjs",
    `import fs from "node:fs";
fs.mkdirSync("dist", { recursive: true });
fs.appendFileSync("dist/builds.txt", "build\\n");
fs.writeFileSync("dist/build-id.txt", "current");`,
  );
  write("packages/daemon/scripts/copy-assets.mjs", "");
  write("packages/daemon/tsconfig.build.json", "{}");
  write("packages/daemon/src/input.ts", "export const version = 1;\n");
  write("packages/preset/assets/fixture.json", "{}");
  write(
    "node_modules/typescript/bin/tsc",
    `console.log(${JSON.stringify(path.join(root, "packages/daemon/src/input.ts"))});`,
  );
  write(
    "packages/cli/test/entry.test.mjs",
    `// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const cli = "packages/cli/src/index.ts";
test("CLI entry sees the build before any test executes", () => {
  assert.equal(readFileSync("packages/daemon/dist/build-id.txt", "utf8"), "current", cli);
});`,
  );
  const env = { ...process.env, HARNESS_TEST_QUARANTINE: "skip" };
  delete env.NODE_TEST_CONTEXT;
  const run = (...extra) =>
    spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--file", "packages/cli/test/entry.test.mjs", ...extra], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
  return { root, write, run };
}

test("runner rebuilds a missing or stale daemon before CLI tests and reuses a fresh build", () => {
  const { root, write, run } = runnerFixture();
  try {
    const missing = run();
    assert.equal(missing.status, 0, missing.stdout + missing.stderr);
    assert.match(missing.stdout, /\[daemon-build\] built in/u);
    const fresh = run();
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /\[daemon-build\]/u);
    write("packages/daemon/dist/build-id.txt", "stale");
    const old = new Date(0);
    utimesSync(path.join(root, "packages/daemon/dist/build-id.txt"), old, old);
    const stale = run();
    assert.equal(stale.status, 0, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /\[daemon-build\] built in/u);
    assert.equal(readFileSync(path.join(root, "packages/daemon/dist/builds.txt"), "utf8"), "build\nbuild\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner list mode leaves builds alone and a stale main checkout refuses before tests", () => {
  const { root, run } = runnerFixture(false);
  try {
    const listed = run("--list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim(), "packages/cli/test/entry.test.mjs");
    const refused = run();
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /main checkout.*resident daemon/su);
    assert.doesNotMatch(refused.stdout, /CLI entry sees the build/u);
    assert.equal(existsSync(path.join(root, "packages/daemon/dist")), false);
    assert.equal(existsSync(path.join(root, "node_modules/.cache/harness-daemon-build.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

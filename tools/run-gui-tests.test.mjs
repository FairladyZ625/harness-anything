// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { collectGuiVitestFiles, guiVitestFilePattern } from "./gui-test-runner-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("collectGuiVitestFiles discovers nested vitest files as sorted repo-relative paths", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gui-discovery-"));
  try {
    const write = (relativePath) => {
      const target = path.join(root, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "export {};\n");
    };
    write("packages/gui/test/deep/nested.vitest.tsx");
    write("packages/gui/test/aaa.vitest.ts");
    write("packages/gui/test/sibling.vitest.tsx");
    write("packages/gui/test/not-vitest.test.ts");
    write("packages/gui/test/node_modules/ignored.vitest.ts");
    write("packages/gui/test/.hidden.vitest.ts");
    assert.deepEqual(await collectGuiVitestFiles(root), [
      "packages/gui/test/aaa.vitest.ts",
      "packages/gui/test/deep/nested.vitest.tsx",
      "packages/gui/test/sibling.vitest.tsx",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-gui-tests --list streams the dynamically discovered set", () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "tools/run-gui-tests.mjs"), "--list"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const listed = run.stdout.split("\n").filter(Boolean);
  assert.ok(listed.length > 0, "dynamic discovery must find the existing GUI suite");
  for (const file of listed) {
    assert.ok(file.startsWith("packages/gui/test/"), `discovered file outside the GUI test root: ${file}`);
    assert.ok(guiVitestFilePattern.test(file), `discovered file does not match the vitest pattern: ${file}`);
  }
});

test("run-gui-tests --list stays in lockstep with collectGuiVitestFiles", async () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "tools/run-gui-tests.mjs"), "--list"], {
    encoding: "utf8",
  });
  assert.deepEqual(run.stdout.split("\n").filter(Boolean), await collectGuiVitestFiles(repoRoot));
});

test("run-gui-tests rejects unknown options", () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "tools/run-gui-tests.mjs"), "--bogus"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown run-gui-tests option/u);
});

test("list output survives pipe backpressure without losing its tail", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gui-list-output-"));
  try {
    mkdirSync(path.join(root, "tools"));
    mkdirSync(path.join(root, "packages/gui/test"), { recursive: true });
    for (const file of ["run-gui-tests.mjs", "gui-test-runner-lib.mjs", "test-quarantine.mjs"])
      copyFileSync(path.join(repoRoot, "tools", file), path.join(root, "tools", file));
    const expected = Array.from(
      { length: 1024 },
      (_, i) => `packages/gui/test/${String(i).padStart(4, "0")}-${"x".repeat(160)}.vitest.ts`,
    );
    for (const file of expected) writeFileSync(path.join(root, file), "export {};\n");
    const runner = path.join(root, "tools/run-gui-tests.mjs");
    // The marker is after the real entrypoint. A forced exit bypasses it; a
    // natural exit lets the parent drain the deliberately paused stdout pipe.
    appendFileSync(runner, '\nprocess.stderr.write("listing-enqueued\\n");\n');
    const child = spawn(process.execPath, [runner, "--list"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stdout.pause();
    const exited = once(child, "exit"),
      closed = once(child, "close");
    await Promise.race([once(child.stderr, "data"), exited]);
    child.stdout.resume();
    const [code] = await closed;
    assert.equal(code, 0);
    const actual = output.trimEnd().split("\n");
    assert.equal(actual.length, expected.length, "stdout tail must be complete");
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

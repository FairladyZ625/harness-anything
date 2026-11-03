// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import test from "node:test";

const moduleUrl = new URL("../src/build-identity.ts", import.meta.url).href;

// The stamp is the daemon's answer to "which build are you": a packaged build stamps
// HARNESS_BUILD_COMMIT, and a source-tree run resolves the commit from git so a resident daemon
// can be compared against the tree it was started from. Each case loads a fresh module instance
// because the stamp is frozen at first use.
test("the build stamp prefers the packaged build stamp over the source tree", async () => {
  const previous = process.env.HARNESS_BUILD_COMMIT;
  process.env.HARNESS_BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
  try {
    const fresh = await import(`${moduleUrl}?case=stamped`);
    assert.equal(fresh.daemonBuildStamp().commit, "0123456789abcdef0123456789abcdef01234567");
  } finally {
    restore(previous);
  }
});

test("a source-tree run reports the serving tree's HEAD commit", async () => {
  const previous = process.env.HARNESS_BUILD_COMMIT,
    root = mkdtempSync(path.join(tmpdir(), "ha-source-identity-"));
  delete process.env.HARNESS_BUILD_COMMIT;
  try {
    for (const file of ["build-identity.ts", "process-text.ts"])
      cpSync(new URL(`../src/${file}`, import.meta.url), path.join(root, file));
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Build Identity Fixture"]);
    execFileSync("git", ["-C", root, "config", "user.email", "build-identity@example.invalid"]);
    execFileSync("git", ["-C", root, "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const fresh = await import(pathToFileURL(path.join(root, "build-identity.ts")).href);
    assert.equal(fresh.daemonBuildStamp().commit, head);
  } finally {
    restore(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loaded dist marker overrides both inherited environment and later disk rebuilds", async () => {
  const previous = process.env.HARNESS_BUILD_COMMIT,
    root = mkdtempSync(path.join(tmpdir(), "ha-dist-identity-")),
    dist = path.join(root, "dist"),
    source = path.join(dist, "daemon/src");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  for (const file of ["build-identity", "process-text"])
    writeFileSync(
      path.join(source, `${file}.js`),
      ts.transpileModule(readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
        },
      }).outputText,
    );
  writeFileSync(path.join(dist, "build-id.txt"), "fixed-a\n");
  process.env.HARNESS_BUILD_COMMIT = "foreign-environment";
  try {
    const loaded = await import(pathToFileURL(path.join(source, "build-identity.js")).href),
      observer = loaded.observeDaemonBuild();
    assert.equal(loaded.daemonBuildStamp().commit, "fixed-a");
    writeFileSync(path.join(dist, "build-id.txt"), "rebuilt-b\n");
    assert.deepEqual(observer.status(), {
      commit: "fixed-a",
      entry: "dist",
      loadedBuildId: "fixed-a",
      diskBuildId: "rebuilt-b",
      drifted: true,
    });
  } finally {
    restore(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

function restore(previous: string | undefined): void {
  if (previous === undefined) delete process.env.HARNESS_BUILD_COMMIT;
  else process.env.HARNESS_BUILD_COMMIT = previous;
}

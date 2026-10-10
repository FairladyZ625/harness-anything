// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheLimitBytes, dependencyInputs, prepareDependencies, treeBytes } from "./isolated-test-dependencies.mjs";

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dependency-cache-"));
  const cache = path.join(root, "cache");
  function workspace(name) {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "packages", "local"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
    writeFileSync(
      path.join(dir, "packages/local/package.json"),
      JSON.stringify({ name: "local", scripts: { prepare: "compile current source" } }),
    );
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "packages/local": {}, "node_modules/external": {} } }),
    );
    return dir;
  }
  try {
    return run({ root, cache, workspace });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function install(root, args) {
  if (args[0] === "ci") {
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules/value"), "installed");
    symlinkSync(
      path.join(root, "packages/local"),
      path.join(root, "node_modules/local"),
      process.platform === "win32" ? "junction" : "dir",
    );
    mkdirSync(path.join(root, "packages/local/node_modules"));
    writeFileSync(path.join(root, "packages/local/node_modules/nested"), "nested dependency");
  }
  writeFileSync(path.join(root, "packages/local/output"), readFileSync(path.join(root, "packages/local/source")));
}

test("cache copies isolate dependency writes, rebase workspace links and rebuild current source", () =>
  fixture(({ cache, workspace }) => {
    const first = workspace("first"),
      second = workspace("second");
    writeFileSync(path.join(first, "packages/local/source"), "first source");
    writeFileSync(path.join(second, "packages/local/source"), "second source");
    const calls = [];
    const record = (root, args) => {
      calls.push(args);
      install(root, args);
    };
    prepareDependencies(first, cache, record);
    writeFileSync(path.join(first, "node_modules/value"), "mutated by first test");
    writeFileSync(path.join(first, "packages/local/node_modules/nested"), "mutated nested");
    prepareDependencies(second, cache, record);
    assert.equal(readFileSync(path.join(second, "node_modules/value"), "utf8"), "installed");
    assert.equal(readFileSync(path.join(second, "packages/local/node_modules/nested"), "utf8"), "nested dependency");
    assert.equal(readFileSync(path.join(second, "node_modules/local/output"), "utf8"), "second source");
    assert.deepEqual(calls, [
      ["ci", "--no-audit", "--no-fund"],
      ["run", "prepare", "--workspace", "packages/local", "--ignore-scripts"],
    ]);
    assert.ok(treeBytes(path.join(cache, "current")) < cacheLimitBytes);
  }));

test("lock, manifest, runtime and effective npm configuration select distinct installations", () =>
  fixture(({ workspace }) => {
    const root = workspace("source");
    const key = () => dependencyInputs(root, ["linux", "arm64", "24", "11"], { omit: [] }).key;
    const original = key();
    assert.notEqual(dependencyInputs(root, ["win32", "x64", "24", "11"], { omit: [] }).key, original);
    assert.notEqual(dependencyInputs(root, ["linux", "arm64", "24", "11"], { omit: ["dev"] }).key, original);
    writeFileSync(path.join(root, "packages/local/package.json"), '{"name":"changed"}');
    assert.notEqual(key(), original);
    const manifestKey = key();
    writeFileSync(
      path.join(root, "package-lock.json"),
      '{"packages":{"":{},"packages/local":{},"node_modules/new":{}}}',
    );
    assert.notEqual(key(), manifestKey);
  }));

test("failed installs surface unchanged and a later owner discards partial publication", () =>
  fixture(({ cache, workspace }) => {
    const root = workspace("source");
    writeFileSync(path.join(root, "packages/local/source"), "source");
    const failure = new Error("install failed");
    assert.throws(
      () =>
        prepareDependencies(root, cache, () => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(existsSync(path.join(cache, "current")), false);
    mkdirSync(path.join(cache, "pending"));
    writeFileSync(path.join(cache, "pending/stale"), "partial");
    prepareDependencies(root, cache, install);
    assert.equal(existsSync(path.join(cache, "pending")), false);
    assert.equal(existsSync(path.join(cache, "current/stale")), false);
  }));

test("concurrent creators install once; a new lock replaces the retained generation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cache-concurrent-"));
  try {
    const cache = path.join(root, "cache");
    const module = new URL("./isolated-test-dependencies.mjs", import.meta.url).href;
    const workspaces = ["one", "two"].map((name) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}');
      writeFileSync(path.join(dir, "package-lock.json"), '{"packages":{"":{}}}');
      return dir;
    });
    const code = `import {prepareDependencies} from ${JSON.stringify(module)}; import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs'; import path from 'node:path'; prepareDependencies(process.argv[1],process.argv[2],(root,args)=>{appendFileSync(path.join(process.argv[2],'installs'),args[0]+'\\n'); mkdirSync(path.join(root,'node_modules')); writeFileSync(path.join(root,'node_modules/value'),'installed');});`;
    const codes = await Promise.all(
      workspaces.map(
        (dir) =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", code, dir, cache], {
              stdio: ["ignore", "ignore", "inherit"],
            });
            child.on("error", reject);
            child.on("close", resolve);
          }),
      ),
    );
    assert.deepEqual(codes, [0, 0]);
    assert.equal(readFileSync(path.join(cache, "installs"), "utf8"), "ci\n");
    assert.equal(readFileSync(path.join(workspaces[1], "node_modules/value"), "utf8"), "installed");
    const third = path.join(root, "three");
    mkdirSync(third);
    writeFileSync(path.join(third, "package.json"), '{"name":"new-generation"}');
    writeFileSync(path.join(third, "package-lock.json"), '{"packages":{"":{}}}');
    execFileSync(process.execPath, ["--input-type=module", "-e", code, third, cache]);
    assert.equal(readFileSync(path.join(cache, "installs"), "utf8"), "ci\nci\n");
    assert.equal(readFileSync(path.join(workspaces[0], "node_modules/value"), "utf8"), "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized installations fail before publishing or allocating a cache copy", () =>
  fixture(({ cache, workspace }) => {
    const root = workspace("large");
    assert.throws(
      () =>
        prepareDependencies(root, cache, () => {
          mkdirSync(path.join(root, "node_modules"));
          const file = path.join(root, "node_modules/large");
          writeFileSync(file, "");
          truncateSync(file, cacheLimitBytes + 1);
        }),
      /dependency cache exceeds/,
    );
    assert.equal(existsSync(path.join(cache, "current")), false);
  }));

test("warm preparation executes the real npm workspace prepare against new source", () =>
  fixture(({ cache, workspace }) => {
    const first = workspace("first-real"),
      second = workspace("second-real");
    for (const root of [first, second]) {
      writeFileSync(
        path.join(root, "packages/local/package.json"),
        JSON.stringify({
          name: "local",
          scripts: { prepare: `node -e "require('node:fs').copyFileSync('source','output')"` },
        }),
      );
      writeFileSync(path.join(root, "packages/local/source"), root === first ? "old" : "new");
    }
    prepareDependencies(first, cache, install);
    prepareDependencies(second, cache);
    assert.equal(readFileSync(path.join(second, "packages/local/output"), "utf8"), "new");
  }));

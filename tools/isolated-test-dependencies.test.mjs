// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
  function workspace(name, { typecheck = false } = {}) {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "packages", "local"), { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        workspaces: ["packages/*"],
        ...(typecheck ? { scripts: { typecheck: "compile project references" } } : {}),
      }),
    );
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
    mkdirSync(path.join(root, ".test-runtime/playwright/chromium-1234"), { recursive: true });
    writeFileSync(path.join(root, ".test-runtime/playwright/chromium-1234/marker"), "runtime");
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
    assert.equal(
      realpathSync(path.join(second, "node_modules/local")),
      realpathSync(path.join(second, "packages/local")),
    );
    assert.equal(readFileSync(path.join(second, "packages/local/output"), "utf8"), "second source");
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
    mkdirSync(path.join(cache, "pending"), { recursive: true });
    writeFileSync(path.join(cache, "pending/stale"), "partial");
    prepareDependencies(root, cache, install);
    assert.equal(existsSync(path.join(cache, "pending")), false);
    assert.equal(existsSync(path.join(cache, "current/stale")), false);
  }));

async function waitForFile(file, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} did not appear within ${deadlineMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnCreator(cache, code, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, dir, cache], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

test("concurrent creators install independently; publication stays single-winner", async () => {
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
    // Both children record the install and stop inside it until released, so
    // both installs provably overlap before either can publish a generation.
    const gatedCreator = (gate, release) =>
      `import {prepareDependencies} from ${JSON.stringify(module)}; import {mkdirSync,writeFileSync,appendFileSync,existsSync} from 'node:fs'; import path from 'node:path'; prepareDependencies(process.argv[1],process.argv[2],(root,args)=>{appendFileSync(path.join(process.argv[2],'installs'),args[0]+'\\n'); appendFileSync(path.join(process.argv[2],${JSON.stringify(gate)}),''); const latch=new Int32Array(new SharedArrayBuffer(4)); const deadline=Date.now()+60000; while (!existsSync(path.join(process.argv[2],${JSON.stringify(release)})) && Date.now()<deadline) Atomics.wait(latch,0,0,25); mkdirSync(path.join(root,'node_modules')); writeFileSync(path.join(root,'node_modules/value'),'installed');});`;
    const gates = [
      ["gate-one", "release-one"],
      ["gate-two", "release-two"],
    ];
    const exits = [];
    const running = workspaces.map((dir, index) =>
      spawnCreator(cache, gatedCreator(...gates[index]), dir).then((code) => exits.push(code)),
    );
    for (const [gate] of gates) await waitForFile(path.join(cache, gate));
    for (const [, release] of gates) writeFileSync(path.join(cache, release), "");
    await Promise.all(running);
    assert.deepEqual(exits, [0, 0]);
    assert.equal(readFileSync(path.join(cache, "installs"), "utf8"), "ci\nci\n");
    assert.equal(readFileSync(path.join(workspaces[1], "node_modules/value"), "utf8"), "installed");
    const third = path.join(root, "three");
    mkdirSync(third);
    writeFileSync(path.join(third, "package.json"), '{"name":"new-generation"}');
    writeFileSync(path.join(third, "package-lock.json"), '{"packages":{"":{}}}');
    const plainCreator = `import {prepareDependencies} from ${JSON.stringify(module)}; import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs'; import path from 'node:path'; prepareDependencies(process.argv[1],process.argv[2],(root,args)=>{appendFileSync(path.join(process.argv[2],'installs'),args[0]+'\\n'); mkdirSync(path.join(root,'node_modules')); writeFileSync(path.join(root,'node_modules/value'),'installed');});`;
    assert.equal(await spawnCreator(cache, plainCreator, third), 0);
    assert.equal(readFileSync(path.join(cache, "installs"), "utf8"), "ci\nci\nci\n");
    assert.equal(readFileSync(path.join(workspaces[0], "node_modules/value"), "utf8"), "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warm preparation completes while a cold preparation is still installing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cache-parallel-"));
  try {
    const cache = path.join(root, "cache");
    const module = new URL("./isolated-test-dependencies.mjs", import.meta.url).href;
    const warm = path.join(root, "warm"),
      cold = path.join(root, "cold");
    for (const [dir, manifest] of [
      [warm, '{"name":"warm"}'],
      [cold, '{"name":"cold"}'],
    ]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, "package.json"), manifest);
      writeFileSync(path.join(dir, "package-lock.json"), '{"packages":{"":{}}}');
    }
    const install = (workspaceRoot) => {
      mkdirSync(path.join(workspaceRoot, "node_modules"), { recursive: true });
      writeFileSync(path.join(workspaceRoot, "node_modules/value"), "installed");
      mkdirSync(path.join(workspaceRoot, ".test-runtime/playwright/chromium-1234"), { recursive: true });
      writeFileSync(path.join(workspaceRoot, ".test-runtime/playwright/chromium-1234/marker"), "runtime");
    };
    prepareDependencies(warm, cache, install);
    const warmKey = readFileSync(path.join(cache, "current/key"), "utf8");
    // The cold preparation holds a different generation key and stops inside
    // its install until released; the warm one must not wait behind it.
    const coldCreator = `import {prepareDependencies} from ${JSON.stringify(module)}; import {mkdirSync,writeFileSync,appendFileSync,existsSync} from 'node:fs'; import path from 'node:path'; prepareDependencies(process.argv[1],process.argv[2],(root,args)=>{if (args[0] !== 'ci') return; appendFileSync(path.join(process.argv[2],'cold-entered'),''); const latch=new Int32Array(new SharedArrayBuffer(4)); const deadline=Date.now()+60000; while (!existsSync(path.join(process.argv[2],'cold-release')) && Date.now()<deadline) Atomics.wait(latch,0,0,25); mkdirSync(path.join(root,'node_modules')); writeFileSync(path.join(root,'node_modules/value'),'installed'); mkdirSync(path.join(root,'.test-runtime/playwright/chromium-1234'),{recursive:true}); writeFileSync(path.join(root,'.test-runtime/playwright/chromium-1234/downloaded'),'runtime'); appendFileSync(path.join(process.argv[2],'cold-exited'),'');});`;
    const coldChild = spawnCreator(cache, coldCreator, cold);
    await waitForFile(path.join(cache, "cold-entered"));
    prepareDependencies(warm, cache, install);
    assert.equal(
      existsSync(path.join(cache, "cold-exited")),
      false,
      "warm preparation waited for the cold installation to finish",
    );
    writeFileSync(path.join(cache, "cold-release"), "");
    assert.equal(await coldChild, 0);
    assert.notEqual(readFileSync(path.join(cache, "current/key"), "utf8"), warmKey);
    assert.equal(readFileSync(path.join(warm, "node_modules/value"), "utf8"), "installed");
    assert.equal(readFileSync(path.join(warm, ".test-runtime/playwright/chromium-1234/marker"), "utf8"), "runtime");
    assert.equal(
      readFileSync(path.join(cache, "current/runtime/playwright/chromium-1234/downloaded"), "utf8"),
      "runtime",
    );
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

test("warm preparation restores dependencies and rebuilds workspaces against current source", () =>
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
    prepareDependencies(second, cache, (root, args) => {
      assert.deepEqual(args, ["run", "prepare", "--workspace", "packages/local", "--ignore-scripts"]);
      install(root, args);
    });
    assert.equal(readFileSync(path.join(second, "packages/local/output"), "utf8"), "new");
  }));

test("builds composite references before workspace lifecycle hooks", () =>
  fixture(({ cache, workspace }) => {
    const first = workspace("first", { typecheck: true });
    writeFileSync(path.join(first, "packages/local/source"), "source");
    prepareDependencies(first, cache, install);

    const second = workspace("second", { typecheck: true });
    writeFileSync(path.join(second, "packages/local/source"), "source");
    const calls = [];
    prepareDependencies(second, cache, (root, args) => {
      calls.push(args);
      install(root, args);
    });
    assert.deepEqual(calls, [
      ["run", "typecheck", "--ignore-scripts"],
      ["run", "prepare", "--workspace", "packages/local", "--ignore-scripts"],
    ]);
  }));

test("restores workspace package links when a cache hit contains a directory copy", () =>
  fixture(({ cache, workspace }) => {
    const first = workspace("first");
    writeFileSync(path.join(first, "packages/local/source"), "source");
    prepareDependencies(first, cache, install);
    const cachedPackage = path.join(cache, "current/node_modules/local");
    rmSync(cachedPackage, { recursive: true, force: true });
    mkdirSync(cachedPackage, { recursive: true });
    writeFileSync(path.join(cachedPackage, "stale"), "old workspace copy");

    const restored = workspace("restored");
    writeFileSync(path.join(restored, "packages/local/source"), "source");
    prepareDependencies(restored, cache, (root, args) => {
      assert.notEqual(args[0], "ci", "the second preparation should restore the cache hit");
      install(root, args);
    });
    assert.equal(
      realpathSync(path.join(restored, "node_modules/local")),
      realpathSync(path.join(restored, "packages/local")),
    );
  }));

test("build cache follows snapshot bytes and remains independent after source changes", () =>
  fixture(({ cache, workspace }) => {
    const calls = [];
    const build = (root, args) => {
      calls.push(args[0]);
      install(root, args);
      mkdirSync(path.join(root, "packages/local/dist"), { recursive: true });
      writeFileSync(
        path.join(root, "packages/local/dist/output"),
        readFileSync(path.join(root, "packages/local/source")),
      );
    };
    const roots = ["first", "second", "third"].map((name) => {
      const root = workspace(name);
      writeFileSync(path.join(root, "packages/local/source"), "old");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync(
        "git",
        ["add", "package.json", "package-lock.json", "packages/local/package.json", "packages/local/source"],
        { cwd: root },
      );
      return root;
    });
    prepareDependencies(roots[0], cache, build);
    prepareDependencies(roots[1], cache, build);
    assert.deepEqual(calls, ["ci", "run"]);
    assert.equal(readFileSync(path.join(roots[1], "packages/local/dist/output"), "utf8"), "old");
    writeFileSync(path.join(roots[2], "packages/local/source"), "new");
    prepareDependencies(roots[2], cache, build);
    assert.deepEqual(calls, ["ci", "run", "run"]);
    assert.equal(readFileSync(path.join(roots[2], "packages/local/dist/output"), "utf8"), "new");
    assert.equal(readFileSync(path.join(roots[1], "packages/local/dist/output"), "utf8"), "old");
    writeFileSync(path.join(roots[2], "packages/local/dist/output"), "test mutation");
    assert.equal(readFileSync(path.join(cache, "build/packages/local/dist/output"), "utf8"), "new");
  }));

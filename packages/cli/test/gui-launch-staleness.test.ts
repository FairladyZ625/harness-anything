// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGuiLaunch } from "../src/cli/gui-launch.ts";

const currentCommit = "1111111111111111111111111111111111111111",
  staleCommit = "0000000000000000000000000000000000000000";

type Receipt = Record<string, unknown> & { code?: string; error?: { code?: string } };

test("ha gui rebuilds a GUI bundle older than the source commit before launching", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  try {
    const events: string[] = [],
      receipts: Receipt[] = [];
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: (packageRoot) => {
          assert.equal(packageRoot, fixture.guiRoot);
          events.push("rebuild");
          writeMarker(fixture.checkoutRoot, currentCommit);
        },
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => {
          events.push("daemon");
          return { ok: true, hint: "reachable", attempts: 0 };
        },
        startDetached: () => {
          spawned += 1;
          return { pid: 4242 };
        },
      },
      (receipt) => receipts.push(receipt as Receipt),
    );
    assert.equal(status, 0);
    assert.deepEqual(events, ["rebuild", "daemon"], "the rebuild must complete before daemon acquisition");
    assert.equal(spawned, 1);
    assert.equal(receipts.at(-1)?.rebuilt, true);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("a missing dist marker in a source checkout counts as stale and is rebuilt", async () => {
  const fixture = guiSourceFixture();
  try {
    const rebuilds: string[] = [],
      receipts: Receipt[] = [];
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: (packageRoot) => {
          rebuilds.push(packageRoot);
          writeMarker(fixture.checkoutRoot, currentCommit);
        },
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => ({ pid: 4242 }),
      },
      (receipt) => receipts.push(receipt as Receipt),
    );
    assert.equal(status, 0);
    assert.deepEqual(rebuilds, [fixture.guiRoot]);
    assert.equal(receipts.at(-1)?.rebuilt, true);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("a fresh dist marker launches without rebuilding", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, currentCommit);
  try {
    let spawned = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => currentCommit,
          rebuildGuiBundle: () => assert.fail("a fresh bundle must not be rebuilt"),
          resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
          ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
          startDetached: () => {
            spawned += 1;
            return { pid: 4242 };
          },
        },
        (receipt) => receipts.push(receipt as Receipt),
      );
    assert.equal(status, 0);
    assert.equal(spawned, 1);
    assert.equal("rebuilt" in (receipts.at(-1) ?? {}), false);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("an installed GUI package without a src tree never triggers a rebuild", async () => {
  const fixture = guiSourceFixture();
  rmSync(path.join(fixture.guiRoot, "src"), { recursive: true, force: true });
  writeMarker(fixture.checkoutRoot, staleCommit);
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: () => assert.fail("an installed package must not be rebuilt"),
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => {
          spawned += 1;
          return { pid: 4242 };
        },
      },
      () => undefined,
    );
    assert.equal(status, 0);
    assert.equal(spawned, 1);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("an unresolvable source build id skips the staleness check", async () => {
  const fixture = guiSourceFixture();
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => null,
        rebuildGuiBundle: () => assert.fail("without a build id there is nothing to compare"),
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => {
          spawned += 1;
          return { pid: 4242 };
        },
      },
      () => undefined,
    );
    assert.equal(status, 0);
    assert.equal(spawned, 1);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("a failed rebuild rejects with the manual command and never starts the daemon", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  try {
    let daemonAcquisitions = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => currentCommit,
          rebuildGuiBundle: () => {
            throw new Error("vite build exited with status 1");
          },
          resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
          ensureDaemon: async () => {
            daemonAcquisitions += 1;
            return { ok: true, hint: "reachable", attempts: 0 };
          },
        },
        (receipt) => receipts.push(receipt as Receipt),
      );
    const receipt = receipts.at(-1) ?? {},
      expectation = String((receipt.diagnostic as { readonly expectation?: unknown } | undefined)?.expectation ?? "");
    assert.equal(status, 1);
    assert.equal(receipt.code, "gui_build_failed");
    assert.equal(receipt.error?.code, "gui_build_failed");
    assert.match(expectation, /npm run build --workspace @harness-anything\/gui/u);
    assert.equal(daemonAcquisitions, 0, "a failed rebuild must not start the daemon");
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("the default rebuild path runs the package's build script in the GUI package root", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  writeFileSync(
    path.join(fixture.guiRoot, "package.json"),
    JSON.stringify({ name: "@harness-anything/gui", private: true, scripts: { build: "node stamp-fresh-marker.mjs" } }),
  );
  writeFileSync(
    path.join(fixture.guiRoot, "stamp-fresh-marker.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("dist/build-id.txt", "${currentCommit}\\n");\n`,
  );
  try {
    let spawned = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => currentCommit,
          resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
          ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
          startDetached: () => {
            spawned += 1;
            return { pid: 4242 };
          },
        },
        (receipt) => receipts.push(receipt as Receipt),
      );
    assert.equal(status, 0, "the real default rebuild must refresh the marker and continue the launch");
    assert.equal(spawned, 1);
    assert.equal(receipts.at(-1)?.rebuilt, true);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("a lockfile dependency the installed tree lacks rejects the rebuild with the install remedy", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  writeLockfiles(fixture.checkoutRoot, ["node_modules/electron-updater"], []);
  try {
    let daemonAcquisitions = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => currentCommit,
          rebuildGuiBundle: () => assert.fail("a rebuild without its dependencies must not run"),
          resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
          ensureDaemon: async () => {
            daemonAcquisitions += 1;
            return { ok: true, hint: "reachable", attempts: 0 };
          },
        },
        (receipt) => receipts.push(receipt as Receipt),
      );
    const receipt = receipts.at(-1) ?? {},
      expectation = String((receipt.diagnostic as { readonly expectation?: unknown } | undefined)?.expectation ?? "");
    assert.equal(status, 1);
    assert.equal(receipt.code, "gui_dependencies_stale");
    assert.equal(receipt.error?.code, "gui_dependencies_stale");
    assert.match(expectation, /electron-updater/u);
    assert.match(expectation, /npm install/u);
    assert.doesNotMatch(expectation, /npm run build/u);
    assert.equal(daemonAcquisitions, 0, "a stale-dependency rejection must not start the daemon");
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("an installed dependency at a version the lockfile outdates rejects the rebuild", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  writeLockfiles(fixture.checkoutRoot, ["node_modules/electron-updater"], ["node_modules/electron-updater:6.0.0"]);
  try {
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => currentCommit,
          rebuildGuiBundle: () => assert.fail("a rebuild against outdated dependency versions must not run"),
          resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
          ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
          startDetached: () => ({ pid: 4242 }),
        },
        (receipt) => receipts.push(receipt as Receipt),
      );
    assert.equal(status, 1);
    assert.equal((receipts.at(-1) ?? {}).code, "gui_dependencies_stale");
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("a lockfile the installed tree satisfies does not block the rebuild", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  writeLockfiles(fixture.checkoutRoot, ["node_modules/electron-updater"], ["node_modules/electron-updater"]);
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: () => writeMarker(fixture.checkoutRoot, currentCommit),
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => {
          spawned += 1;
          return { pid: 4242 };
        },
      },
      () => undefined,
    );
    assert.equal(status, 0);
    assert.equal(spawned, 1);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("an optional lockfile entry the installed tree skips never blocks the rebuild", async () => {
  const fixture = guiSourceFixture();
  writeMarker(fixture.checkoutRoot, staleCommit);
  writeLockfiles(
    fixture.checkoutRoot,
    ["node_modules/electron-updater", "node_modules/@msgpackr-extract/msgpackr-extract-darwin-x64:optional"],
    ["node_modules/electron-updater"],
  );
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: fixture.guiRoot,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: () => writeMarker(fixture.checkoutRoot, currentCommit),
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => {
          spawned += 1;
          return { pid: 4242 };
        },
      },
      () => undefined,
    );
    assert.equal(status, 0);
    assert.equal(spawned, 1);
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("ha gui passes one explicit parent origin to its browser broker", async () => {
  const fixture = guiSourceFixture();
  try {
    for (const parentOrigin of [undefined, "http://127.0.0.1:43123", "https://dsh.example", "dsh-app://app"]) {
      let launched = 0;
      const status = await runGuiLaunch(
        [
          "gui",
          "--browser",
          "--root",
          fixture.checkoutRoot,
          ...(parentOrigin ? ["--parent-origin", parentOrigin] : []),
        ],
        {
          guiPackageRoot: fixture.guiRoot,
          sourceBuildId: () => null,
          ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
          startBrowserBroker: async (guiRoot, root, allowedParent) => {
            launched += 1;
            assert.equal(guiRoot, fixture.guiRoot);
            assert.equal(root, fixture.checkoutRoot);
            assert.equal(allowedParent, parentOrigin);
            return { url: "http://127.0.0.1:1234/", close: async () => undefined };
          },
          waitForBrowserClose: async () => undefined,
        },
        () => undefined,
      );
      assert.equal(status, 0);
      assert.equal(launched, 1);
    }
  } finally {
    rmSync(fixture.checkoutRoot, { recursive: true, force: true });
  }
});

test("ha gui rejects invalid parent origins before acquiring a daemon", async () => {
  for (const argv of [
    ["gui", "--parent-origin", "dsh-app://app"],
    ["gui", "--browser", "--parent-origin"],
    ["gui", "--browser", "--parent-origin", "dsh-app://app", "--parent-origin", "dsh-app://app"],
    ...[
      "*",
      "null",
      "http://127.0.0.1:*",
      "https://*.example",
      "https://example/path",
      "https://user@example",
      "https://example?x",
      "https://example#x",
      "https://example;",
      "https://a https://b",
      "https://a\n",
      "file://app",
      "dsh-app://other",
    ].map((origin) => ["gui", "--browser", "--parent-origin", origin]),
  ]) {
    const receipts: Receipt[] = [];
    const status = await runGuiLaunch(
      argv,
      {
        ensureDaemon: async () => assert.fail("invalid input must not acquire a daemon"),
      },
      (receipt) => receipts.push(receipt as Receipt),
    );
    assert.equal(status, 2);
    assert.ok(["invalid_field", "missing_field"].includes(receipts.at(-1)?.code ?? ""));
  }
});

function guiSourceFixture(): { readonly checkoutRoot: string; readonly guiRoot: string } {
  // Stands in for a source checkout: <root>/packages/gui carries the bundles plus the src tree
  // whose commit the bundle's dist marker is compared against, and the lockfiles live at the
  // checkout root where the rebuild's dependency check reads them.
  const checkoutRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-stale-")),
    guiRoot = path.join(checkoutRoot, "packages/gui");
  mkdirSync(path.join(guiRoot, "dist"), { recursive: true });
  mkdirSync(path.join(guiRoot, "dist-electron"), { recursive: true });
  mkdirSync(path.join(guiRoot, "src"), { recursive: true });
  mkdirSync(path.join(checkoutRoot, "node_modules"), { recursive: true });
  writeFileSync(path.join(guiRoot, "dist/index.html"), "<!doctype html>\n");
  writeFileSync(path.join(guiRoot, "dist-electron/electron-preload.cjs"), "\n");
  writeFileSync(path.join(guiRoot, "dist-electron/electron-main.js"), "\n");
  writeFileSync(path.join(guiRoot, "src/index.ts"), "export {};\n");
  return { checkoutRoot, guiRoot };
}
function writeMarker(checkoutRoot: string, commit: string): void {
  writeFileSync(path.join(checkoutRoot, "packages/gui/dist/build-id.txt"), `${commit}\n`);
}
// Entries are "node_modules/<name>" for plain registry packages and take an ":<version>" or
// ":optional" suffix to vary what the two lockfiles claim about the same path.
function writeLockfiles(
  checkoutRoot: string,
  lockfileEntries: readonly string[],
  installedEntries: readonly string[],
): void {
  const entry = (spec: string): Record<string, unknown> => {
    const [entryPath, marker] = spec.split(":");
    if (marker === "optional") return { optional: true };
    return {
      version: marker ?? "6.8.9",
      resolved: `https://registry.npmjs.org/${entryPath.slice("node_modules/".length)}.tgz`,
    };
  };
  const lockfile: Record<string, unknown> = { "": { name: "harness-anything" } };
  for (const spec of lockfileEntries) lockfile[spec.split(":")[0]!] = entry(spec);
  writeFileSync(
    path.join(checkoutRoot, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: lockfile }),
  );
  const installed: Record<string, unknown> = {};
  for (const spec of installedEntries) installed[spec.split(":")[0]!] = entry(spec);
  writeFileSync(
    path.join(checkoutRoot, "node_modules/.package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: installed }),
  );
}

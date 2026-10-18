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
  const root = guiSourceFixture();
  writeMarker(root, staleCommit);
  try {
    const events: string[] = [],
      receipts: Receipt[] = [];
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: root,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: (packageRoot) => {
          assert.equal(packageRoot, root);
          events.push("rebuild");
          writeMarker(root, currentCommit);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing dist marker in a source checkout counts as stale and is rebuilt", async () => {
  const root = guiSourceFixture();
  try {
    const rebuilds: string[] = [],
      receipts: Receipt[] = [];
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: root,
        sourceBuildId: () => currentCommit,
        rebuildGuiBundle: (packageRoot) => {
          rebuilds.push(packageRoot);
          writeMarker(root, currentCommit);
        },
        resolveElectronRuntime: () => ({ binary: "/electron", remedy: "unused" }),
        ensureDaemon: async () => ({ ok: true, hint: "reachable", attempts: 0 }),
        startDetached: () => ({ pid: 4242 }),
      },
      (receipt) => receipts.push(receipt as Receipt),
    );
    assert.equal(status, 0);
    assert.deepEqual(rebuilds, [root]);
    assert.equal(receipts.at(-1)?.rebuilt, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh dist marker launches without rebuilding", async () => {
  const root = guiSourceFixture();
  writeMarker(root, currentCommit);
  try {
    let spawned = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: root,
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed GUI package without a src tree never triggers a rebuild", async () => {
  const root = guiSourceFixture();
  rmSync(path.join(root, "src"), { recursive: true, force: true });
  writeMarker(root, staleCommit);
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: root,
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unresolvable source build id skips the staleness check", async () => {
  const root = guiSourceFixture();
  try {
    let spawned = 0;
    const status = await runGuiLaunch(
      ["gui", "--json"],
      {
        guiPackageRoot: root,
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed rebuild rejects with the manual command and never starts the daemon", async () => {
  const root = guiSourceFixture();
  writeMarker(root, staleCommit);
  try {
    let daemonAcquisitions = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: root,
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default rebuild path runs the package's build script in the GUI package root", async () => {
  const root = guiSourceFixture();
  writeMarker(root, staleCommit);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@harness-anything/gui", private: true, scripts: { build: "node stamp-fresh-marker.mjs" } }),
  );
  writeFileSync(
    path.join(root, "stamp-fresh-marker.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("dist/build-id.txt", "${currentCommit}\\n");\n`,
  );
  try {
    let spawned = 0;
    const receipts: Receipt[] = [],
      status = await runGuiLaunch(
        ["gui", "--json"],
        {
          guiPackageRoot: root,
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
    rmSync(root, { recursive: true, force: true });
  }
});

function guiSourceFixture(): string {
  // Stands in for a source-checkout packages/gui: bundles plus the src tree whose commit the
  // bundle's dist marker is compared against.
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-stale-"));
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(path.join(root, "dist-electron"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "dist/index.html"), "<!doctype html>\n");
  writeFileSync(path.join(root, "dist-electron/electron-preload.cjs"), "\n");
  writeFileSync(path.join(root, "dist-electron/electron-main.js"), "\n");
  writeFileSync(path.join(root, "src/index.ts"), "export {};\n");
  return root;
}
function writeMarker(root: string, commit: string): void {
  writeFileSync(path.join(root, "dist/build-id.txt"), `${commit}\n`);
}

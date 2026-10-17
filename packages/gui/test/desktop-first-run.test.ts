// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  desktopRuntimePaths,
  desktopShimPath,
  ensureShellPath,
  ensureShim,
  shimContents,
} from "../src/main/desktop-first-run.ts";

test("desktop runtime paths point at packaged node, CLI, and daemon", () => {
  assert.deepEqual(desktopRuntimePaths("/resources", "/app", "darwin", "arm64"), {
    node: "/resources/node/darwin-arm64/node",
    cli: "/resources/app/packages/cli/dist/cli/src/index.js",
    daemon: "/resources/app/node_modules/@harness-anything/daemon/dist/daemon/src/bin.js",
  });
});

test("shim and shell path are stable and idempotent", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ha-desktop-first-run-"));
  const runtime = { node: "/bundle/node", cli: "/bundle/ha.js", daemon: "/bundle/daemon.js" };
  const first = ensureShim(runtime, home, "darwin");
  assert.equal(first.path, desktopShimPath(home, "darwin"));
  assert.equal(readFileSync(first.path, "utf8"), shimContents(runtime, "darwin"));
  assert.equal(ensureShim(runtime, home, "darwin").installed, false);
  const rc = ensureShellPath(home, "darwin");
  ensureShellPath(home, "darwin");
  assert.equal(readFileSync(rc, "utf8").match(/Harness Anything\/bin/g)?.length, 1);
});

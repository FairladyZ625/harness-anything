// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePtySpawnHelperExecutable } from "../src/terminal-spawn-helper.ts";

test("repairs a node-pty prebuild helper shipped without the executable bit", () => {
  const root = fixture(0o644), helper = helperPath(root);
  try {
    assert.equal(statSync(helper).mode & 0o111, 0);
    assert.equal(ensurePtySpawnHelperExecutable({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" }), helper);
    assert.notEqual(statSync(helper).mode & 0o111, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("leaves an already executable helper untouched", () => {
  const root = fixture(0o755), helper = helperPath(root);
  try {
    assert.equal(ensurePtySpawnHelperExecutable({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" }), null);
    assert.equal(statSync(helper).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports no repair when node-pty is not resolvable from the anchor", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pty-helper-absent-")));
  try {
    assert.equal(ensurePtySpawnHelperExecutable({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(mode: number): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pty-helper-"))), pkg = path.join(root, "node_modules", "node-pty");
  mkdirSync(path.join(pkg, "prebuilds", "darwin-arm64"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  writeFileSync(helperPath(root), "#!/bin/sh\n");
  chmodSync(helperPath(root), mode);
  return root;
}

function helperPath(root: string): string {
  return path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
}

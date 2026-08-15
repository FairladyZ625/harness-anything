// harness-test-tier: contract
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePtySpawnHelperExecutable, ptySpawnHelperCandidates } from "../src/main/terminal-spawn-helper.ts";

describe("node-pty spawn-helper exec-bit repair", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "pty-helper-")));
    const pkg = path.join(root, "node_modules", "node-pty");
    mkdirSync(path.join(pkg, "prebuilds", "darwin-arm64"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
    const helper = path.join(pkg, "prebuilds", "darwin-arm64", "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o644);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists the resolved prebuild helper for the current platform", () => {
    const candidates = ptySpawnHelperCandidates({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" });
    expect(candidates).toContain(path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"));
  });

  it("repairs a helper shipped without the executable bit (posix_spawn failed root cause)", () => {
    const helper = path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    expect(statSync(helper).mode & 0o111).toBe(0);
    const result = ensurePtySpawnHelperExecutable({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" });
    expect(result.repaired).toEqual([helper]);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });

  it("leaves an already executable helper untouched", () => {
    const helper = path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    chmodSync(helper, 0o755);
    const result = ensurePtySpawnHelperExecutable({ anchorDir: path.join(root, "src"), platform: "darwin", arch: "arm64" });
    expect(result.repaired).toEqual([]);
    expect(result.checked).toEqual([helper]);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });
});

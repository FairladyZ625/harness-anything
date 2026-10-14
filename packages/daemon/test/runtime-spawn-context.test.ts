// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonCliBinDirectory } from "../src/runtime-spawn-context.ts";

test("runtime CLI bin resolves from the nearest daemon installation", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-bin-")),
    modulePath = path.join(root, "packages", "daemon", "dist", "runtime-spawn-context.js"),
    binDirectory = path.join(root, "node_modules", ".bin");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(path.join(binDirectory, "ha"), "#!/usr/bin/env node\n");
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), binDirectory);
});

test("runtime CLI bin stays absent when the daemon installation has no ha entry", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-missing-")),
    modulePath = path.join(root, "node_modules", "@harness-anything", "daemon", "dist", "runtime-spawn-context.js");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), undefined);
});

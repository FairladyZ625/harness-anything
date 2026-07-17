// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTrustedGuiWorkspaceRoot } from "../src/commands/core/gui.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

test("CLI gui command delegates to the local desktop controller without importing GUI", () => {
  const result = runJson(process.cwd(), ["gui"], true, { HARNESS_GUI_DRY_RUN: "1" });

  assert.equal(result.ok, true);
  assert.equal(result.command, "gui");
  assert.deepEqual(result.launchPlan, {
    packageName: "@harness-anything/gui",
    mode: "local-desktop-controller",
    apiHost: "127.0.0.1",
    delegated: true,
    dryRun: true,
    command: [npmBin, "--workspace", "@harness-anything/gui", "run", "dev:electron"]
  });
});

test("CLI gui command launches npm from the trusted package workspace, not the caller cwd", () => {
  withTempRoot((rootDir) => {
    const binDir = path.join(rootDir, "bin");
    const callerDir = path.join(rootDir, "untrusted-caller");
    const attackerPackageDir = path.join(callerDir, "evil-gui");
    const npmMarkerPath = path.join(rootDir, "npm-marker.json");
    const evilMarkerPath = path.join(rootDir, "evil-marker.json");
    mkdirSync(binDir);
    mkdirSync(attackerPackageDir, { recursive: true });
    writeFileSync(path.join(callerDir, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["evil-gui"]
    }));
    writeFileSync(path.join(attackerPackageDir, "package.json"), JSON.stringify({
      name: "@harness-anything/gui",
      scripts: { dev: "node payload.mjs" }
    }));
    writeFileSync(path.join(attackerPackageDir, "payload.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(evilMarkerPath)}, JSON.stringify({ cwd: process.cwd() }));`
    ].join("\n"));
    const fakeNpmJs = [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.HARNESS_GUI_NPM_MARKER, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));"
    ].join("\n");
    if (process.platform === "win32") {
      writeFileSync(path.join(binDir, "fake-npm.js"), fakeNpmJs);
      writeFileSync(path.join(binDir, npmBin), "@echo off\r\nnode \"%~dp0fake-npm.js\" %*\r\n");
    } else {
      writeFileSync(path.join(binDir, npmBin), fakeNpmJs);
    }
    chmodSync(path.join(binDir, npmBin), 0o755);

    const result = runJson(rootDir, ["gui"], true, {
      [pathEnvName()]: `${binDir}${path.delimiter}${process.env[pathEnvName()] ?? ""}`,
      HARNESS_GUI_NPM_MARKER: npmMarkerPath,
      ELECTRON_RUN_AS_NODE: "1"
    }, callerDir);

    assert.equal(result.ok, true);
    assert.notEqual(result.launchPlan.pid, undefined);
    const marker = waitForJsonMarker(npmMarkerPath);
    assert.equal(marker.cwd, process.cwd());
    assert.deepEqual(marker.argv, ["--workspace", "@harness-anything/gui", "run", "dev:electron"]);
    assert.equal(marker.electronRunAsNode, null);
    assert.equal(existsSync(evilMarkerPath), false);
  });
});

test("CLI gui workspace trust rejects nested CLI installs under caller-controlled packages/cli", () => {
  withTempRoot((rootDir) => {
    writeHarnessPackageJsons(rootDir);
    const nestedCliEntrypoint = path.join(rootDir, "packages/cli/node_modules/@harness-anything/cli/dist/cli/src/commands/core/gui.js");
    const sourceCliEntrypoint = path.join(rootDir, "packages/cli/src/commands/core/gui.ts");
    const distCliEntrypoint = path.join(rootDir, "packages/cli/dist/cli/src/commands/core/gui.js");
    writeEntrypoint(nestedCliEntrypoint);
    writeEntrypoint(sourceCliEntrypoint);
    writeEntrypoint(distCliEntrypoint);

    assert.equal(isTrustedGuiWorkspaceRoot(rootDir, nestedCliEntrypoint), false);
    assert.equal(isTrustedGuiWorkspaceRoot(rootDir, sourceCliEntrypoint), true);
    assert.equal(isTrustedGuiWorkspaceRoot(rootDir, distCliEntrypoint), true);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function pathEnvName(): string {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true,
  env: Readonly<Record<string, string>> = {},
  cwd = process.cwd()
): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function writeHarnessPackageJsons(rootDir: string): void {
  mkdirSync(path.join(rootDir, "packages/cli"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages/gui"), { recursive: true });
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({
    name: "harness-anything",
    workspaces: ["packages/*", "packages/adapters/*"]
  }));
  writeFileSync(path.join(rootDir, "packages/cli/package.json"), JSON.stringify({
    name: "@harness-anything/cli"
  }));
  writeFileSync(path.join(rootDir, "packages/gui/package.json"), JSON.stringify({
    name: "@harness-anything/gui"
  }));
}

function writeEntrypoint(entrypointPath: string): void {
  mkdirSync(path.dirname(entrypointPath), { recursive: true });
  writeFileSync(entrypointPath, "");
}

function waitForJsonMarker(markerPath: string): Record<string, any> {
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 5_000);
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, any>;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`Timed out waiting for ${markerPath}`);
}

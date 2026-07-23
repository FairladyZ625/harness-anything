// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTrustedGuiWorkspaceRoot, resolveGuiLaunchTarget } from "../src/commands/core/gui.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

test("CLI gui command delegates to the local desktop controller without importing GUI", () => {
  const result = runJson(process.cwd(), ["gui"], true, { HARNESS_GUI_DRY_RUN: "1" });

  assert.equal(result.ok, true);
  assert.equal(result.command, "gui");
  assert.deepEqual(result.launchPlan, {
    packageName: "@harness-anything/gui",
    mode: "local-desktop-controller",
    source: "source-checkout",
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

    const result = withElectronRuntimeReady(() => runJson(rootDir, ["gui"], true, {
      [pathEnvName()]: `${binDir}${path.delimiter}${process.env[pathEnvName()] ?? ""}`,
      HARNESS_GUI_NPM_MARKER: npmMarkerPath,
      ELECTRON_RUN_AS_NODE: "1"
    }, callerDir));

    assert.equal(result.ok, true);
    assert.equal(result.launchPlan.source, "source-checkout");
    assert.notEqual(result.launchPlan.pid, undefined);
    const marker = waitForJsonMarker(npmMarkerPath);
    assert.equal(marker.cwd, process.cwd());
    assert.deepEqual(marker.argv, ["--workspace", "@harness-anything/gui", "run", "dev:electron"]);
    assert.equal(marker.electronRunAsNode, null);
    assert.equal(existsSync(evilMarkerPath), false);
  });
});

test("CLI gui command launches an explicitly installed desktop product for the selected Harness root", () => {
  withTempRoot((fixtureRoot) => {
    const binDir = path.join(fixtureRoot, "bin");
    const markerPath = path.join(fixtureRoot, "installed-gui-marker.json");
    mkdirSync(binDir);
    const executablePath = writeFakeGuiExecutable(binDir, markerPath);
    const projectRoots = [path.join(fixtureRoot, "project-a"), path.join(fixtureRoot, "project-b")];
    for (const rootDir of projectRoots) {
      mkdirSync(rootDir);
      const result = runJson(rootDir, ["gui"], true, {
        HARNESS_GUI_EXECUTABLE: executablePath,
        HARNESS_GUI_NPM_MARKER: markerPath,
        ELECTRON_RUN_AS_NODE: "1"
      });

      assert.equal(result.ok, true);
      assert.equal(result.launchPlan.source, "installed-product");
      assert.deepEqual(result.launchPlan.command, [executablePath]);
      const marker = waitForJsonMarker(markerPath);
      assert.equal(marker.cwd, realpathSync(rootDir));
      assert.equal(marker.rootDir, rootDir);
      assert.equal(marker.electronRunAsNode, null);
      rmSync(markerPath);
    }
  });
});

test("repeated CLI gui commands fail before delegation when the Electron runtime is missing", () => {
  withTempRoot((rootDir) => {
    const binDir = path.join(rootDir, "bin");
    const npmMarkerPath = path.join(rootDir, "npm-marker.json");
    mkdirSync(binDir);
    const fakeNpmJs = [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(npmMarkerPath)}, 'launched');`
    ].join("\n");
    if (process.platform === "win32") {
      writeFileSync(path.join(binDir, "fake-npm.js"), fakeNpmJs);
      writeFileSync(path.join(binDir, npmBin), "@echo off\r\nnode \"%~dp0fake-npm.js\" %*\r\n");
    } else {
      writeFileSync(path.join(binDir, npmBin), fakeNpmJs);
    }
    chmodSync(path.join(binDir, npmBin), 0o755);

    withElectronRuntimeMissing(() => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = runJson(rootDir, ["gui"], false, {
          [pathEnvName()]: `${binDir}${path.delimiter}${process.env[pathEnvName()] ?? ""}`
        });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "gui_launcher_unavailable");
        assert.match(result.error.hint, /node node_modules\/electron\/install\.js/u);
      }
      assert.equal(existsSync(npmMarkerPath), false);
    });
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

test("GUI launcher discovers the desktop executable that contains its packaged CLI", () => {
  withTempRoot((rootDir) => {
    const appRoot = path.join(rootDir, "Harness Anything.app/Contents");
    const cliEntrypoint = path.join(appRoot, "Resources/app/packages/cli/dist/cli/src/index.js");
    const guiExecutable = path.join(appRoot, "MacOS/Harness Anything");
    writeEntrypoint(cliEntrypoint);
    writeEntrypoint(guiExecutable);
    chmodSync(guiExecutable, 0o755);

    const target = resolveGuiLaunchTarget({
      cliEntrypointPath: cliEntrypoint,
      environment: { PATH: "" },
      platform: "darwin",
      homeDir: path.join(rootDir, "home")
    });

    assert.equal(target?.source, "installed-product");
    assert.deepEqual(target?.command, [realpathSync(guiExecutable)]);
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
      env: cliTestEnv({ ...env }),
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

function writeFakeGuiExecutable(binDir: string, markerPath: string): string {
  const fakeGuiJs = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
    "  cwd: process.cwd(),",
    "  rootDir: process.env.HARNESS_GUI_ROOT,",
    "  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null",
    "}));"
  ].join("\n");
  if (process.platform === "win32") {
    const scriptPath = path.join(binDir, "fake-installed-gui.js");
    const executablePath = path.join(binDir, "harness-anything-gui.cmd");
    writeFileSync(scriptPath, fakeGuiJs);
    writeFileSync(executablePath, `@echo off\r\nnode "%~dp0fake-installed-gui.js"\r\n`);
    return executablePath;
  }
  const executablePath = path.join(binDir, "harness-anything-gui");
  writeFileSync(executablePath, `#!/usr/bin/env node\n${fakeGuiJs}\n`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function waitForJsonMarker(markerPath: string): Record<string, any> {
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 5_000);
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, any>;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`Timed out waiting for ${markerPath}`);
}

function withElectronRuntimeMissing<T>(fn: () => T): T {
  const electronPathFile = path.resolve("node_modules/electron/path.txt");
  const original = existsSync(electronPathFile) ? readFileSync(electronPathFile) : undefined;
  rmSync(electronPathFile, { force: true });
  try {
    return fn();
  } finally {
    if (original !== undefined) writeFileSync(electronPathFile, original);
  }
}

function withElectronRuntimeReady<T>(fn: () => T): T {
  const electronRoot = path.resolve("node_modules/electron");
  const electronPathFile = path.join(electronRoot, "path.txt");
  const fakeRuntimeRelativePath = "ha-test-electron-runtime";
  const fakeRuntimePath = path.join(electronRoot, "dist", fakeRuntimeRelativePath);
  const original = existsSync(electronPathFile) ? readFileSync(electronPathFile) : undefined;
  mkdirSync(path.dirname(fakeRuntimePath), { recursive: true });
  writeFileSync(fakeRuntimePath, "");
  writeFileSync(electronPathFile, fakeRuntimeRelativePath);
  try {
    return fn();
  } finally {
    rmSync(fakeRuntimePath, { force: true });
    if (original === undefined) rmSync(electronPathFile, { force: true });
    else writeFileSync(electronPathFile, original);
  }
}

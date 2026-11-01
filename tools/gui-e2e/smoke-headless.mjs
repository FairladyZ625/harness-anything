#!/usr/bin/env node
// Source-install smoke: launch the built Electron bundle with --headless, prove the
// renderer loaded, and prove no window became visible or focused. This is the acceptance
// step used by skills/harness-download after `npm run build -w @harness-anything/gui`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startGuiDriver } from "./driver.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
const mainPath = path.join(workspaceRoot, "packages/gui/dist-electron/electron-main.js");
if (!existsSync(mainPath)) {
  console.error(`GUI bundle missing at ${mainPath}; run npm run build -w @harness-anything/gui first.`);
  process.exit(1);
}

const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-smoke-root-"));
const runRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-smoke-run-"));
let driver;
try {
  driver = await startGuiDriver({
    workspaceRoot,
    rootDir,
    env: process.env,
    runRoot,
    headless: true,
    mainPath,
  });
  await driver.assertBackground();
  assert.equal(await driver.page.title(), "Harness Anything");
  assert.ok((await driver.page.locator("body").count()) > 0);
  console.log("gui headless smoke: ok (renderer loaded, window hidden and unfocused)");
  if (driver.consoleFailures.length > 0) {
    console.warn(
      `gui headless smoke: ${driver.consoleFailures.length} renderer console error(s) (daemon state is not part of this smoke):`,
    );
    for (const failure of driver.consoleFailures) console.warn(`  ${failure}`);
  }
} catch (error) {
  console.error(`gui headless smoke: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await driver?.close();
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(runRoot, { recursive: true, force: true });
}

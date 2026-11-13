// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import electronPath from "electron";
import { resolveE2EProbeElectronForTest } from "../../../tools/e2e-probe.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

function spawnElectronRunner(runnerPath: string, appDataDir: string, phase: string): string {
  const env = { ...process.env, APPDATA: appDataDir, HA_TEST_APPDATA: appDataDir, HA_TEST_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HARNESS_EXECUTION_CREDENTIAL;
  const result = spawnSync(
    electronPath as unknown as string,
    [runnerPath, "--no-sandbox", "--headless", "--disable-gpu", "--disable-dev-shm-usage"],
    {
      cwd: workspaceRoot,
      env,
      encoding: "utf8",
      timeout: 45_000,
    },
  );
  assert.equal(result.status, 0, `Phase ${phase} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  const marker = "HA_MIGRATION_RESULT=";
  const line = result.stdout.split(/\r?\n/u).find((entry) => entry.startsWith(marker));
  assert.ok(line, `Missing ${marker} in stdout for ${phase}: ${result.stdout}\n${result.stderr}`);
  return line.slice(marker.length);
}

test(
  "F3 integration: real Chromium profile upgrade migrates pre-existing favorites and terminal layouts once while excluding third-party Electron data",
  { timeout: 120_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason ?? "Electron runtime unavailable.");
      return;
    }
    t.after(runtime.close);

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-upgrade-mig-"));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

    const appDataDir = path.join(tempRoot, "AppData");
    const legacyDir = path.join(appDataDir, "Electron");
    const targetDir = path.join(appDataDir, "Harness Anything");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "third-party-marker.txt"), "keep-in-electron-dir", "utf8");

    const runnerPath = path.join(tempRoot, "runner.mjs");
    const channelUrl = pathToFileURL(path.join(workspaceRoot, "packages/gui/src/main/gui-launch-channel.ts")).href;
    const migrationUrl = pathToFileURL(
      path.join(workspaceRoot, "packages/gui/src/main/legacy-profile-migration.ts"),
    ).href;
    const windowConfigUrl = pathToFileURL(path.join(workspaceRoot, "packages/gui/src/main/window-config.ts")).href;

    const favoritesKey = "harness:gui:favorites:repo-upgrade";
    const favoritesVal = JSON.stringify(["task_alpha", "task_beta"]);
    const terminalLayoutKey = "harness:gui:terminal-layout";
    const terminalLayoutVal = JSON.stringify({
      version: 1,
      repos: { "repo-upgrade": { activeGroupId: "group-1", groups: [] } },
    });

    writeFileSync(
      runnerPath,
      `
import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { applyGuiAppIdentity } from ${JSON.stringify(channelUrl)};
import { migrateLegacyElectronProfile } from ${JSON.stringify(migrationUrl)};
import { storageMigrationShimPath } from ${JSON.stringify(windowConfigUrl)};

const appDataDir = process.env.HA_TEST_APPDATA;
const phase = process.env.HA_TEST_PHASE;
app.setActivationPolicy?.("accessory");
app.setPath("appData", appDataDir);
app.on("window-all-closed", () => {});

async function readAllLocalStorage(targetSession) {
  const win = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      ...(targetSession ? { session: targetSession } : {}),
    },
  });
  await win.loadFile(storageMigrationShimPath());
  const dump = await win.webContents.executeJavaScript(\`(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k !== null) out[k] = localStorage.getItem(k);
    }
    return out;
  })()\`);
  win.close();
  return dump;
}

async function runPhase() {
  if (phase === "seed_legacy") {
    app.setPath("userData", path.join(appDataDir, "Electron"));
    await app.whenReady();
    const win = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    await win.loadFile(storageMigrationShimPath());
    await win.webContents.executeJavaScript(
      "((items) => { for (const [k, v] of items) localStorage.setItem(k, v); })(" +
        ${JSON.stringify(
          JSON.stringify([
            [favoritesKey, favoritesVal],
            [terminalLayoutKey, terminalLayoutVal],
            ["other-app:auth-token", "must-not-migrate"],
          ]),
        )} +
        ")",
    );
    await session.defaultSession.flushStorageData();
    win.close();
    console.log("HA_MIGRATION_RESULT=" + JSON.stringify({ seeded: true }));
    app.exit(0);
  } else {
    applyGuiAppIdentity(app, process.platform, process.env);
    await app.whenReady();
    await migrateLegacyElectronProfile();
    const dump = await readAllLocalStorage(undefined);
    if (phase === "upgrade_launch_1") {
      const win = new BrowserWindow({
        show: false,
        focusable: false,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      await win.loadFile(storageMigrationShimPath());
      await win.webContents.executeJavaScript("localStorage.removeItem(" + ${JSON.stringify(JSON.stringify(favoritesKey))} + ")");
      await session.defaultSession.flushStorageData();
      win.close();
    }
    console.log("HA_MIGRATION_RESULT=" + JSON.stringify({ userData: app.getPath("userData"), dump }));
    app.exit(0);
  }
}

runPhase().catch((err) => {
  console.error(err);
  app.exit(1);
});
`,
      "utf8",
    );

    const seeded = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "seed_legacy")) as { seeded: boolean };
    assert.equal(seeded.seeded, true);
    writeFileSync(path.join(legacyDir, "Cookies"), "third-party-cookie-blob", "utf8");

    const launch1 = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "upgrade_launch_1")) as {
      userData: string;
      dump: Record<string, string>;
    };
    assert.equal(path.resolve(launch1.userData), path.resolve(targetDir));
    assert.equal(launch1.dump[favoritesKey], favoritesVal);
    assert.equal(launch1.dump[terminalLayoutKey], terminalLayoutVal);
    assert.equal(launch1.dump["other-app:auth-token"], undefined);
    assert.equal(existsSync(path.join(targetDir, "third-party-marker.txt")), false);
    if (existsSync(path.join(targetDir, "Cookies"))) {
      assert.notEqual(readFileSync(path.join(targetDir, "Cookies"), "utf8"), "third-party-cookie-blob");
    }

    // Second launch must be idempotent: user removal of favorites stays deleted and is not re-copied from legacy Electron dir.
    const launch2 = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "upgrade_launch_2")) as {
      userData: string;
      dump: Record<string, string>;
    };
    assert.equal(launch2.dump[favoritesKey], undefined);
    assert.equal(launch2.dump[terminalLayoutKey], terminalLayoutVal);
    assert.equal(launch2.dump["other-app:auth-token"], undefined);
    assert.equal(readFileSync(path.join(legacyDir, "third-party-marker.txt"), "utf8"), "keep-in-electron-dir");
  },
);

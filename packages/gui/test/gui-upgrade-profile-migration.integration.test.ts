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

function writeUpgradeRunner(
  runnerPath: string,
  options: {
    readonly legacyItems: ReadonlyArray<readonly [string, string]>;
    readonly newerTargetItems?: ReadonlyArray<readonly [string, string]>;
    readonly partialFailureItems?: ReadonlyArray<readonly [string, string]>;
    readonly deleteAfterUpgradeKey: string;
    readonly markerFileName: string;
  },
): void {
  const channelUrl = pathToFileURL(path.join(workspaceRoot, "packages/gui/src/main/gui-launch-channel.ts")).href;
  const migrationUrl = pathToFileURL(
    path.join(workspaceRoot, "packages/gui/src/main/legacy-profile-migration.ts"),
  ).href;
  const windowConfigUrl = pathToFileURL(path.join(workspaceRoot, "packages/gui/src/main/window-config.ts")).href;

  writeFileSync(
    runnerPath,
    `
import { app, BrowserWindow, session } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { applyGuiAppIdentity } from ${JSON.stringify(channelUrl)};
import { migrateLegacyElectronProfile } from ${JSON.stringify(migrationUrl)};
import { storageMigrationShimPath } from ${JSON.stringify(windowConfigUrl)};

const appDataDir = process.env.HA_TEST_APPDATA;
const phase = process.env.HA_TEST_PHASE;
const legacyItems = ${JSON.stringify(options.legacyItems)};
const newerTargetItems = ${JSON.stringify(options.newerTargetItems ?? [])};
const partialFailureItems = ${JSON.stringify(options.partialFailureItems ?? [])};
const deleteAfterUpgradeKey = ${JSON.stringify(options.deleteAfterUpgradeKey)};
const markerFileName = ${JSON.stringify(options.markerFileName)};
let interceptMigrationWrite = phase === "partial_failure_launch";

app.setActivationPolicy?.("accessory");
app.setPath("appData", appDataDir);
app.on("window-all-closed", () => {});

app.on("web-contents-created", (_event, contents) => {
  if (interceptMigrationWrite && contents.session === session.defaultSession) {
    const origExec = contents.executeJavaScript.bind(contents);
    contents.executeJavaScript = async () => {
      await origExec(
        "((items) => { for (const [k, v] of items) { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } })(" +
          JSON.stringify(partialFailureItems) +
          ")",
      );
      throw new Error("Injected partial-write migration interruption");
    };
  }
});

async function writeLocalStorageItems(targetSession, items) {
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
  await win.webContents.executeJavaScript(
    "((items) => { for (const [k, v] of items) localStorage.setItem(k, v); })(" + JSON.stringify(items) + ")",
  );
  await (targetSession ?? session.defaultSession).flushStorageData();
  win.close();
}

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

async function deleteLocalStorageKey(key) {
  const win = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  await win.loadFile(storageMigrationShimPath());
  await win.webContents.executeJavaScript("localStorage.removeItem(" + JSON.stringify(key) + ")");
  await session.defaultSession.flushStorageData();
  win.close();
}

async function runPhase() {
  if (phase === "seed_legacy") {
    app.setPath("userData", path.join(appDataDir, "Electron"));
    await app.whenReady();
    await writeLocalStorageItems(undefined, legacyItems);
    console.log("HA_MIGRATION_RESULT=" + JSON.stringify({ seeded: true }));
    app.exit(0);
    return;
  }

  applyGuiAppIdentity(app, process.platform, process.env);
  await app.whenReady();
  const userData = app.getPath("userData");

  if (phase === "seed_target_newer") {
    await writeLocalStorageItems(undefined, newerTargetItems);
    console.log("HA_MIGRATION_RESULT=" + JSON.stringify({ userData, seededTarget: true }));
    app.exit(0);
    return;
  }

  if (phase === "partial_failure_launch") {
    let rejected = false;
    let errorMessage = "";
    try {
      await migrateLegacyElectronProfile();
    } catch (error) {
      rejected = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      interceptMigrationWrite = false;
    }
    await session.defaultSession.flushStorageData();
    const dump = await readAllLocalStorage(undefined);
    console.log(
      "HA_MIGRATION_RESULT=" +
        JSON.stringify({
          userData,
          rejected,
          errorMessage,
          targetDbExists: existsSync(path.join(userData, "Local Storage", "leveldb")),
          markerExists: existsSync(path.join(userData, markerFileName)),
          dump,
        }),
    );
    app.exit(0);
    return;
  }

  const migrationResult = await migrateLegacyElectronProfile();
  const dump = await readAllLocalStorage(undefined);
  if (phase === "upgrade_launch_1" || phase === "restart_recovery") {
    await deleteLocalStorageKey(deleteAfterUpgradeKey);
  }
  console.log(
    "HA_MIGRATION_RESULT=" +
      JSON.stringify({
        userData,
        migrationResult,
        markerExists: existsSync(path.join(userData, markerFileName)),
        dump,
      }),
  );
  app.exit(0);
}

runPhase().catch((err) => {
  console.error(err);
  app.exit(1);
});
`,
    "utf8",
  );
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
    const favoritesKey = "harness:gui:favorites:repo-upgrade";
    const favoritesVal = JSON.stringify(["task_alpha", "task_beta"]);
    const terminalLayoutKey = "harness:gui:terminal-layout";
    const terminalLayoutVal = JSON.stringify({
      version: 1,
      repos: { "repo-upgrade": { activeGroupId: "group-1", groups: [] } },
    });

    writeUpgradeRunner(runnerPath, {
      legacyItems: [
        [favoritesKey, favoritesVal],
        [terminalLayoutKey, terminalLayoutVal],
        ["other-app:auth-token", "must-not-migrate"],
      ],
      deleteAfterUpgradeKey: favoritesKey,
      markerFileName: "legacy-profile-migration.json",
    });

    const seeded = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "seed_legacy")) as { seeded: boolean };
    assert.equal(seeded.seeded, true);
    writeFileSync(path.join(legacyDir, "Cookies"), "third-party-cookie-blob", "utf8");

    const launch1 = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "upgrade_launch_1")) as {
      userData: string;
      migrationResult: { status: string; copiedCount: number };
      markerExists: boolean;
      dump: Record<string, string>;
    };
    assert.equal(path.resolve(launch1.userData), path.resolve(targetDir));
    assert.deepEqual(launch1.migrationResult, { status: "migrated", copiedCount: 2 });
    assert.equal(launch1.markerExists, true);
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
      migrationResult: { status: string; copiedCount: number };
      dump: Record<string, string>;
    };
    assert.deepEqual(launch2.migrationResult, { status: "skipped", copiedCount: 0 });
    assert.equal(launch2.dump[favoritesKey], undefined);
    assert.equal(launch2.dump[terminalLayoutKey], terminalLayoutVal);
    assert.equal(launch2.dump["other-app:auth-token"], undefined);
    assert.equal(readFileSync(path.join(legacyDir, "third-party-marker.txt"), "utf8"), "keep-in-electron-dir");
  },
);

test(
  "F3 integration: partial Chromium migration exposes error, recovers missing keys on restart without clobbering newer keys, and preserves post-completion deletes",
  { timeout: 120_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason ?? "Electron runtime unavailable.");
      return;
    }
    t.after(runtime.close);

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-upgrade-mig-retry-"));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

    const appDataDir = path.join(tempRoot, "AppData");
    const targetDir = path.join(appDataDir, "Harness Anything");
    const runnerPath = path.join(tempRoot, "runner.mjs");

    const favoritesKey = "harness:gui:favorites:repo-retry";
    const favoritesLegacyVal = JSON.stringify(["task_legacy"]);
    const favoritesNewerVal = JSON.stringify(["task_newer_override"]);
    const partialKey = "harness:gui:recent-repo";
    const partialVal = "repo-legacy-partial";
    const terminalLayoutKey = "harness:gui:terminal-layout";
    const terminalLayoutVal = JSON.stringify({
      version: 1,
      repos: { "repo-retry": { activeGroupId: "group-recovered", groups: [] } },
    });

    writeUpgradeRunner(runnerPath, {
      legacyItems: [
        [favoritesKey, favoritesLegacyVal],
        [partialKey, partialVal],
        [terminalLayoutKey, terminalLayoutVal],
        ["other-app:auth-token", "must-not-migrate"],
      ],
      newerTargetItems: [[favoritesKey, favoritesNewerVal]],
      partialFailureItems: [[partialKey, partialVal]],
      deleteAfterUpgradeKey: partialKey,
      markerFileName: "legacy-profile-migration.json",
    });

    const seeded = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "seed_legacy")) as { seeded: boolean };
    assert.equal(seeded.seeded, true);

    const seededTarget = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "seed_target_newer")) as {
      seededTarget: boolean;
    };
    assert.equal(seededTarget.seededTarget, true);

    // Partial write throws during migration: failure must be exposed, target DB remains intact,
    // no completion marker may be written, and partial/newer data stays safe for recovery.
    const failedLaunch = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "partial_failure_launch")) as {
      rejected: boolean;
      errorMessage: string;
      targetDbExists: boolean;
      markerExists: boolean;
      dump: Record<string, string>;
    };
    assert.equal(failedLaunch.rejected, true);
    assert.match(failedLaunch.errorMessage, /Injected partial-write migration interruption/u);
    assert.equal(failedLaunch.targetDbExists, true);
    assert.equal(failedLaunch.markerExists, false);
    assert.equal(failedLaunch.dump[favoritesKey], favoritesNewerVal);
    assert.equal(failedLaunch.dump[partialKey], partialVal);
    assert.equal(failedLaunch.dump[terminalLayoutKey], undefined);

    // Restart after failure: target DB already exists on disk, so migration must still recover
    // missing terminalLayoutKey without overwriting newer favoritesNewerVal, then delete partialKey.
    const recoveryLaunch = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "restart_recovery")) as {
      userData: string;
      migrationResult: { status: string; copiedCount: number };
      markerExists: boolean;
      dump: Record<string, string>;
    };
    assert.equal(path.resolve(recoveryLaunch.userData), path.resolve(targetDir));
    assert.deepEqual(recoveryLaunch.migrationResult, { status: "migrated", copiedCount: 1 });
    assert.equal(recoveryLaunch.markerExists, true);
    assert.equal(recoveryLaunch.dump[favoritesKey], favoritesNewerVal);
    assert.equal(recoveryLaunch.dump[partialKey], partialVal);
    assert.equal(recoveryLaunch.dump[terminalLayoutKey], terminalLayoutVal);
    assert.equal(recoveryLaunch.dump["other-app:auth-token"], undefined);

    // Next restart after confirmed completion must skip and NOT resurrect user-deleted partialKey.
    const postCompletionLaunch = JSON.parse(spawnElectronRunner(runnerPath, appDataDir, "post_completion_restart")) as {
      migrationResult: { status: string; copiedCount: number };
      markerExists: boolean;
      dump: Record<string, string>;
    };
    assert.deepEqual(postCompletionLaunch.migrationResult, { status: "skipped", copiedCount: 0 });
    assert.equal(postCompletionLaunch.markerExists, true);
    assert.equal(postCompletionLaunch.dump[favoritesKey], favoritesNewerVal);
    assert.equal(postCompletionLaunch.dump[terminalLayoutKey], terminalLayoutVal);
    assert.equal(postCompletionLaunch.dump[partialKey], undefined);
    assert.equal(postCompletionLaunch.dump["other-app:auth-token"], undefined);
  },
);

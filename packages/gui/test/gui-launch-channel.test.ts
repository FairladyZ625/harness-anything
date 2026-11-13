// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateSecondInstance,
  applyGuiAppIdentity,
  bindWindowReadiness,
  createLaunchSignalReporter,
  createSecondaryAckWaiter,
  ensureGuiWindowReadyAndVisible,
  GUI_APP_NAME,
  GUI_APP_USER_MODEL_ID,
  GUI_LAUNCH_ADDR_ENV,
  GUI_LAUNCH_TOKEN_ENV,
  isHarnessLocalStorageKey,
  migrateLegacyElectronLocalStorage,
  readLaunchSignalTarget,
  type ReadinessWindowPort,
  resolveLegacyElectronMigrationPlan,
  selectLegacyHarnessEntries,
  sendLoopbackSignal,
  verifyWindowsDesktopSession,
  verifyWindowsWindowHandleVisible,
} from "../src/main/gui-launch-channel.ts";

test("applyGuiAppIdentity brands Harness Anything and isolates un-packaged userData without overriding --user-data-dir", () => {
  const baseApp = (overrides: { hasSwitch?: boolean; isPackaged?: boolean }) => {
    const names: string[] = [];
    const appUserModelIds: string[] = [];
    const paths = new Map<string, string>([
      ["appData", "/Users/alice/Library/Application Support"],
      ["userData", "/Users/alice/Library/Application Support/Electron"],
    ]);
    return {
      app: {
        isPackaged: overrides.isPackaged ?? false,
        commandLine: { hasSwitch: (name: string) => name === "user-data-dir" && (overrides.hasSwitch ?? false) },
        setName: (name: string) => void names.push(name),
        setAppUserModelId: (id: string) => void appUserModelIds.push(id),
        getPath: (name: "appData" | "userData") => paths.get(name) ?? "",
        setPath: (name: "userData", value: string) => void paths.set(name, value),
      },
      names,
      appUserModelIds,
      paths,
    };
  };

  const winUnpackaged = baseApp({});
  applyGuiAppIdentity(winUnpackaged.app, "win32", {});
  assert.deepEqual(winUnpackaged.names, [GUI_APP_NAME]);
  assert.deepEqual(winUnpackaged.appUserModelIds, [GUI_APP_USER_MODEL_ID]);
  assert.equal(
    winUnpackaged.paths.get("userData"),
    path.join("/Users/alice/Library/Application Support", GUI_APP_NAME),
  );

  const winOverriddenProfile = baseApp({});
  winOverriddenProfile.app.getPath = () => {
    throw new Error("Failed to get 'appData' path");
  };
  applyGuiAppIdentity(winOverriddenProfile.app, "win32", { APPDATA: "C:\\isolated\\AppData\\Roaming" });
  assert.equal(winOverriddenProfile.paths.get("userData"), path.join("C:\\isolated\\AppData\\Roaming", GUI_APP_NAME));

  assert.throws(() => applyGuiAppIdentity(winOverriddenProfile.app, "win32", {}), /Failed to get 'appData' path/u);

  const explicitProfile = baseApp({ hasSwitch: true });
  explicitProfile.app.setPath("userData", "/tmp/custom-e2e-profile");
  applyGuiAppIdentity(explicitProfile.app, "darwin", {});
  assert.deepEqual(explicitProfile.names, [GUI_APP_NAME]);
  assert.deepEqual(explicitProfile.appUserModelIds, []);
  assert.equal(explicitProfile.paths.get("userData"), "/tmp/custom-e2e-profile");

  const packaged = baseApp({ isPackaged: true });
  applyGuiAppIdentity(packaged.app, "win32", {});
  assert.equal(packaged.paths.get("userData"), "/Users/alice/Library/Application Support/Electron");
});

test("readLaunchSignalTarget validates loopback address and strips env vars", () => {
  const env: Record<string, string | undefined> = {
    [GUI_LAUNCH_ADDR_ENV]: "127.0.0.1:45123",
    [GUI_LAUNCH_TOKEN_ENV]: "abc123",
  };
  assert.deepEqual(readLaunchSignalTarget(env), { addr: "127.0.0.1:45123", token: "abc123" });
  assert.equal(env[GUI_LAUNCH_ADDR_ENV], undefined);
  assert.equal(env[GUI_LAUNCH_TOKEN_ENV], undefined);

  const nonLoopbackEnv: Record<string, string | undefined> = {
    [GUI_LAUNCH_ADDR_ENV]: "192.168.1.50:45123",
    [GUI_LAUNCH_TOKEN_ENV]: "abc123",
  };
  assert.equal(readLaunchSignalTarget(nonLoopbackEnv), null);
  assert.equal(nonLoopbackEnv[GUI_LAUNCH_ADDR_ENV], undefined);
  assert.equal(nonLoopbackEnv[GUI_LAUNCH_TOKEN_ENV], undefined);
});

test("createLaunchSignalReporter delivers at most once even under repeated calls", async () => {
  const sent: Array<{ ok: boolean; reason?: string }> = [];
  const reporter = createLaunchSignalReporter({ addr: "127.0.0.1:45123", token: "tok" }, async (_target, payload) => {
    sent.push({ ok: payload.ok, reason: payload.reason });
    return true;
  });
  await Promise.all([
    reporter.report({ ok: true, mode: "window", pid: 100 }),
    reporter.report({ ok: false, reason: "late_error" }),
  ]);
  assert.equal(reporter.hasReported(), true);
  assert.deepEqual(sent, [{ ok: true, reason: undefined }]);
});

test("secondary ack waiter receives authenticated activation signal over loopback and rejects timeout", async () => {
  const waiter = await createSecondaryAckWaiter(5_000);
  try {
    const [wrongAccepted, rightAccepted, result] = await Promise.all([
      sendLoopbackSignal({ addr: waiter.ackAddr, token: "wrong-token" }, { ok: false, reason: "spoofed" }),
      sendLoopbackSignal(
        { addr: waiter.ackAddr, token: waiter.ackToken },
        { ok: true, mode: "second_instance", pid: 555 },
      ),
      waiter.wait(),
    ]);
    assert.equal(wrongAccepted, false);
    assert.equal(rightAccepted, true);
    assert.deepEqual(result, { ok: true, mode: "second_instance", pid: 555 });
  } finally {
    waiter.close();
  }

  const timedOutWaiter = await createSecondaryAckWaiter(300);
  try {
    const timedOut = await timedOutWaiter.wait();
    assert.equal(timedOut.ok, false);
    assert.match(String(timedOut.reason ?? ""), /did not acknowledge/u);
  } finally {
    timedOutWaiter.close();
  }
});

test("Windows desktop session and window handle probes classify Session 0, MainWindowHandle=0, and interactive windows", async () => {
  assert.deepEqual(await verifyWindowsDesktopSession(async () => "True:1"), { ok: true });
  const session0 = await verifyWindowsDesktopSession(async () => "False:0");
  assert.equal(session0.ok, false);
  assert.equal(session0.reason, "non_interactive_windows_session");
  assert.match(String(session0.detail ?? ""), /Session 0/u);

  assert.deepEqual(await verifyWindowsWindowHandleVisible(4242, async () => "True:1:721050"), { ok: true });
  const invisibleHandle = await verifyWindowsWindowHandleVisible(4242, async () => "True:1:0");
  assert.equal(invisibleHandle.ok, false);
  assert.equal(invisibleHandle.reason, "gui_window_not_visible");
  const hiddenSession0 = await verifyWindowsWindowHandleVisible(4242, async () => "False:0:0");
  assert.equal(hiddenSession0.ok, false);
  assert.equal(hiddenSession0.reason, "non_interactive_windows_session");

  const probeFailure = await verifyWindowsDesktopSession(async () => {
    throw new Error("powershell unavailable");
  });
  assert.equal(probeFailure.ok, false);
  assert.equal(probeFailure.reason, "windows_session_probe_failed");
  assert.match(String(probeFailure.detail ?? ""), /powershell unavailable/u);
});

class MockWebContents extends EventEmitter {
  crashed = false;
  isCrashed(): boolean {
    return this.crashed;
  }
}

class MockBrowserWindow extends EventEmitter implements ReadinessWindowPort {
  readonly webContents = new MockWebContents();
  destroyed = false;
  visible = false;
  minimized = false;
  focused = false;
  handleBytes = 8;
  showCalls = 0;
  focusCalls = 0;
  restoreCalls = 0;

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.restoreCalls += 1;
    this.minimized = false;
  }
  show(): void {
    this.showCalls += 1;
    this.visible = true;
  }
  focus(): void {
    this.focusCalls += 1;
    this.focused = true;
  }
  getNativeWindowHandle(): { readonly length: number } {
    return { length: this.handleBytes };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("F1: post-ready-to-show render-process-gone, did-fail-load, closed, and load rejection revoke readiness even during Win32 probing", async () => {
  // Case 1: ready-to-show -> async Windows handle probe starts -> render-process-gone fires BEFORE probe resolves ok.
  {
    const win = new MockBrowserWindow();
    const load = deferred<void>();
    const tracker = bindWindowReadiness(win, load.promise, false);
    const probe = deferred<{ ok: true }>();

    win.emit("ready-to-show");
    assert.equal(tracker.isReady(), true);
    assert.equal(win.showCalls, 1);

    const ensuring = ensureGuiWindowReadyAndVisible(win, tracker, {
      backgroundTest: false,
      platform: "win32",
      pid: 999,
      verifyWindowsVisible: async () => probe.promise,
    });

    win.webContents.crashed = true;
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    probe.resolve({ ok: true });

    await assert.rejects(ensuring, /GUI renderer exited unexpectedly \(crashed\)/u);
    assert.equal(tracker.isReady(), false);
  }

  // Case 2: benign -3 abort on did-fail-load must not disarm listener for real main-frame failure after ready-to-show.
  {
    const win = new MockBrowserWindow();
    const load = deferred<void>();
    const tracker = bindWindowReadiness(win, load.promise, false);
    const probe = deferred<{ ok: true }>();

    win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///app/sub", false);
    win.emit("ready-to-show");

    const ensuring = ensureGuiWindowReadyAndVisible(win, tracker, {
      backgroundTest: false,
      platform: "win32",
      pid: 999,
      verifyWindowsVisible: async () => probe.promise,
    });

    win.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///app/index.html", true);
    probe.resolve({ ok: true });

    await assert.rejects(ensuring, /ERR_FILE_NOT_FOUND/u);
    assert.equal(tracker.isReady(), false);
  }

  // Case 3: ready-to-show followed by late loadPromise rejection (both pre-check and Win32 probe race).
  {
    const win = new MockBrowserWindow();
    const load = deferred<void>();
    const tracker = bindWindowReadiness(win, load.promise, false);
    win.emit("ready-to-show");
    assert.equal(tracker.isReady(), true);

    load.reject(new Error("ERR_FAILED (-2)"));
    await Promise.resolve();
    await assert.rejects(
      ensureGuiWindowReadyAndVisible(win, tracker, { backgroundTest: false, platform: "darwin" }),
      /Failed to load GUI document: ERR_FAILED \(-2\)/u,
    );
    assert.equal(tracker.isReady(), false);
  }

  {
    const win = new MockBrowserWindow();
    const load = deferred<void>();
    const probe = deferred<{ ok: true }>();
    const tracker = bindWindowReadiness(win, load.promise, false);
    win.emit("ready-to-show");

    const ensuring = ensureGuiWindowReadyAndVisible(win, tracker, {
      backgroundTest: false,
      platform: "win32",
      pid: 999,
      verifyWindowsVisible: async () => probe.promise,
    });
    load.reject(new Error("ERR_FAILED (-2)"));
    probe.resolve({ ok: true });

    await assert.rejects(ensuring, /Failed to load GUI document: ERR_FAILED \(-2\)/u);
    assert.equal(tracker.isReady(), false);
  }

  // Case 4: did-fail-load before ready-to-show prevents ready-to-show from showing/focusing/marking ready.
  {
    const win = new MockBrowserWindow();
    const load = deferred<void>();
    const tracker = bindWindowReadiness(win, load.promise, false);
    win.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///missing.html", true);
    win.emit("ready-to-show");
    assert.equal(win.showCalls, 0);
    assert.equal(win.focusCalls, 0);
    assert.equal(tracker.isReady(), false);
    await assert.rejects(
      ensureGuiWindowReadyAndVisible(win, tracker, { backgroundTest: false, platform: "darwin" }),
      /ERR_FILE_NOT_FOUND/u,
    );
  }

  // Case 5: closed while Win32 probe is pending rejects immediately without waiting for slow probe timeout.
  {
    const win = new MockBrowserWindow();
    const tracker = bindWindowReadiness(win, Promise.resolve(), false);
    win.emit("ready-to-show");
    const slowProbe = deferred<{ ok: true }>();
    const ensuring = ensureGuiWindowReadyAndVisible(win, tracker, {
      backgroundTest: false,
      platform: "win32",
      pid: 999,
      verifyWindowsVisible: async () => slowProbe.promise,
    });
    win.destroyed = true;
    win.emit("closed");
    await assert.rejects(ensuring, /GUI window closed before finishing startup/u);
  }
});

test("F2: secondary activation restores/shows/focuses already-visible unfocused windows unless headless or explicitly invalid", async () => {
  // Case 1: visible, non-minimized, unfocused existing window on argument-free second ha gui.
  {
    const win = new MockBrowserWindow();
    const tracker = bindWindowReadiness(win, Promise.resolve(), false);
    win.emit("ready-to-show");
    win.visible = true;
    win.minimized = false;
    win.focused = false;
    win.showCalls = 0;
    win.focusCalls = 0;

    const result = await activateSecondInstance({
      request: {
        requestedRoot: null,
        explicitRoot: false,
        requesterHeadless: false,
        primaryHeadless: false,
      },
      pid: 31337,
      resolveRequestedRoot: async () => ({ ok: false, reason: "should not be called" }),
      openProjectWindow: () => null,
      existingOrNewWindow: () => win,
      ensureWindowReady: (target) =>
        ensureGuiWindowReadyAndVisible(target, tracker, { backgroundTest: false, platform: "darwin" }),
    });

    assert.deepEqual(result, { ok: true, mode: "second_instance", pid: 31337 });
    assert.equal(win.showCalls, 1);
    assert.equal(win.focusCalls, 1);
    assert.equal(win.focused, true);
  }

  // Case 2: secondary launch from unregistered directory with explicitRoot=false falls back and focuses visible unfocused window.
  {
    const win = new MockBrowserWindow();
    const tracker = bindWindowReadiness(win, Promise.resolve(), false);
    win.emit("ready-to-show");
    win.visible = true;
    win.minimized = false;
    win.focused = false;
    win.showCalls = 0;
    win.focusCalls = 0;

    const result = await activateSecondInstance({
      request: {
        requestedRoot: "/tmp/not-a-registered-repo",
        explicitRoot: false,
        requesterHeadless: false,
        primaryHeadless: false,
      },
      pid: 4242,
      resolveRequestedRoot: async () => ({ ok: false, reason: "Repository is not registered." }),
      openProjectWindow: () => null,
      existingOrNewWindow: () => win,
      ensureWindowReady: (target) =>
        ensureGuiWindowReadyAndVisible(target, tracker, {
          backgroundTest: false,
          platform: "win32",
          pid: 4242,
          verifyWindowsVisible: async () => ({ ok: true }),
        }),
    });

    assert.deepEqual(result, { ok: true, mode: "second_instance", pid: 4242 });
    assert.equal(win.showCalls, 1);
    assert.equal(win.focusCalls, 1);
    assert.equal(win.focused, true);
  }

  // Case 3: explicit --root pointing to unregistered repo rejects without focusing fallback window.
  {
    const win = new MockBrowserWindow();
    const tracker = bindWindowReadiness(win, Promise.resolve(), false);
    win.emit("ready-to-show");
    win.showCalls = 0;
    win.focusCalls = 0;

    const result = await activateSecondInstance({
      request: {
        requestedRoot: "/tmp/bad-explicit-root",
        explicitRoot: true,
        requesterHeadless: false,
        primaryHeadless: false,
      },
      pid: 4242,
      resolveRequestedRoot: async () => ({ ok: false, reason: "Unknown repository root." }),
      openProjectWindow: () => null,
      existingOrNewWindow: () => win,
      ensureWindowReady: (target) =>
        ensureGuiWindowReadyAndVisible(target, tracker, { backgroundTest: false, platform: "darwin" }),
    });

    assert.deepEqual(result, { ok: false, reason: "Unknown repository root." });
    assert.equal(win.showCalls, 0);
    assert.equal(win.focusCalls, 0);
  }

  // Case 4: minimized window calls restore + show + focus; headless never touches restore/show/focus.
  {
    const win = new MockBrowserWindow();
    const tracker = bindWindowReadiness(win, Promise.resolve(), false);
    win.emit("ready-to-show");
    win.minimized = true;
    win.showCalls = 0;
    win.focusCalls = 0;
    await ensureGuiWindowReadyAndVisible(win, tracker, { backgroundTest: false, platform: "darwin" });
    assert.equal(win.restoreCalls, 1);
    assert.equal(win.showCalls, 1);
    assert.equal(win.focusCalls, 1);

    const headlessWin = new MockBrowserWindow();
    const headlessTracker = bindWindowReadiness(headlessWin, Promise.resolve(), true);
    headlessWin.webContents.emit("did-finish-load");
    await ensureGuiWindowReadyAndVisible(headlessWin, headlessTracker, { backgroundTest: true, platform: "win32" });
    assert.equal(headlessWin.restoreCalls, 0);
    assert.equal(headlessWin.showCalls, 0);
    assert.equal(headlessWin.focusCalls, 0);
  }
});

test("F3: legacy Electron migration copies only Harness localStorage keys idempotently and ignores third-party apps", async (t) => {
  assert.equal(isHarnessLocalStorageKey("harness:gui:favorites:repo1"), true);
  assert.equal(isHarnessLocalStorageKey("harness:gui:terminal-layout"), true);
  assert.equal(isHarnessLocalStorageKey("harness-theme"), true);
  assert.equal(isHarnessLocalStorageKey("harness.desktop-first-run.done"), true);
  assert.equal(isHarnessLocalStorageKey("other-app:secret"), false);
  assert.equal(isHarnessLocalStorageKey("theme"), false);

  assert.deepEqual(
    selectLegacyHarnessEntries(
      {
        "harness:gui:favorites:repo1": '["t1"]',
        "harness-theme": "light",
        "other-app:token": "secret",
      },
      new Set(["harness-theme"]),
    ),
    [["harness:gui:favorites:repo1", '["t1"]']],
  );

  const root = mkdtempSync(path.join(os.tmpdir(), "ha-legacy-mig-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, "AppData");
  const legacyDir = path.join(appData, "Electron");
  const targetDir = path.join(appData, GUI_APP_NAME);
  mkdirSync(path.join(legacyDir, "Local Storage", "leveldb"), { recursive: true });
  writeFileSync(path.join(legacyDir, "Cookies"), "third-party-cookie-data", "utf8");

  const fakeApp = (overrides: { hasSwitch?: boolean; isPackaged?: boolean }) => ({
    isPackaged: overrides.isPackaged ?? false,
    commandLine: { hasSwitch: (name: string) => name === "user-data-dir" && (overrides.hasSwitch ?? false) },
    setName: () => undefined,
    getPath: (name: "appData" | "userData") => (name === "appData" ? appData : targetDir),
    setPath: () => undefined,
  });

  // Explicit --user-data-dir and packaged builds must never migrate.
  assert.equal(
    resolveLegacyElectronMigrationPlan(fakeApp({ hasSwitch: true }), "win32", { APPDATA: appData }).copyRequired,
    false,
  );
  assert.equal(
    resolveLegacyElectronMigrationPlan(fakeApp({ isPackaged: true }), "win32", { APPDATA: appData }).copyRequired,
    false,
  );

  let readCalls = 0;
  const migratedStore = new Map<string, string>();
  const firstRun = await migrateLegacyElectronLocalStorage({
    app: fakeApp({}),
    platform: "win32",
    env: { APPDATA: appData },
    readLegacyEntries: async (dir) => {
      readCalls += 1;
      assert.equal(dir, legacyDir);
      return {
        "harness:gui:favorites:repo1": '["task_1","task_2"]',
        "harness:gui:terminal-layout": '{"activeGroupId":"g1","groups":[]}',
        "other-app:token": "must-not-migrate",
      };
    },
    writeMissingTargetEntries: async (dir, entries) => {
      assert.equal(dir, targetDir);
      mkdirSync(path.join(dir, "Local Storage", "leveldb"), { recursive: true });
      for (const [k, v] of entries) migratedStore.set(k, v);
      return entries.length;
    },
  });

  assert.deepEqual(firstRun, { status: "migrated", copiedCount: 2 });
  assert.equal(readCalls, 1);
  assert.equal(migratedStore.get("harness:gui:favorites:repo1"), '["task_1","task_2"]');
  assert.equal(migratedStore.get("harness:gui:terminal-layout"), '{"activeGroupId":"g1","groups":[]}');
  assert.equal(migratedStore.has("other-app:token"), false);

  // Idempotent on subsequent launch once target Local Storage/leveldb exists.
  const secondRun = await migrateLegacyElectronLocalStorage({
    app: fakeApp({}),
    platform: "win32",
    env: { APPDATA: appData },
    readLegacyEntries: async () => {
      throw new Error("should not re-read legacy store");
    },
    writeMissingTargetEntries: async () => 0,
  });
  assert.deepEqual(secondRun, { status: "skipped", copiedCount: 0 });
});

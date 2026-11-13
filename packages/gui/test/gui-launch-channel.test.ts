// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  applyGuiAppIdentity,
  createLaunchSignalReporter,
  createSecondaryAckWaiter,
  GUI_APP_NAME,
  GUI_APP_USER_MODEL_ID,
  GUI_LAUNCH_ADDR_ENV,
  GUI_LAUNCH_TOKEN_ENV,
  readLaunchSignalTarget,
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

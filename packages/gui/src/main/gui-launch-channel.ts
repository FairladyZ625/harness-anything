import { guiInteractionPolicy } from "@harness-anything/kernel/internal/domain/gui-interaction-policy.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const GUI_APP_NAME = "Harness Anything";
export const LEGACY_ELECTRON_DIR_NAME = "Electron";
export const LEGACY_PROFILE_MIGRATION_MARKER = "legacy-profile-migration.json";
export const GUI_APP_USER_MODEL_ID = "dev.harness-anything.gui";
export const GUI_LAUNCH_ADDR_ENV = "HARNESS_GUI_LAUNCH_ADDR";
export const GUI_LAUNCH_TOKEN_ENV = "HARNESS_GUI_LAUNCH_TOKEN";
export const GUI_ROOT_EXPLICIT_ENV = "HARNESS_GUI_ROOT_EXPLICIT";

const LOOPBACK_HOST = "127.0.0.1";
const LAUNCH_SIGNAL_SOCKET_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceShow;
const SECONDARY_ACK_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceOperation;
const WIN32_PROBE_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceOperation;

export interface GuiLaunchSignalTarget {
  readonly addr: string;
  readonly token: string;
}

export interface GuiLaunchSignalPayload {
  readonly ok: boolean;
  readonly mode?: string;
  readonly pid?: number;
  readonly reason?: string;
  readonly detail?: string;
}

export interface GuiIdentityApp {
  readonly isPackaged: boolean;
  readonly commandLine: { hasSwitch(name: string): boolean };
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", value: string): void;
}

export interface WindowsSessionCheckResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export type PowerShellRunner = (command: string) => Promise<string>;

function resolveAppDataDir(
  appLike: GuiIdentityApp,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string {
  // On Windows under SSH/service/overridden USERPROFILE, Chromium's SHGetKnownFolderPath
  // can throw on getPath("appData") even when APPDATA is explicitly configured.
  if (platform === "win32") {
    const configuredAppData = env.APPDATA?.trim();
    if (configuredAppData) return configuredAppData;
  }
  return appLike.getPath("appData");
}

/** Brand Electron with Harness Anything identity and isolate dev userData from generic %APPDATA%/Electron. */
export function applyGuiAppIdentity(
  appLike: GuiIdentityApp,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): void {
  appLike.setName(GUI_APP_NAME);
  if (platform === "win32") appLike.setAppUserModelId?.(GUI_APP_USER_MODEL_ID);
  // Packaged builds already receive productName from electron-builder; source/CLI runs keep
  // generic "Electron" userData unless overridden here (while honoring explicit --user-data-dir).
  if (!appLike.commandLine.hasSwitch("user-data-dir") && !appLike.isPackaged) {
    appLike.setPath("userData", path.join(resolveAppDataDir(appLike, platform, env), GUI_APP_NAME));
  }
}

/** Read and clear one-shot launcher readiness env vars so child renderers and shells never inherit them. */
export function readLaunchSignalTarget(
  env: Record<string, string | undefined> = process.env,
): GuiLaunchSignalTarget | null {
  const addr = env[GUI_LAUNCH_ADDR_ENV]?.trim();
  const token = env[GUI_LAUNCH_TOKEN_ENV]?.trim();
  delete env[GUI_LAUNCH_ADDR_ENV];
  delete env[GUI_LAUNCH_TOKEN_ENV];
  if (!addr || !token) return null;
  if (parseLoopbackPort(addr) === null) return null;
  return { addr, token };
}

export function parseLoopbackPort(addr: string): number | null {
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(addr.trim());
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

/** Send one authenticated JSON status line to a CLI/secondary loopback listener and await its ACK close. */
export function sendLoopbackSignal(target: GuiLaunchSignalTarget, payload: GuiLaunchSignalPayload): Promise<boolean> {
  const port = parseLoopbackPort(target.addr);
  if (port === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(delivered);
    };
    const socket = net.connect({ host: LOOPBACK_HOST, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, LAUNCH_SIGNAL_SOCKET_TIMEOUT_MS);
    timer.unref?.();
    let acked = false;
    socket.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("ack")) acked = true;
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(acked));
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ token: target.token, ...payload })}\n`);
    });
  });
}

export interface GuiLaunchSignalReporter {
  report(payload: GuiLaunchSignalPayload): Promise<boolean>;
  hasReported(): boolean;
}

/** Guarantee at-most-once delivery of GUI readiness/failure back to `ha gui`. */
export function createLaunchSignalReporter(
  target: GuiLaunchSignalTarget,
  sender: (target: GuiLaunchSignalTarget, payload: GuiLaunchSignalPayload) => Promise<boolean> = sendLoopbackSignal,
): GuiLaunchSignalReporter {
  let promise: Promise<boolean> | null = null;
  return {
    hasReported: () => promise !== null,
    report(payload) {
      if (promise === null) promise = sender(target, payload);
      return promise;
    },
  };
}

export interface SecondaryAckWaiter {
  readonly ackAddr: string;
  readonly ackToken: string;
  wait(): Promise<GuiLaunchSignalPayload>;
  close(): void;
}

/** Ephemeral loopback listener used by a non-lock-holding Electron instance to await primary activation. */
export async function createSecondaryAckWaiter(
  timeoutMs: number = SECONDARY_ACK_TIMEOUT_MS,
): Promise<SecondaryAckWaiter> {
  const ackToken = randomBytes(16).toString("hex");
  let settleWait: ((payload: GuiLaunchSignalPayload) => void) | null = null;
  let resultPayload: GuiLaunchSignalPayload | null = null;
  const finishWait = (payload: GuiLaunchSignalPayload) => {
    if (resultPayload !== null) return;
    resultPayload = payload;
    clearTimeout(timer);
    server.close();
    settleWait?.(payload);
  };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      const parsed = parseSignalMessage(line, ackToken);
      if (parsed !== null) {
        socket.end("ack\n");
        finishWait(parsed);
      } else {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not bind loopback secondary-instance ACK socket.");
  }
  const timer = setTimeout(() => {
    finishWait({
      ok: false,
      reason: "Existing Harness Anything GUI lock holder did not acknowledge window activation.",
    });
  }, timeoutMs);
  timer.unref?.();
  return {
    ackAddr: `${LOOPBACK_HOST}:${address.port}`,
    ackToken,
    wait: () =>
      resultPayload !== null
        ? Promise.resolve(resultPayload)
        : new Promise((resolve) => {
            settleWait = resolve;
          }),
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

function tryParseJsonSignal(
  line: string,
): { readonly valid: true; readonly value: unknown } | { readonly valid: false } {
  try {
    return { valid: true, value: JSON.parse(line) };
  } catch {
    return { valid: false };
  }
}

export function parseSignalMessage(line: string, expectedToken: string): GuiLaunchSignalPayload | null {
  const parsed = tryParseJsonSignal(line);
  if (!parsed.valid || typeof parsed.value !== "object" || parsed.value === null) return null;
  const record = parsed.value as Record<string, unknown>;
  if (record.token !== expectedToken || typeof record.ok !== "boolean") return null;
  return {
    ok: record.ok,
    ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
  };
}

function defaultPowerShellRunner(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: WIN32_PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = typeof stderr === "string" ? stderr.trim() : "";
          reject(new Error(stderrText || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export function parseWindowsDesktopProbe(output: string): {
  readonly userInteractive: boolean;
  readonly sessionId: number;
  readonly mainWindowHandle?: string;
} | null {
  const parts = output.trim().split(":");
  if (parts.length < 2) return null;
  const interactiveRaw = parts[0]?.toLowerCase();
  if (interactiveRaw !== "true" && interactiveRaw !== "false") return null;
  const sessionId = Number(parts[1]);
  if (!Number.isInteger(sessionId) || sessionId < 0) return null;
  return {
    userInteractive: interactiveRaw === "true",
    sessionId,
    ...(parts[2] !== undefined ? { mainWindowHandle: parts[2].trim() } : {}),
  };
}

function nonInteractiveWindowsSessionResult(sessionId: number): WindowsSessionCheckResult {
  return {
    ok: false,
    reason: "non_interactive_windows_session",
    detail:
      `Cannot display a desktop GUI window in non-interactive Windows Session ${sessionId} ` +
      "(Service / SSH / WinRM). Run `ha gui` from an interactive desktop terminal, or use `ha gui --browser`.",
  };
}

async function executeWindowsProbe(
  command: string,
  failureReason: string,
  fallbackError: string,
  runPowerShell: PowerShellRunner,
): Promise<
  | { readonly ok: true; readonly parsed: NonNullable<ReturnType<typeof parseWindowsDesktopProbe>> }
  | { readonly ok: false; readonly failure: WindowsSessionCheckResult }
> {
  let output: string;
  try {
    output = await runPowerShell(command);
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: failureReason,
        detail: error instanceof Error ? error.message : fallbackError,
      },
    };
  }
  const parsed = parseWindowsDesktopProbe(output);
  if (!parsed) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: failureReason,
        detail: `Unexpected Windows probe output: ${output || "<empty>"}`,
      },
    };
  }
  if (!parsed.userInteractive || parsed.sessionId === 0) {
    return { ok: false, failure: nonInteractiveWindowsSessionResult(parsed.sessionId) };
  }
  return { ok: true, parsed };
}

/** Verify the Windows process runs inside an interactive desktop session rather than Session 0 (SSH/service). */
export async function verifyWindowsDesktopSession(
  runPowerShell: PowerShellRunner = defaultPowerShellRunner,
): Promise<WindowsSessionCheckResult> {
  const probe = await executeWindowsProbe(
    "Write-Output ([Environment]::UserInteractive.ToString() + ':' + [Diagnostics.Process]::GetCurrentProcess().SessionId)",
    "windows_session_probe_failed",
    "PowerShell session probe failed.",
    runPowerShell,
  );
  return probe.ok ? { ok: true } : probe.failure;
}

/** Verify at the Win32 process level that Windows shows a real non-zero MainWindowHandle on the desktop. */
export async function verifyWindowsWindowHandleVisible(
  pid: number,
  runPowerShell: PowerShellRunner = defaultPowerShellRunner,
): Promise<WindowsSessionCheckResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "gui_window_not_visible", detail: "Invalid Electron process pid." };
  }
  const probe = await executeWindowsProbe(
    `$p = Get-Process -Id ${pid}; Write-Output ([Environment]::UserInteractive.ToString() + ':' + $p.SessionId + ':' + $p.MainWindowHandle)`,
    "windows_window_probe_failed",
    "PowerShell window handle probe failed.",
    runPowerShell,
  );
  if (!probe.ok) return probe.failure;
  if (!probe.parsed.mainWindowHandle || probe.parsed.mainWindowHandle === "0") {
    return {
      ok: false,
      reason: "gui_window_not_visible",
      detail: "Electron started, but Windows did not expose a visible desktop window (MainWindowHandle=0).",
    };
  }
  return { ok: true };
}

export interface WindowReadinessTracker {
  isReady(): boolean;
  failure(): string | null;
  markReady(): void;
  markFailed(message: string): void;
  waitUntilReady(): Promise<void>;
  verifyHealthy(): void;
  raceFailure<T>(operation: Promise<T>): Promise<T>;
}

/**
 * Tracks window startup readiness while keeping subsequent load/crash/close failures
 * authoritative so a window never reports healthy after `ready-to-show` races with failure.
 */
export function createWindowReadinessTracker(): WindowReadinessTracker {
  let ready = false;
  let failureMessage: string | null = null;
  const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const failureListeners = new Set<{ readonly notify: (error: Error) => void; active: boolean }>();

  return {
    isReady: () => ready && failureMessage === null,
    failure: () => failureMessage,
    markReady() {
      if (failureMessage !== null || ready) return;
      ready = true;
      for (const waiter of readyWaiters) waiter.resolve();
      readyWaiters.clear();
    },
    markFailed(message) {
      ready = false;
      if (failureMessage === null) failureMessage = message;
      const error = new Error(failureMessage);
      for (const waiter of readyWaiters) waiter.reject(error);
      readyWaiters.clear();
      for (const listener of failureListeners) {
        if (listener.active) listener.notify(error);
      }
      failureListeners.clear();
    },
    waitUntilReady() {
      if (failureMessage !== null) return Promise.reject(new Error(failureMessage));
      if (ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        readyWaiters.add({ resolve, reject });
      });
    },
    verifyHealthy() {
      if (failureMessage !== null) throw new Error(failureMessage);
      if (!ready) throw new Error("GUI window did not finish becoming ready.");
    },
    raceFailure<T>(operation: Promise<T>): Promise<T> {
      if (failureMessage !== null) {
        void operation.catch(() => undefined);
        return Promise.reject(new Error(failureMessage));
      }
      let listenerEntry: { readonly notify: (error: Error) => void; active: boolean } | null = null;
      const onFail = new Promise<never>((_resolve, reject) => {
        listenerEntry = { notify: reject, active: true };
        failureListeners.add(listenerEntry);
      });
      void operation.catch(() => undefined);
      return Promise.race([operation, onFail]).finally(() => {
        if (listenerEntry !== null) listenerEntry.active = false;
      });
    },
  };
}

export interface ReadinessWindowPort {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  getNativeWindowHandle(): { readonly length: number };
  once(event: "ready-to-show" | "closed", listener: () => void): void;
  readonly webContents: {
    isCrashed?(): boolean;
    on(
      event: "did-fail-load",
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ): void;
    on(event: "render-process-gone", listener: (event: unknown, details: { readonly reason: string }) => void): void;
    once(event: "did-finish-load", listener: () => void): void;
    off?: ((
      event: "did-fail-load",
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ) => void) &
      ((
        event: "render-process-gone",
        listener: (event: unknown, details: { readonly reason: string }) => void,
      ) => void);
  };
}

/** Restore a minimized window, show it, and raise desktop keyboard focus unconditionally. */
export function focusDesktopWindow(win: Pick<ReadinessWindowPort, "isMinimized" | "restore" | "show" | "focus">): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Bind main-window lifecycle events onto a revocable readiness tracker. */
export function bindWindowReadiness(
  win: ReadinessWindowPort,
  loadPromise: Promise<void>,
  backgroundTest: boolean,
): WindowReadinessTracker {
  const tracker = createWindowReadinessTracker();
  const markReadyIfHealthy = (showDesktop: boolean) => {
    if (win.isDestroyed()) {
      tracker.markFailed("GUI window was destroyed before showing.");
      return;
    }
    if (tracker.failure() !== null) return;
    if (win.webContents.isCrashed?.()) {
      tracker.markFailed("GUI renderer crashed before showing.");
      return;
    }
    if (showDesktop) focusDesktopWindow(win);
    tracker.markReady();
  };

  if (backgroundTest) {
    win.webContents.once("did-finish-load", () => markReadyIfHealthy(false));
  } else {
    win.once("ready-to-show", () => markReadyIfHealthy(true));
  }

  const onDidFailLoad = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && errorCode !== -3) {
      tracker.markFailed(`Failed to load GUI (${errorCode}: ${errorDescription}) at ${validatedURL}`);
    }
  };
  const onRenderProcessGone = (_event: unknown, details: { readonly reason: string }) => {
    if (details.reason !== "clean-exit") {
      tracker.markFailed(`GUI renderer exited unexpectedly (${details.reason}).`);
    }
  };

  win.webContents.on("did-fail-load", onDidFailLoad);
  win.webContents.on("render-process-gone", onRenderProcessGone);
  win.once("closed", () => {
    win.webContents.off?.("did-fail-load", onDidFailLoad);
    win.webContents.off?.("render-process-gone", onRenderProcessGone);
    tracker.markFailed("GUI window closed before finishing startup.");
  });
  void loadPromise.catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Load failed.";
    tracker.markFailed(`Failed to load GUI document: ${detail}`);
  });
  return tracker;
}

export interface EnsureGuiWindowOptions {
  readonly backgroundTest: boolean;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly verifyWindowsVisible?: (pid: number) => Promise<WindowsSessionCheckResult>;
}

/**
 * Wait for window readiness, restore/show/focus desktop windows (even when already visible
 * behind another app), and re-verify health after Win32 visibility probing.
 */
export async function ensureGuiWindowReadyAndVisible(
  win: ReadinessWindowPort,
  tracker: WindowReadinessTracker | undefined,
  options: EnsureGuiWindowOptions,
): Promise<void> {
  const preFailure = tracker?.failure();
  if (preFailure !== null && preFailure !== undefined) throw new Error(preFailure);
  if (tracker && !tracker.isReady()) await tracker.waitUntilReady();
  tracker?.verifyHealthy();
  if (win.isDestroyed()) throw new Error("GUI window was closed before becoming ready.");
  if (win.webContents.isCrashed?.()) throw new Error("GUI renderer crashed before becoming ready.");
  if (options.backgroundTest) return;

  focusDesktopWindow(win);

  tracker?.verifyHealthy();
  if (win.isDestroyed()) throw new Error("GUI window was closed while showing.");
  if (win.webContents.isCrashed?.()) throw new Error("GUI renderer crashed while showing.");
  if (!win.isVisible()) throw new Error("Electron main window reported hidden after show().");
  if (win.getNativeWindowHandle().length === 0) throw new Error("Electron main window has no native handle.");

  if ((options.platform ?? process.platform) === "win32") {
    const verifyVisible = options.verifyWindowsVisible ?? verifyWindowsWindowHandleVisible;
    const probe = verifyVisible(options.pid ?? process.pid);
    const win32Visible = await (tracker ? tracker.raceFailure(probe) : probe);
    tracker?.verifyHealthy();
    if (win.isDestroyed()) throw new Error("GUI window was closed while verifying visibility.");
    if (win.webContents.isCrashed?.()) throw new Error("GUI renderer crashed while verifying visibility.");
    if (!win32Visible.ok) throw new Error(win32Visible.detail ?? win32Visible.reason ?? "Window is not visible.");
  }
}

export interface SecondInstanceActivationParams<TWindow extends ReadinessWindowPort> {
  readonly request: {
    readonly requestedRoot: string | null;
    readonly explicitRoot: boolean;
    readonly requesterHeadless: boolean;
    readonly primaryHeadless: boolean;
  };
  readonly pid: number;
  readonly resolveRequestedRoot: (
    rootDir: string,
  ) => Promise<{ readonly ok: true; readonly repoId: string } | { readonly ok: false; readonly reason: string }>;
  readonly openProjectWindow: (repoId: string) => TWindow | null;
  readonly existingOrNewWindow: () => TWindow | null;
  readonly ensureWindowReady: (win: TWindow) => Promise<void>;
  readonly warn?: (message: string, reason: string) => void;
}

/** Route secondary `ha gui` activation to a target window, verify readiness/focus, and return ACK payload. */
export async function activateSecondInstance<TWindow extends ReadinessWindowPort>(
  params: SecondInstanceActivationParams<TWindow>,
): Promise<GuiLaunchSignalPayload> {
  const { request } = params;
  if (!request.requesterHeadless && request.primaryHeadless) {
    return {
      ok: false,
      reason: "Existing Harness Anything GUI instance is running in --headless mode and cannot show a desktop window.",
    };
  }
  let targetWindow: TWindow | null;
  if (request.requestedRoot === null) {
    targetWindow = params.existingOrNewWindow();
  } else {
    const resolved = await params.resolveRequestedRoot(request.requestedRoot);
    if (resolved.ok) {
      targetWindow = params.openProjectWindow(resolved.repoId);
    } else {
      params.warn?.("[gui] requested project root could not be opened:", resolved.reason);
      if (request.explicitRoot) {
        return { ok: false, reason: resolved.reason };
      }
      targetWindow = params.existingOrNewWindow();
    }
  }
  if (targetWindow === null) {
    return { ok: false, reason: "GUI window could not be created." };
  }
  try {
    await params.ensureWindowReady(targetWindow);
    return { ok: true, mode: "second_instance", pid: params.pid };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : typeof error === "string" ? error : "GUI window could not be shown.";
    return { ok: false, reason: detail };
  }
}

export interface LegacyElectronMigrationPlan {
  readonly copyRequired: boolean;
  readonly legacyUserDataDir: string | null;
  readonly targetUserDataDir: string | null;
  readonly completionMarkerPath: string | null;
}

export type LegacyProfileMigrationResult =
  | { readonly status: "skipped"; readonly copiedCount: 0 }
  | { readonly status: "no_harness_entries"; readonly copiedCount: 0 }
  | { readonly status: "migrated"; readonly copiedCount: number }
  | { readonly status: "failed"; readonly copiedCount: 0; readonly detail: string };

interface LegacyProfileMigrationMarker {
  readonly version: 1;
  readonly confirmed: true;
  readonly hadHarnessEntries: boolean;
  readonly copiedCount: number;
  readonly completedAt: string;
}

/** Check whether an explicit confirmed-completion marker file exists and parses cleanly. */
export function isConfirmedLegacyMigrationMarker(markerPath: string): boolean {
  if (!existsSync(markerPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LegacyProfileMigrationMarker>;
    return (
      parsed.version === 1 &&
      parsed.confirmed === true &&
      typeof parsed.hadHarnessEntries === "boolean" &&
      typeof parsed.copiedCount === "number" &&
      Number.isInteger(parsed.copiedCount) &&
      parsed.copiedCount >= 0 &&
      typeof parsed.completedAt === "string" &&
      parsed.completedAt.length > 0
    );
  } catch {
    return false;
  }
}

function writeLegacyMigrationMarkerAtomic(markerPath: string, hadHarnessEntries: boolean, copiedCount: number): void {
  /* @gate-identity non-state/environment-io.2bb077b1f356c458 */ mkdirSync(path.dirname(markerPath), {
    recursive: true,
  });
  const tempPath = `${markerPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const marker: LegacyProfileMigrationMarker = {
    version: 1,
    confirmed: true,
    hadHarnessEntries,
    copiedCount,
    completedAt: new Date().toISOString(),
  };
  try {
    /* @gate-identity non-state/environment-io.84d45ca9d1ba58bb */ writeFileSync(
      tempPath,
      `${JSON.stringify(marker, null, 2)}\n`,
      "utf8",
    );
    /* @gate-identity non-state/environment-io.184b4306d46e0dce */ renameSync(tempPath, markerPath);
  } catch (error) {
    /* @gate-identity non-state/environment-io.7523d5591544ecd6 */ rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Only localStorage keys owned by Harness Anything may cross from legacy Electron userData. */
export function isHarnessLocalStorageKey(key: string): boolean {
  return key.startsWith("harness:") || key.startsWith("harness-") || key.startsWith("harness.");
}

/** Pick legacy Harness keys that do not exist in target storage yet (never clobbering newer state). */
export function selectLegacyHarnessEntries(
  legacyEntries: Readonly<Record<string, string>>,
  existingTargetKeys: ReadonlySet<string>,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(legacyEntries).filter(([key]) => isHarnessLocalStorageKey(key) && !existingTargetKeys.has(key));
}

/** Determine whether an unpackaged launch still needs confirmed legacy Electron localStorage migration. */
export function resolveLegacyElectronMigrationPlan(
  appLike: GuiIdentityApp,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  pathExists: (candidatePath: string) => boolean = existsSync,
  isMarkerConfirmed?: (markerPath: string) => boolean,
): LegacyElectronMigrationPlan {
  if (appLike.commandLine.hasSwitch("user-data-dir") || appLike.isPackaged) {
    return { copyRequired: false, legacyUserDataDir: null, targetUserDataDir: null, completionMarkerPath: null };
  }
  const appDataDir = resolveAppDataDir(appLike, platform, env);
  const legacyUserDataDir = path.join(appDataDir, LEGACY_ELECTRON_DIR_NAME);
  const targetUserDataDir = path.join(appDataDir, GUI_APP_NAME);
  if (path.resolve(legacyUserDataDir) === path.resolve(targetUserDataDir)) {
    return { copyRequired: false, legacyUserDataDir: null, targetUserDataDir: null, completionMarkerPath: null };
  }
  const completionMarkerPath = path.join(targetUserDataDir, LEGACY_PROFILE_MIGRATION_MARKER);
  const legacyHasDb = pathExists(path.join(legacyUserDataDir, "Local Storage", "leveldb"));
  // Target directory / leveldb existence alone cannot prove migration finished: partial writes
  // or prior target launches still require recovering un-migrated legacy keys until confirmed.
  const confirmedCompleted =
    isMarkerConfirmed !== undefined
      ? isMarkerConfirmed(completionMarkerPath)
      : pathExists === existsSync
        ? isConfirmedLegacyMigrationMarker(completionMarkerPath)
        : pathExists(completionMarkerPath);
  return {
    copyRequired: legacyHasDb && !confirmedCompleted,
    legacyUserDataDir,
    targetUserDataDir,
    completionMarkerPath,
  };
}

/**
 * Migrate only Harness-owned localStorage keys from legacy `appData/Electron` to isolated
 * `appData/Harness Anything` until confirmed completed by an explicit atomic marker.
 * Third-party app keys, cookies, caches, and existing target keys are never copied or overwritten.
 */
export async function migrateLegacyElectronLocalStorage(params: {
  readonly app: GuiIdentityApp;
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string | undefined>;
  readonly pathExists?: (candidatePath: string) => boolean;
  readonly readLegacyEntries: (legacyUserDataDir: string) => Promise<Readonly<Record<string, string>>>;
  readonly readExistingTargetKeys?: (targetUserDataDir: string) => Promise<ReadonlySet<string>>;
  readonly writeMissingTargetEntries: (
    targetUserDataDir: string,
    entries: ReadonlyArray<readonly [string, string]>,
  ) => Promise<number>;
}): Promise<LegacyProfileMigrationResult> {
  const plan = resolveLegacyElectronMigrationPlan(params.app, params.platform, params.env, params.pathExists);
  if (
    !plan.copyRequired ||
    plan.legacyUserDataDir === null ||
    plan.targetUserDataDir === null ||
    plan.completionMarkerPath === null
  ) {
    return { status: "skipped", copiedCount: 0 };
  }
  try {
    const legacyEntries = await params.readLegacyEntries(plan.legacyUserDataDir);
    const allHarnessEntries = selectLegacyHarnessEntries(legacyEntries, new Set());
    if (allHarnessEntries.length === 0) {
      writeLegacyMigrationMarkerAtomic(plan.completionMarkerPath, false, 0);
      return { status: "no_harness_entries", copiedCount: 0 };
    }
    const existingTargetKeys = params.readExistingTargetKeys
      ? await params.readExistingTargetKeys(plan.targetUserDataDir)
      : new Set<string>();
    const entriesToCopy = selectLegacyHarnessEntries(legacyEntries, existingTargetKeys);
    const copiedCount =
      entriesToCopy.length === 0 ? 0 : await params.writeMissingTargetEntries(plan.targetUserDataDir, entriesToCopy);
    if (!Number.isInteger(copiedCount) || copiedCount < 0) {
      throw new Error("Legacy profile migration reported an invalid copied entry count.");
    }
    writeLegacyMigrationMarkerAtomic(plan.completionMarkerPath, true, copiedCount);
    return { status: "migrated", copiedCount };
  } catch (error) {
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Migration failed.";
    return { status: "failed", copiedCount: 0, detail };
  }
}

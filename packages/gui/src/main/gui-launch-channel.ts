import { guiInteractionPolicy } from "@harness-anything/kernel/internal/domain/gui-interaction-policy.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";

export const GUI_APP_NAME = "Harness Anything";
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

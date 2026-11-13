import {
  cliContractPolicy,
  cliOperationalPolicy,
} from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import type { DaemonAutostartResult } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { daemonBuildStamp, readDistBuildId } from "@harness-anything/daemon/internal/build-identity";
import { daemonIdFromEnv, daemonUserRoot } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { guiStdioLogPath } from "@harness-anything/daemon/internal/lifecycle-log";
import { startDetachedProcess } from "@harness-anything/daemon/internal/process-port";
import { cliErrorMessage } from "../cli-error.ts";
import { cliFailure } from "../cli-meta.ts";
import { consumeKnownError } from "../daemon/client.ts";
import { ensureCliDaemonRunning } from "../daemon/autostart.ts";
import { isBrowserGuiParentOrigin, startBrowserGuiBroker, type BrowserGuiBroker } from "./gui-browser-broker.ts";

type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
type LockfileEntry = { readonly optional?: boolean; readonly resolved?: string; readonly version?: string };
const DESKTOP_GUI_RELEASES_URL = cliContractPolicy.defaultValue.desktopReleasesUrl;
const GUI_LAUNCH_TIMEOUT_MS = cliOperationalPolicy.defaultValue.waitMaximumMs;
const LOOPBACK_HOST = "127.0.0.1";
export interface GuiElectronRuntime {
  readonly binary?: string;
  readonly installScript?: string;
  readonly remedy: string;
}
export interface GuiLaunchReadinessSignal {
  readonly ok: boolean;
  readonly mode?: string;
  readonly pid?: number;
  readonly reason?: string;
  readonly detail?: string;
}
export interface GuiLaunchDependencies {
  readonly resolveElectronRuntime?: (guiPackageRoot: string) => GuiElectronRuntime;
  readonly startDetached?: typeof startDetachedProcess;
  readonly ensureDaemon?: (invokingRoot: string) => Promise<DaemonAutostartResult>;
  readonly guiPackageRoot?: string;
  readonly resolveGuiPackageRoot?: () => string | undefined;
  readonly sourceBuildId?: () => string | null;
  readonly rebuildGuiBundle?: (guiPackageRoot: string) => void;
  readonly startBrowserBroker?: typeof startBrowserGuiBroker;
  readonly waitForBrowserClose?: (broker: BrowserGuiBroker) => Promise<void>;
  readonly waitForReady?: (context: {
    readonly child: ReturnType<typeof startDetachedProcess>;
    readonly logPath: string;
    readonly addr: string;
    readonly token: string;
  }) => Promise<GuiLaunchReadinessSignal>;
}

export async function runGuiLaunch(
  argv: readonly string[],
  dependencies: GuiLaunchDependencies,
  renderReceipt: ReceiptEmitter,
): Promise<number> {
  const json = argv.includes("--json"),
    finish = (receipt: Record<string, unknown>, exitCode: number) => {
      renderReceipt(
        {
          schema: "command-receipt/v2",
          command: "gui",
          outcome: receipt.ok === true ? "applied" : "rejected",
          ...receipt,
        },
        json,
      );
      return exitCode;
    },
    reject = (errorCode: string, hint: string, exitCode = 1) => finish(cliFailure("gui", errorCode, hint), exitCode),
    launch = parseGuiLaunch(argv);
  if (!launch.ok) return reject(launch.code, launch.hint, 2);
  const guiPackageRoot = dependencies.guiPackageRoot ?? (dependencies.resolveGuiPackageRoot ?? resolveGuiPackageRoot)();
  if (!guiPackageRoot)
    return reject(
      "gui_unavailable",
      "The desktop GUI is not part of the npm CLI install. " +
        `Install the desktop App from ${DESKTOP_GUI_RELEASES_URL} (it bundles \`ha\`), ` +
        "or install the optional GUI package beside this CLI with `npm install -g @harness-anything/gui`, " +
        "then retry `ha gui`.",
    );
  const bundle = refreshStaleGuiBundle(guiPackageRoot, dependencies);
  if ("staleDependency" in bundle)
    return reject(
      "gui_dependencies_stale",
      `package-lock.json requires ${bundle.staleDependency} but the installed dependencies do not provide it. ` +
        "Install them with `npm install` in the checkout root, then retry `ha gui`.",
    );
  if ("rebuildFailure" in bundle)
    return reject(
      "gui_build_failed",
      `The GUI bundle rebuild failed: ${bundle.rebuildFailure} Fix the build with ` +
        "`npm run build --workspace @harness-anything/gui`, then retry `ha gui`.",
    );
  const browser = launch.browser,
    rendererBundle = path.join(guiPackageRoot, "dist/index.html"),
    preloadBundle = path.join(guiPackageRoot, "dist-electron/electron-preload.cjs"),
    mainBundle = path.join(guiPackageRoot, "dist-electron/electron-main.js");
  if (!existsSync(rendererBundle)) return reject("gui_build_failed", missingBundleHint(rendererBundle));
  if (!browser) {
    if (!existsSync(preloadBundle)) return reject("gui_build_failed", missingBundleHint(preloadBundle));
    if (!existsSync(mainBundle)) return reject("gui_build_failed", missingBundleHint(mainBundle));
  }
  const electronRuntime = browser
    ? undefined
    : (dependencies.resolveElectronRuntime ?? guiElectronRuntime)(guiPackageRoot);
  if (!browser && !electronRuntime!.binary) return reject("electron_unavailable", electronRuntime!.remedy);
  try {
    const daemon = await (dependencies.ensureDaemon ?? prepareGuiDaemon)(launch.rootDir);
    if (!daemon.ok)
      return reject(
        daemon.code ?? "daemon_start_failed",
        daemon.hint || "The default daemon could not be acquired through the CLI autostart path.",
      );
    if (browser) {
      const broker = await (dependencies.startBrowserBroker ?? startBrowserGuiBroker)(
        guiPackageRoot,
        launch.rootDir,
        launch.parentOrigin,
      );
      finish(
        {
          ok: true,
          command: "gui",
          url: broker.url,
          ...(bundle.rebuilt ? { rebuilt: true } : {}),
          summary: `Harness Anything GUI available at ${broker.url}`,
        },
        0,
      );
      await (dependencies.waitForBrowserClose ?? waitForBrowserClose)(broker);
      return 0;
    }
    const logPath = guiStdioLogPath(daemonUserRoot(), daemonIdFromEnv());
    return await launchDesktopGui({
      launch,
      rebuilt: bundle.rebuilt,
      guiPackageRoot,
      mainBundle,
      electronRuntime: electronRuntime!,
      logPath,
      dependencies,
      finish,
      reject,
    });
  } catch (error) {
    return reject("gui_launch_failed", `Electron could not start the GUI. Cause: ${cliErrorMessage(error)}`);
  }
}

async function launchDesktopGui(context: {
  readonly launch: { readonly rootDir: string; readonly explicitRoot: boolean };
  readonly rebuilt: boolean;
  readonly guiPackageRoot: string;
  readonly mainBundle: string;
  readonly electronRuntime: GuiElectronRuntime;
  readonly logPath: string;
  readonly dependencies: GuiLaunchDependencies;
  readonly finish: (receipt: Record<string, unknown>, exitCode: number) => number;
  readonly reject: (errorCode: string, hint: string, exitCode?: number) => number;
}): Promise<number> {
  const { launch, rebuilt, guiPackageRoot, mainBundle, electronRuntime, logPath, dependencies, finish, reject } =
    context;
  const channel = await startGuiLaunchReadinessServer();
  try {
    const child = (dependencies.startDetached ?? startDetachedProcess)(
      electronRuntime.binary!,
      [mainBundle],
      guiLaunchEnvironment(launch.rootDir, launch.explicitRoot, channel.addr, channel.token),
      logPath,
      guiPackageRoot,
      false, // Electron owns a visible window; background daemon launches keep the hidden default.
    );
    child.on?.("error", consumeKnownError);
    if (child.pid === undefined)
      return reject(
        "gui_launch_failed",
        `Electron at ${electronRuntime.binary} could not be started. Re-run its installer ` +
          `(\`node ${electronRuntime.installScript}\`), then retry \`ha gui\`.`,
      );
    const signal = dependencies.waitForReady
      ? await dependencies.waitForReady({ child, logPath, addr: channel.addr, token: channel.token })
      : await awaitGuiLaunchReadiness({ child, spawnedPid: child.pid, logPath, channel });
    if (!signal.ok) {
      return reject("gui_launch_failed", formatGuiLaunchFailure(signal, logPath));
    }
    const activePid = signal.pid ?? child.pid;
    const summary =
      signal.mode === "second_instance"
        ? `Harness Anything GUI activated existing window (pid ${activePid}) for ${launch.rootDir}; logs: ${logPath}`
        : `Harness Anything GUI launched (pid ${activePid}) for ${launch.rootDir}; logs: ${logPath}`;
    return finish(
      {
        ok: true,
        command: "gui",
        pid: activePid,
        log: logPath,
        ...(rebuilt ? { rebuilt: true } : {}),
        summary,
      },
      0,
    );
  } finally {
    channel.close();
  }
}

async function prepareGuiDaemon(invokingRoot: string): Promise<DaemonAutostartResult> {
  return ensureCliDaemonRunning({
    invokingRoot,
    onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
  });
}
// The daemon's build_superseded drift compares its loaded dist marker against the disk marker; the
// GUI has no resident process, so the same determination compares the bundle's dist marker against
// the checkout's current build id and rebuilds before launch when they disagree. Only a source
// checkout can hold sources the bundle lags behind — the installed package ships no src tree.
function refreshStaleGuiBundle(
  guiPackageRoot: string,
  dependencies: GuiLaunchDependencies,
): { readonly rebuilt: boolean } | { readonly staleDependency: string } | { readonly rebuildFailure: string } {
  if (!existsSync(path.join(guiPackageRoot, "src"))) return { rebuilt: false };
  const commit = (dependencies.sourceBuildId ?? daemonSourceBuildId)();
  if (commit === null || readDistBuildId(guiPackageRoot) === commit) return { rebuilt: false };
  const staleDependency = uninstalledLockfileDependency(guiPackageRoot);
  if (staleDependency) return { staleDependency };
  process.stderr.write(
    `The GUI bundle in ${guiPackageRoot} predates the current source build ${commit.slice(0, 12)}; ` +
      "rebuilding it before launch.\n",
  );
  try {
    (dependencies.rebuildGuiBundle ?? rebuildGuiBundleFromSource)(guiPackageRoot);
  } catch (error) {
    return { rebuildFailure: cliErrorMessage(error) };
  }
  return { rebuilt: true };
}
// npm records the tree it last installed in node_modules/.package-lock.json. A pulled commit that
// adds a dependency leaves that tree behind the root package-lock.json, and the rebuild then dies
// on an unresolvable import instead of the real remedy. Optional entries are the ones npm skips
// per platform, so their absence is expected; any other lockfile entry missing from the installed
// tree — or present at a different identity — makes `npm install` the actual next step. Without
// both lockfiles, or with an unreadable one, the check cannot decide and the rebuild proceeds
// as before.
function uninstalledLockfileDependency(guiPackageRoot: string): string | null {
  const checkoutRoot = path.resolve(guiPackageRoot, "..", ".."),
    lockfilePath = path.join(checkoutRoot, "package-lock.json"),
    installedLockfilePath = path.join(checkoutRoot, "node_modules/.package-lock.json");
  if (!existsSync(lockfilePath) || !existsSync(installedLockfilePath)) return null;
  let lockfile: { readonly packages?: Readonly<Record<string, LockfileEntry>> },
    installedLockfile: { readonly packages?: Readonly<Record<string, LockfileEntry>> };
  try {
    lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    installedLockfile = JSON.parse(readFileSync(installedLockfilePath, "utf8"));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  for (const [entryPath, entry] of Object.entries(lockfile.packages ?? {})) {
    if (entryPath === "" || entry.optional === true) continue;
    const installed = installedLockfile.packages?.[entryPath];
    if (!installed) return entryPath;
    if (
      (installed.version ?? null) !== (entry.version ?? null) ||
      (installed.resolved ?? null) !== (entry.resolved ?? null)
    )
      return entryPath;
  }
  return null;
}
function daemonSourceBuildId(): string | null {
  return daemonBuildStamp().commit;
}
// The build's own output goes to stderr: `ha gui --json` must keep stdout to its receipt line.
function rebuildGuiBundleFromSource(guiPackageRoot: string): void {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: guiPackageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (build.stdout) process.stderr.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.status !== 0)
    throw new Error(
      `npm run build exited with status ${build.status ?? "unknown"}${build.error ? `: ${build.error.message}` : ""}. `,
    );
}
function missingBundleHint(bundle: string): string {
  return (
    `The GUI bundle ${bundle} is missing. In a source checkout build it with ` +
    "`npm run build -w @harness-anything/gui`; in an npm installation reinstall @harness-anything/gui."
  );
}
// The Electron runtime is downloaded by electron's postinstall, which package managers
// increasingly block by default (dec_A36285F75C28B6BBA041F281CA CH5): diagnose the missing
// runtime with its one-line remedy instead of assuming postinstall ran or downloading it here.
function guiElectronRuntime(guiPackageRoot: string): GuiElectronRuntime {
  let electronRoot: string;
  try {
    electronRoot = path.dirname(
      createRequire(path.join(guiPackageRoot, "package.json")).resolve("electron/package.json"),
    );
  } catch (error) {
    consumeKnownError(error);
    return {
      remedy:
        "The Electron runtime package is not installed beside the GUI. " +
        "Reinstall @harness-anything/gui, then retry `ha gui`.",
    };
  }
  const installScript = path.join(electronRoot, "install.js"),
    remedy =
      `The Electron runtime was not downloaded (its install script did not run). ` +
      `Run \`node ${installScript}\`, then retry \`ha gui\`.`;
  try {
    const relativeBinary = readFileSync(path.join(electronRoot, "path.txt"), "utf8").trim();
    if (!relativeBinary) return { installScript, remedy };
    const candidate = path.resolve(electronRoot, "dist", relativeBinary);
    accessSync(candidate, constants.F_OK | constants.X_OK);
    return { binary: candidate, installScript, remedy };
  } catch (error) {
    consumeKnownError(error);
    return { installScript, remedy };
  }
}
function resolveGuiPackageRoot(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve("@harness-anything/gui/package.json");
    return path.dirname(manifest);
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
}
function parseGuiLaunch(argv: readonly string[]):
  | {
      readonly ok: true;
      readonly rootDir: string;
      readonly explicitRoot: boolean;
      readonly browser: boolean;
      readonly parentOrigin?: string;
    }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  let root: string | undefined,
    parentOrigin: string | undefined,
    browser = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "gui" || value === "--json") continue;
    if (value === "--browser") {
      browser = true;
      continue;
    }
    if (value === "--parent-origin") {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("-"))
        return { ok: false, code: "missing_field", hint: "Add one exact origin after --parent-origin." };
      if (parentOrigin !== undefined || !isBrowserGuiParentOrigin(supplied))
        return {
          ok: false,
          code: "invalid_field",
          hint: "Pass --parent-origin once with one serialized HTTP(S) origin or dsh-app://app, without a path or wildcard.",
        };
      parentOrigin = supplied;
      index += 1;
      continue;
    }
    if (value === "--root") {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("-"))
        return { ok: false, code: "missing_field", hint: "Add a workspace path after --root." };
      if (root !== undefined) return { ok: false, code: "invalid_field", hint: "Pass --root at most once to ha gui." };
      root = supplied;
      index += 1;
      continue;
    }
    return {
      ok: false,
      code: "unsupported_command",
      hint: "Use `ha gui [--browser [--parent-origin <origin>]] [--root <path>]`.",
    };
  }
  if (parentOrigin !== undefined && !browser)
    return { ok: false, code: "invalid_field", hint: "--parent-origin requires --browser." };
  return {
    ok: true,
    rootDir: path.resolve(root ?? process.cwd()),
    explicitRoot: root !== undefined,
    browser,
    parentOrigin,
  };
}

function waitForBrowserClose(broker: BrowserGuiBroker): Promise<void> {
  return new Promise((resolve) => {
    const close = () => void broker.close().finally(resolve);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
function guiLaunchEnvironment(
  rootDir: string,
  explicitRoot: boolean,
  launchAddr: string,
  launchToken: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_GUI_ROOT: rootDir,
    HARNESS_GUI_ROOT_EXPLICIT: explicitRoot ? "1" : "0",
    HARNESS_GUI_LAUNCH_ADDR: launchAddr,
    HARNESS_GUI_LAUNCH_TOKEN: launchToken,
  };
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

interface GuiLaunchReadinessChannel {
  readonly addr: string;
  readonly token: string;
  readonly signalPromise: Promise<GuiLaunchReadinessSignal>;
  whenIdle(): Promise<void>;
  close(): void;
}

function tryParseJsonLine(line: string): { readonly valid: true; readonly value: unknown } | { readonly valid: false } {
  try {
    return { valid: true, value: JSON.parse(line) };
  } catch {
    return { valid: false };
  }
}

function parseReadinessPayload(line: string, expectedToken: string): GuiLaunchReadinessSignal | null {
  const parsed = tryParseJsonLine(line);
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

async function startGuiLaunchReadinessServer(): Promise<GuiLaunchReadinessChannel> {
  const token = randomBytes(16).toString("hex");
  const sockets: net.Socket[] = [];
  const idleResolvers: Array<() => void> = [];
  let resolveSignal: ((signal: GuiLaunchReadinessSignal) => void) | null = null;
  const signalPromise = new Promise<GuiLaunchReadinessSignal>((resolve) => {
    resolveSignal = resolve;
  });
  let settled = false;
  const flushIdle = () => {
    if (sockets.length > 0) return;
    while (idleResolvers.length > 0) idleResolvers.shift()?.();
  };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("close", () => {
      const index = sockets.indexOf(socket);
      if (index !== -1) sockets.splice(index, 1);
      flushIdle();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const payload = parseReadinessPayload(buffer.slice(0, newline), token);
      if (payload === null) {
        socket.destroy();
        return;
      }
      socket.end("ack\n");
      if (!settled) {
        settled = true;
        resolveSignal?.(payload);
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
    throw new Error("Could not bind GUI launch readiness socket.");
  }
  return {
    addr: `${LOOPBACK_HOST}:${address.port}`,
    token,
    signalPromise,
    whenIdle: () => (sockets.length === 0 ? Promise.resolve() : new Promise((resolve) => idleResolvers.push(resolve))),
    close: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
      flushIdle();
      server.close();
    },
  };
}

async function awaitGuiLaunchReadiness(options: {
  readonly child: ReturnType<typeof startDetachedProcess>;
  readonly spawnedPid: number;
  readonly logPath: string;
  readonly channel: GuiLaunchReadinessChannel;
}): Promise<GuiLaunchReadinessSignal> {
  const { child, spawnedPid, channel } = options;
  return new Promise<GuiLaunchReadinessSignal>((resolve) => {
    let done = false;
    const finish = (signal: GuiLaunchReadinessSignal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
      resolve(signal);
    };
    const onError = (error: Error) => {
      finish({ ok: false, reason: "gui_launch_failed", detail: `Electron process failed to start: ${error.message}` });
    };
    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      const exitDetail =
        sig !== null
          ? `Electron exited via signal ${sig} before opening a visible GUI window.`
          : `Electron exited with code ${code ?? "unknown"} before opening a visible GUI window.`;
      // Let any already-connected readiness socket finish delivering its frame before
      // concluding the process died without opening a window.
      void channel.whenIdle().then(() => {
        setImmediate(() => finish({ ok: false, reason: "gui_process_exited", detail: exitDetail }));
      });
    };
    const timer = setTimeout(() => {
      void terminateLaunchedPid(spawnedPid);
      finish({
        ok: false,
        reason: "gui_launch_timeout",
        detail: `Timed out after ${GUI_LAUNCH_TIMEOUT_MS / 1000}s waiting for the Harness Anything GUI window to become visible.`,
      });
    }, GUI_LAUNCH_TIMEOUT_MS);
    timer.unref?.();
    child.once?.("error", onError);
    child.once?.("exit", onExit);
    void channel.signalPromise.then(finish);
  });
}

function terminateLaunchedPid(pid: number): { readonly terminated: boolean } {
  try {
    process.kill(pid);
    return { terminated: true };
  } catch {
    return { terminated: false };
  }
}

function readLogFileResult(logPath: string): { readonly ok: true; readonly content: string } | { readonly ok: false } {
  try {
    return { ok: true, content: readFileSync(logPath, "utf8") };
  } catch {
    return { ok: false };
  }
}

function readGuiLogTail(logPath: string): string {
  if (!existsSync(logPath)) return "";
  const read = readLogFileResult(logPath);
  if (!read.ok) return "";
  const lines = read.content
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-12).join(" | ").slice(0, 800);
}

function formatGuiLaunchFailure(signal: GuiLaunchReadinessSignal, logPath: string): string {
  const headline = signal.detail ?? signal.reason ?? "The GUI failed to open a visible desktop window.";
  const tail = readGuiLogTail(logPath);
  return tail ? `${headline} Recent log: ${tail} (logs: ${logPath})` : `${headline} Logs: ${logPath}`;
}

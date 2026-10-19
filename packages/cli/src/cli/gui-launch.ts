import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
import { startBrowserGuiBroker, type BrowserGuiBroker } from "./gui-browser-broker.ts";

type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
type LockfileEntry = { readonly optional?: boolean; readonly resolved?: string; readonly version?: string };
export interface GuiElectronRuntime {
  readonly binary?: string;
  readonly installScript?: string;
  readonly remedy: string;
}
export interface GuiLaunchDependencies {
  readonly resolveElectronRuntime?: (guiPackageRoot: string) => GuiElectronRuntime;
  readonly startDetached?: typeof startDetachedProcess;
  readonly ensureDaemon?: (invokingRoot: string) => Promise<DaemonAutostartResult>;
  readonly guiPackageRoot?: string;
  readonly sourceBuildId?: () => string | null;
  readonly rebuildGuiBundle?: (guiPackageRoot: string) => void;
  readonly startBrowserBroker?: (guiPackageRoot: string, rootDir: string) => Promise<BrowserGuiBroker>;
  readonly waitForBrowserClose?: (broker: BrowserGuiBroker) => Promise<void>;
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
  const guiPackageRoot = dependencies.guiPackageRoot ?? resolveGuiPackageRoot();
  if (!guiPackageRoot)
    return reject(
      "gui_unavailable",
      "The desktop GUI is an optional shell and is not installed beside this CLI. " +
        "Install it with `npm install -g @harness-anything/gui`, then retry `ha gui`.",
    );
  const bundle = refreshStaleGuiBundle(guiPackageRoot, dependencies);
  if ("failure" in bundle) return reject(bundle.code, bundle.failure);
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
      const broker = await (dependencies.startBrowserBroker ?? startBrowserGuiBroker)(guiPackageRoot, launch.rootDir);
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
    const child = (dependencies.startDetached ?? startDetachedProcess)(
      electronRuntime!.binary!,
      [mainBundle],
      guiLaunchEnvironment(launch.rootDir),
      logPath,
      guiPackageRoot,
      false, // Electron owns a visible window; background daemon launches keep the hidden default.
    );
    child.on?.("error", consumeKnownError);
    if (child.pid === undefined)
      return reject(
        "gui_launch_failed",
        `Electron at ${electronRuntime!.binary} could not be started. Re-run its installer ` +
          `(\`node ${electronRuntime!.installScript}\`), then retry \`ha gui\`.`,
      );
    return finish(
      {
        ok: true,
        command: "gui",
        pid: child.pid,
        log: logPath,
        ...(bundle.rebuilt ? { rebuilt: true } : {}),
        summary: `Harness Anything GUI launched (pid ${child.pid}) for ${launch.rootDir}; logs: ${logPath}`,
      },
      0,
    );
  } catch (error) {
    return reject("gui_launch_failed", `Electron could not start the GUI. Cause: ${cliErrorMessage(error)}`);
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
): { readonly rebuilt: boolean } | { readonly code: string; readonly failure: string } {
  if (!existsSync(path.join(guiPackageRoot, "src"))) return { rebuilt: false };
  const commit = (dependencies.sourceBuildId ?? daemonSourceBuildId)();
  if (commit === null || readDistBuildId(guiPackageRoot) === commit) return { rebuilt: false };
  const staleDependency = uninstalledLockfileDependency(guiPackageRoot);
  if (staleDependency)
    return {
      code: "gui_dependencies_stale",
      failure:
        `package-lock.json requires ${staleDependency} but the installed dependencies do not provide it. ` +
        "Install them with `npm install` in the checkout root, then retry `ha gui`.",
    };
  process.stderr.write(
    `The GUI bundle in ${guiPackageRoot} predates the current source build ${commit.slice(0, 12)}; ` +
      "rebuilding it before launch.\n",
  );
  try {
    (dependencies.rebuildGuiBundle ?? rebuildGuiBundleFromSource)(guiPackageRoot);
  } catch (error) {
    return {
      code: "gui_build_failed",
      failure:
        `The GUI bundle rebuild failed: ${cliErrorMessage(error)} Fix the build with ` +
        "`npm run build --workspace @harness-anything/gui`, then retry `ha gui`.",
    };
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
function parseGuiLaunch(
  argv: readonly string[],
):
  | { readonly ok: true; readonly rootDir: string; readonly browser: boolean }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  let root: string | undefined,
    browser = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "gui" || value === "--json") continue;
    if (value === "--browser") {
      browser = true;
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
      hint: "Use `ha gui [--browser] [--root <path>]`.",
    };
  }
  return { ok: true, rootDir: path.resolve(root ?? process.cwd()), browser };
}

function waitForBrowserClose(broker: BrowserGuiBroker): Promise<void> {
  return new Promise((resolve) => {
    const close = () => void broker.close().finally(resolve);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
function guiLaunchEnvironment(rootDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HARNESS_GUI_ROOT: rootDir };
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

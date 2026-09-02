import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonAutostartResult } from "../../../daemon/src/client/daemon-autostart.ts";
import { detachedProcessOptions } from "../../../daemon/src/process-port.ts";
import { cliErrorMessage } from "../cli-error.ts";
import { cliFailure } from "../cli-meta.ts";
import { consumeKnownError } from "../daemon/client.ts";
import { ensureCliDaemonRunning } from "../daemon/autostart.ts";

type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
interface GuiBundlePreparation {
  readonly ok: boolean;
  readonly hint?: string;
}
export interface GuiLaunchDependencies {
  readonly resolveElectronBinary?: (workspaceRoot: string) => string | undefined;
  readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly prepareBundles?: (workspaceRoot: string) => Promise<GuiBundlePreparation>;
  readonly ensureDaemon?: (invokingRoot: string) => Promise<DaemonAutostartResult>;
  readonly workspaceRoot?: string;
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
  const workspaceRoot = dependencies.workspaceRoot ?? guiWorkspaceRoot();
  if (!workspaceRoot)
    return reject(
      "gui_unavailable",
      "Run `ha gui` from a harness-anything source workspace that contains the GUI package.",
    );
  const electronBinary = (dependencies.resolveElectronBinary ?? guiElectronBinary)(workspaceRoot);
  if (!electronBinary)
    return reject(
      "electron_unavailable",
      "Run `node node_modules/electron/install.js` in the harness-anything workspace, then retry `ha gui`.",
    );
  try {
    const prepared = await (dependencies.prepareBundles ?? prepareGuiBundles)(workspaceRoot);
    if (!prepared.ok)
      return reject(
        "gui_build_failed",
        prepared.hint ?? "The GUI renderer or preload bundle could not be built. Inspect the build output and retry.",
      );
    if (!existsSync(path.join(workspaceRoot, "packages/gui/dist/index.html")))
      return reject("gui_build_failed", "The GUI renderer build completed without producing dist/index.html.");
    if (!existsSync(path.join(workspaceRoot, "packages/gui/dist-electron/electron-preload.cjs")))
      return reject(
        "gui_build_failed",
        "The GUI preload build completed without producing dist-electron/electron-preload.cjs.",
      );
    if (!launch.remote) {
      const daemon = await (dependencies.ensureDaemon ?? prepareGuiDaemon)(workspaceRoot);
      if (!daemon.ok)
        return reject(
          daemon.code ?? "daemon_start_failed",
          daemon.hint || "The default daemon could not be acquired through the CLI autostart path.",
        );
    }
    const child = (dependencies.spawnProcess ?? spawn)(
      electronBinary,
      [path.join(workspaceRoot, "packages/gui/src/main/electron-main.ts")],
      { cwd: workspaceRoot, ...detachedProcessOptions, env: guiLaunchEnvironment(launch) },
    );
    child.on?.("error", consumeKnownError);
    if (child.pid === undefined)
      return reject(
        "gui_launch_failed",
        `Electron at ${electronBinary} could not be started. ` +
          "Reinstall it with `node node_modules/electron/install.js`, then retry `ha gui`.",
      );
    child.unref();
    return finish(
      {
        ok: true,
        command: "gui",
        pid: child.pid,
        summary: `Harness Anything GUI launched (pid ${child.pid}) for ${launch.rootDir}.`,
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
    launchEntry: guiCliEntry(invokingRoot),
    onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
  });
}
async function prepareGuiBundles(workspaceRoot: string): Promise<GuiBundlePreparation> {
  let viteBin: string;
  try {
    const guiRequire = createRequire(path.join(workspaceRoot, "packages/gui/package.json")),
      vitePackage = guiRequire("vite/package.json") as { readonly bin?: { readonly vite?: string } | string },
      relativeBin = typeof vitePackage.bin === "string" ? vitePackage.bin : vitePackage.bin?.vite;
    if (!relativeBin) return { ok: false, hint: "The installed Vite package does not declare its CLI entry." };
    viteBin = path.join(path.dirname(guiRequire.resolve("vite/package.json")), relativeBin);
  } catch (error) {
    return { ok: false, hint: `The GUI build tool is unavailable. Cause: ${cliErrorMessage(error)}` };
  }
  const guiRoot = path.join(workspaceRoot, "packages/gui");
  for (const args of [
    [viteBin, "build"],
    [viteBin, "build", "--config", "vite.preload.config.ts"],
  ]) {
    const result = await runGuiBuild(process.execPath, args, guiRoot);
    if (!result.ok) return result;
  }
  return { ok: true };
}
function runGuiBuild(command: string, args: string[], cwd: string): Promise<GuiBundlePreparation> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GuiBundlePreparation) => {
        if (settled) return;
        settled = true;
        resolve(result);
      },
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", process.stderr, process.stderr],
        windowsHide: true,
      });
    child.once("error", (error) =>
      finish({ ok: false, hint: `The GUI build could not start. Cause: ${cliErrorMessage(error)}` }),
    );
    child.once("close", (code) =>
      finish(
        code === 0 ? { ok: true } : { ok: false, hint: `The GUI build exited with code ${String(code ?? "unknown")}.` },
      ),
    );
  });
}
function guiElectronBinary(workspaceRoot: string): string | undefined {
  try {
    const guiRequire = createRequire(path.join(workspaceRoot, "packages/gui/package.json")),
      packageRoot = path.dirname(guiRequire.resolve("electron/package.json")),
      relativeBinary = readFileSync(path.join(packageRoot, "path.txt"), "utf8").trim();
    if (!relativeBinary) return undefined;
    const candidate = path.resolve(packageRoot, "dist", relativeBinary);
    accessSync(candidate, constants.F_OK | constants.X_OK);
    return candidate;
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
}
function guiWorkspaceRoot(): string | undefined {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "packages/gui/src/main/electron-main.ts"))
    )
      return canonicalGuiInstallation(current);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
function canonicalGuiInstallation(workspaceRoot: string): string {
  const marker = path.join(workspaceRoot, ".git");
  try {
    const gitdir = /^gitdir:\s*(.+)$/u.exec(readFileSync(marker, "utf8").trim())?.[1];
    if (!gitdir) return workspaceRoot;
    const administrativeRoot = path.resolve(workspaceRoot, gitdir),
      commonPath = path.join(administrativeRoot, "commondir"),
      commonRoot = existsSync(commonPath)
        ? path.resolve(administrativeRoot, readFileSync(commonPath, "utf8").trim())
        : administrativeRoot,
      canonicalRoot = path.basename(commonRoot) === ".git" ? path.dirname(commonRoot) : workspaceRoot;
    return existsSync(path.join(canonicalRoot, "packages/gui/src/main/electron-main.ts"))
      ? canonicalRoot
      : workspaceRoot;
  } catch (error) {
    consumeKnownError(error);
    return workspaceRoot;
  }
}
function guiCliEntry(workspaceRoot: string): string {
  const dist = path.join(workspaceRoot, "packages/cli/dist/cli/src/index.js");
  return existsSync(dist) ? dist : path.join(workspaceRoot, "packages/cli/src/index.ts");
}
function parseGuiLaunch(
  argv: readonly string[],
):
  | { readonly ok: true; readonly rootDir: string; readonly remote: boolean; readonly options: Record<string, string> }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  let root: string | undefined;
  let remote = false;
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "gui" || value === "--json") continue;
    if (value === "--remote") {
      remote = true;
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
    if (isGuiRemoteOption(value)) {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("-"))
        return { ok: false, code: "missing_field", hint: `Add a value after ${value}.` };
      options[value] = supplied;
      index += 1;
      continue;
    }
    return {
      ok: false,
      code: "unsupported_command",
      hint: "Use `ha gui [--root <path>]`; the production launcher has no additional modes.",
    };
  }
  if (remote) {
    const hasAlias = Boolean(options["--ssh-config-host"]?.trim());
    const host = options["--remote-host"]?.trim();
    const portText = options["--remote-port"]?.trim();
    const hasEndpoint = Boolean(host) && Boolean(portText);
    if (!hasAlias && !hasEndpoint)
      return {
        ok: false,
        code: "gui_remote_config_missing",
        hint: "`ha gui --remote` needs an OpenSSH config alias (`--ssh-config-host`) or both `--remote-host` and `--remote-port`.",
      };
    if (hasEndpoint) {
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        return { ok: false, code: "gui_remote_port_invalid", hint: "`--remote-port` must be an integer between 1 and 65535." };
    }
  }
  return { ok: true, rootDir: path.resolve(root ?? process.cwd()), remote, options };
}
function isGuiRemoteOption(value: string): boolean {
  switch (value) {
    case "--remote-host":
    case "--remote-port":
    case "--remote-user":
    case "--identity-file":
    case "--host-key-alias":
    case "--ssh-config-host":
    case "--ssh-command":
    case "--remote-daemon-id":
    case "--remote-command-json":
      return true;
    default:
      return false;
  }
}
function guiLaunchEnvironment(launch: { readonly rootDir: string; readonly remote: boolean; readonly options: Record<string, string> }): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HARNESS_GUI_ROOT: launch.rootDir };
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  if (launch.remote) {
    environment.HARNESS_GUI_TRANSPORT = "ssh";
    const mappings: Record<string, string> = {
      "--remote-host": "HARNESS_GUI_REMOTE_HOST",
      "--remote-port": "HARNESS_GUI_REMOTE_PORT",
      "--remote-user": "HARNESS_GUI_REMOTE_USER",
      "--identity-file": "HARNESS_GUI_REMOTE_IDENTITY_FILE",
      "--host-key-alias": "HARNESS_GUI_REMOTE_HOST_KEY_ALIAS",
      "--ssh-config-host": "HARNESS_GUI_REMOTE_SSH_CONFIG_HOST",
      "--ssh-command": "HARNESS_GUI_SSH_COMMAND",
      "--remote-daemon-id": "HARNESS_GUI_REMOTE_DAEMON_ID",
      "--remote-command-json": "HARNESS_GUI_REMOTE_COMMAND_JSON",
    };
    for (const [option, variable] of Object.entries(mappings)) {
      const value = launch.options[option];
      if (value !== undefined) environment[variable] = value;
    }
  }
  return environment;
}

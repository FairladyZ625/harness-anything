import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { isPathInside } from "../../cli/path.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { resolveGuiLaunchTarget, type GuiLaunchTarget } from "./gui-launch-target.ts";

export { isTrustedGuiWorkspaceRoot, resolveGuiLaunchTarget } from "./gui-launch-target.ts";

export const runGuiCommand: CommandRunner = (_context, command) =>
  Effect.sync(() => launchGui(command.rootDir, command.layoutOverrides?.authoredRoot));

function launchGui(rootDir: string, authoredRoot?: string): CliResult {
  const dryRun = process.env.HARNESS_GUI_DRY_RUN === "1";
  const target = resolveGuiLaunchTarget();
  if (!target) {
    const configuredExecutable = process.env.HARNESS_GUI_EXECUTABLE?.trim();
    return {
      ok: false,
      command: "gui",
      error: cliError(
        CliErrorCode.GuiLauncherUnavailable,
        configuredExecutable
          ? `Configured Harness Anything GUI executable does not exist: ${path.resolve(configuredExecutable)}. Install the complete Harness Anything desktop product or correct HARNESS_GUI_EXECUTABLE.`
          : "Harness Anything GUI is not installed. Install the complete desktop product from GitHub Releases, or run the workspace-local CLI from a trusted harness-anything source checkout. The target Harness project is never used as an npm script source."
      )
    };
  }

  if (!dryRun && target.source === "source-checkout" && !hasElectronRuntime(target.cwd)) {
    return {
      ok: false,
      command: "gui",
      error: cliError(
        CliErrorCode.GuiLauncherUnavailable,
        `Electron runtime is missing from the trusted harness-anything workspace at ${target.cwd}. Run \`node node_modules/electron/install.js\` from that workspace, then retry \`ha gui\`.`
      )
    };
  }

  const child = dryRun ? undefined : spawnGuiTarget(target, rootDir, authoredRoot);

  return {
    ok: true,
    command: "gui",
    launchPlan: {
      packageName: "@harness-anything/gui",
      mode: "local-desktop-controller",
      source: target.source,
      apiHost: "127.0.0.1",
      delegated: true,
      dryRun,
      command: target.command,
      ...(child?.pid !== undefined ? { pid: child.pid } : {})
    }
  };
}

function spawnGuiTarget(target: GuiLaunchTarget, rootDir: string, authoredRoot?: string) {
  const detached = process.env.HARNESS_GUI_NPM_MARKER === undefined;
  const environment = guiLaunchEnvironment(rootDir, authoredRoot);
  const cwd = target.source === "installed-product" ? path.resolve(rootDir) : target.cwd;
  const command = target.command;
  const useWindowsShell = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command[0] ?? "");
  const child = useWindowsShell ? spawn(windowsShellCommand(command), {
    cwd,
    detached,
    stdio: "ignore",
    shell: true,
    env: environment
  }) : spawn(command[0] ?? "", command.slice(1), {
    cwd,
    detached,
    stdio: "ignore",
    env: environment
  });
  if (detached) child.unref();
  return child;
}

function hasElectronRuntime(workspaceRoot: string): boolean {
  const electronDistRoot = path.join(workspaceRoot, "node_modules/electron/dist");
  const electronPathFile = path.join(workspaceRoot, "node_modules/electron/path.txt");
  if (!existsSync(electronPathFile)) return false;
  try {
    const relativeRuntimePath = readFileSync(electronPathFile, "utf8").trim();
    if (!relativeRuntimePath) return false;
    const runtimePath = path.resolve(electronDistRoot, relativeRuntimePath);
    return isPathInside(electronDistRoot, runtimePath) && existsSync(runtimePath);
  } catch {
    return false;
  }
}

function guiLaunchEnvironment(rootDir: string, authoredRoot?: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return {
    ...environment,
    HARNESS_GUI_ROOT: path.resolve(rootDir),
    ...(authoredRoot ? { HARNESS_AUTHORED_ROOT: authoredRoot } : {})
  };
}

function windowsShellCommand(command: ReadonlyArray<string>): string {
  const [program = "", ...args] = command;
  return [quoteWindowsShell(resolveWindowsCommand(program)), ...args.map(quoteWindowsShell)].join(" ");
}

function resolveWindowsCommand(command: string): string {
  if (path.isAbsolute(command)) return command;
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return command;
}

function quoteWindowsShell(value: string): string {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

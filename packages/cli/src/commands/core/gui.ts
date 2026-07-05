import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { isPathInside, normalizeSlashes } from "../../cli/path.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runGuiCommand: CommandRunner = (_context, command) =>
  Effect.sync(() => launchGui(command.rootDir, command.layoutOverrides?.authoredRoot));

function launchGui(rootDir: string, authoredRoot?: string): CliResult {
  const command = ["npm", "--workspace", "@harness-anything/gui", "run", "dev"] as const;
  const dryRun = process.env.HARNESS_GUI_DRY_RUN === "1";
  if (dryRun) {
    return {
      ok: true,
      command: "gui",
      launchPlan: {
        packageName: "@harness-anything/gui",
        mode: "local-desktop-controller",
        apiHost: "127.0.0.1",
        delegated: true,
        dryRun,
        command
      }
    };
  }

  const workspaceRoot = findTrustedGuiWorkspaceRoot();
  if (!workspaceRoot) {
    return {
      ok: false,
      command: "gui",
      error: cliError(
        CliErrorCode.GuiLauncherUnavailable,
        "GUI launcher could not find a trusted harness-anything source workspace containing @harness-anything/gui; refusing to run npm scripts from the caller's current directory."
      )
    };
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: workspaceRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: path.resolve(rootDir),
      ...(authoredRoot ? { HARNESS_AUTHORED_ROOT: authoredRoot } : {})
    }
  });
  child.unref();

  return {
    ok: true,
    command: "gui",
    launchPlan: {
      packageName: "@harness-anything/gui",
      mode: "local-desktop-controller",
      apiHost: "127.0.0.1",
      delegated: true,
      dryRun,
      command,
      pid: child.pid
    }
  };
}

interface PackageJsonSummary {
  readonly name?: unknown;
  readonly workspaces?: unknown;
}

function findTrustedGuiWorkspaceRoot(): string | undefined {
  const cliEntrypointPath = realpathSync(fileURLToPath(import.meta.url));
  let current = path.dirname(cliEntrypointPath);
  while (true) {
    if (isTrustedGuiWorkspaceRoot(current, cliEntrypointPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function isTrustedGuiWorkspaceRoot(candidate: string, cliEntrypointPath: string): boolean {
  const rootPackageJsonPath = path.join(candidate, "package.json");
  const cliPackageJsonPath = path.join(candidate, "packages/cli/package.json");
  const guiPackageJsonPath = path.join(candidate, "packages/gui/package.json");
  if (!existsSync(rootPackageJsonPath) || !existsSync(cliPackageJsonPath) || !existsSync(guiPackageJsonPath)) return false;

  try {
    const cliPackageRoot = realpathSync(path.join(candidate, "packages/cli"));
    const realCliEntrypointPath = realpathSync(cliEntrypointPath);
    if (!isPathInside(cliPackageRoot, realCliEntrypointPath)) return false;
    if (!isSourceCheckoutCliEntrypoint(cliPackageRoot, realCliEntrypointPath)) return false;

    const rootPackageJson = readPackageJson(rootPackageJsonPath);
    const cliPackageJson = readPackageJson(cliPackageJsonPath);
    const guiPackageJson = readPackageJson(guiPackageJsonPath);
    return rootPackageJson.name === "harness-anything" &&
      Array.isArray(rootPackageJson.workspaces) &&
      rootPackageJson.workspaces.includes("packages/*") &&
      rootPackageJson.workspaces.includes("packages/adapters/*") &&
      cliPackageJson.name === "@harness-anything/cli" &&
      guiPackageJson.name === "@harness-anything/gui";
  } catch {
    return false;
  }
}

function readPackageJson(packageJsonPath: string): PackageJsonSummary {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonSummary;
}

function isSourceCheckoutCliEntrypoint(cliPackageRoot: string, cliEntrypointPath: string): boolean {
  const relativeEntrypoint = normalizeSlashes(path.relative(cliPackageRoot, cliEntrypointPath));
  const segments = relativeEntrypoint.split("/");
  return (segments[0] === "src" || segments[0] === "dist") && !segments.includes("node_modules");
}

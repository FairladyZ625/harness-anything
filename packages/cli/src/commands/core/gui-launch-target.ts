import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside, normalizeSlashes } from "../../cli/path.ts";

export interface GuiLaunchTarget {
  readonly source: "installed-product" | "source-checkout";
  readonly command: readonly string[];
  readonly cwd: string;
}

interface GuiLaunchResolutionOptions {
  readonly cliEntrypointPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

export function resolveGuiLaunchTarget(options: GuiLaunchResolutionOptions = {}): GuiLaunchTarget | undefined {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicitExecutable = environment.HARNESS_GUI_EXECUTABLE?.trim();
  if (explicitExecutable) {
    const executable = path.resolve(explicitExecutable);
    return isLaunchableFile(executable, platform)
      ? { source: "installed-product", command: [executable], cwd: path.dirname(executable) }
      : undefined;
  }

  const cliEntrypointPath = realpathSync(options.cliEntrypointPath ?? fileURLToPath(import.meta.url));
  const workspaceRoot = findTrustedGuiWorkspaceRoot(cliEntrypointPath);
  if (workspaceRoot) {
    const npmBin = platform === "win32" ? "npm.cmd" : "npm";
    return {
      source: "source-checkout",
      command: [npmBin, "--workspace", "@harness-anything/gui", "run", "dev:electron"],
      cwd: workspaceRoot
    };
  }

  const bundledExecutable = packagedGuiExecutable(cliEntrypointPath, platform);
  if (bundledExecutable) {
    return { source: "installed-product", command: [bundledExecutable], cwd: path.dirname(bundledExecutable) };
  }

  const executable = installedGuiExecutable(platform, environment, options.homeDir ?? os.homedir());
  return executable
    ? { source: "installed-product", command: [executable], cwd: path.dirname(executable) }
    : undefined;
}

function packagedGuiExecutable(cliEntrypointPath: string, platform: NodeJS.Platform): string | undefined {
  let current = path.dirname(cliEntrypointPath);
  while (true) {
    if (path.basename(current).toLowerCase() === "resources") {
      const installRoot = path.dirname(current);
      const candidates = platform === "darwin"
        ? [
            path.join(installRoot, "MacOS/Harness Anything"),
            path.join(installRoot, "MacOS/harness-anything-gui")
          ]
        : platform === "win32"
          ? [
              path.join(installRoot, "Harness Anything.exe"),
              path.join(installRoot, "harness-anything-gui.exe")
            ]
          : [
              path.join(installRoot, "harness-anything-gui"),
              path.join(installRoot, "harness-anything")
            ];
      return candidates.find((candidate) => isLaunchableFile(candidate, platform));
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function installedGuiExecutable(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDir: string): string | undefined {
  const pathCandidates = ["harness-anything-gui", ...(platform === "win32" ? ["Harness Anything.exe"] : [])]
    .flatMap((name) => executableCandidatesOnPath(name, environment.PATH, platform));
  const platformCandidates = platform === "darwin"
    ? [
        "/Applications/Harness Anything.app/Contents/MacOS/Harness Anything",
        "/Applications/Harness Anything.app/Contents/MacOS/harness-anything-gui",
        path.join(homeDir, "Applications/Harness Anything.app/Contents/MacOS/Harness Anything"),
        path.join(homeDir, "Applications/Harness Anything.app/Contents/MacOS/harness-anything-gui")
      ]
    : platform === "win32"
      ? [
          ...(environment.LOCALAPPDATA ? [path.join(environment.LOCALAPPDATA, "Programs/Harness Anything/Harness Anything.exe")] : []),
          ...(environment.ProgramFiles ? [path.join(environment.ProgramFiles, "Harness Anything/Harness Anything.exe")] : [])
        ]
      : [
          "/usr/local/bin/harness-anything-gui",
          "/usr/bin/harness-anything-gui",
          "/opt/Harness Anything/harness-anything-gui"
        ];
  return [...pathCandidates, ...platformCandidates].find((candidate) => isLaunchableFile(candidate, platform));
}

function executableCandidatesOnPath(name: string, pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  return (pathValue ?? "").split(path.delimiter).filter(Boolean).flatMap((directory) => {
    const candidate = path.join(directory, name);
    return platform === "win32"
      ? [candidate, `${candidate}.exe`, `${candidate}.cmd`]
      : [candidate];
  });
}

function isLaunchableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface PackageJsonSummary {
  readonly name?: unknown;
  readonly workspaces?: unknown;
}

function findTrustedGuiWorkspaceRoot(cliEntrypointPath: string): string | undefined {
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

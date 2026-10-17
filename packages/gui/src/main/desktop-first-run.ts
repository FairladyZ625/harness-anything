import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  daemonServiceCommands,
  daemonServiceUnit,
  daemonServiceUnitContent,
  runDaemonServiceCommand,
} from "@harness-anything/daemon/internal/client/daemon-service";
import { daemonSocketProbe } from "@harness-anything/daemon/internal/daemon-singleton";
import { daemonStdioLogPath } from "@harness-anything/daemon/internal/lifecycle-log";
import { writeDaemonServiceUnit } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { daemonUserRoot, daemonIdFromEnv, localUserDaemonEndpoint } from "@harness-anything/daemon/client";

export interface DesktopRuntimePaths {
  readonly node: string;
  readonly cli: string;
  readonly daemon: string;
}
export interface DesktopEnvironmentReport {
  readonly node: { readonly available: boolean; readonly version: string | null; readonly path: string };
  readonly path: { readonly includesShim: boolean; readonly shellRc: string };
  readonly npmHa: string | null;
  readonly daemon: { readonly endpoint: string; readonly reachable: boolean; readonly serviceInstalled: boolean };
  readonly shim: { readonly path: string; readonly installed: boolean; readonly preservedExistingHa: boolean };
}

export function desktopRuntimePaths(
  resourcesPath: string,
  appPath: string,
  platform = process.platform,
  arch = process.arch,
): DesktopRuntimePaths {
  const runtime = path.join(resourcesPath, "node", `${platform}-${arch}`, platform === "win32" ? "node.exe" : "node");
  const appRoot = path.join(resourcesPath, "app");
  return {
    node: runtime,
    cli: path.join(appRoot, "packages", "cli", "dist", "cli", "src", "index.js"),
    daemon: path.join(
      resourcesPath,
      "app",
      "node_modules",
      "@harness-anything",
      "daemon",
      "dist",
      "daemon",
      "src",
      "bin.js",
    ),
  };
}

export function desktopShimPath(home = os.homedir(), platform = process.platform): string {
  return platform === "win32"
    ? path.join(home, "AppData", "Local", "Harness Anything", "bin", "ha.cmd")
    : path.join(home, "Library", "Application Support", "Harness Anything", "bin", "ha");
}

export function shellRcPath(home = os.homedir(), platform = process.platform): string {
  if (platform === "win32") return path.join(home, "AppData", "Local", "Harness Anything", "shell-path.txt");
  return path.join(home, ".zshrc");
}

export function shimContents(runtime: DesktopRuntimePaths, platform = process.platform): string {
  if (platform === "win32") return `@echo off\n"${runtime.node}" "${runtime.cli}" %*\r\n`;
  return `#!/bin/sh\nexec ${shellQuote(runtime.node)} ${shellQuote(runtime.cli)} "$@"\n`;
}

export function ensureShim(
  runtime: DesktopRuntimePaths,
  home = os.homedir(),
  platform = process.platform,
): { path: string; installed: boolean; preservedExistingHa: boolean } {
  const target = desktopShimPath(home, platform);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  const expected = shimContents(runtime, platform);
  const installed = existing === null;
  if (installed) writeFileSync(target, expected, { mode: 0o700 });
  if (installed && platform !== "win32") chmodSync(target, 0o755);
  return { path: target, installed, preservedExistingHa: existing !== null && existing !== expected };
}

export function ensureShellPath(home = os.homedir(), platform = process.platform): string {
  const rc = shellRcPath(home, platform);
  if (platform === "win32") return rc;
  mkdirSync(path.dirname(rc), { recursive: true });
  const line = `export PATH="$HOME/Library/Application Support/Harness Anything/bin:$PATH"`;
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!current.split(/\r?\n/u).some((entry) => entry.trim() === line))
    writeFileSync(rc, `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}\n`);
  return rc;
}

export function detectNpmHa(env: NodeJS.ProcessEnv = process.env): string | null {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `ha${extension}`);
      if (existsSync(candidate) && candidate !== desktopShimPath()) return candidate;
    }
  }
  return null;
}

export async function installDesktopService(input: {
  readonly runtime: DesktopRuntimePaths;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly home?: string;
}): Promise<{ readonly installed: boolean; readonly unitPath: string | null }> {
  const userRoot = input.userRoot ?? daemonUserRoot();
  const daemonId = input.daemonId ?? daemonIdFromEnv();
  const unit = daemonServiceUnit({ userRoot, daemonId }, process.platform, input.home ?? os.homedir());
  if (!unit) return { installed: false, unitPath: null };
  const content = daemonServiceUnitContent(unit, {
    userRoot,
    daemonId,
    execPath: input.runtime.node,
    entry: input.runtime.daemon,
    searchPath: process.env.PATH ?? "",
    extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
  });
  const changed = !existsSync(unit.unitPath) || readFileSync(unit.unitPath, "utf8") !== content;
  if (changed) {
    if (existsSync(unit.unitPath)) await runDaemonServiceCommand(daemonServiceCommands(unit).unload);
    writeDaemonServiceUnit(unit, content, daemonStdioLogPath(userRoot, daemonId));
  }
  if (unit.manager === "systemd" || changed)
    for (const command of daemonServiceCommands(unit).load) await runDaemonServiceCommand(command);
  return { installed: true, unitPath: unit.unitPath };
}

export async function desktopFirstRunReport(input: {
  readonly runtime: DesktopRuntimePaths;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<DesktopEnvironmentReport> {
  const home = input.home ?? os.homedir();
  const shim = desktopShimPath(home);
  const unit = daemonServiceUnit(
    { userRoot: daemonUserRoot(input.env), daemonId: daemonIdFromEnv(input.env) },
    process.platform,
    home,
  );
  const reachable = await daemonSocketProbe(
    localUserDaemonEndpoint(daemonUserRoot(input.env), daemonIdFromEnv(input.env)),
  );
  const serviceInstalled = unit ? existsSync(unit.unitPath) : false;
  const nodeVersion = existsSync(input.runtime.node)
    ? execFileSync(input.runtime.node, ["--version"], { encoding: "utf8" }).trim()
    : null;
  return {
    node: { available: nodeVersion !== null, version: nodeVersion, path: input.runtime.node },
    path: {
      includesShim: (input.env ?? process.env).PATH?.split(path.delimiter).includes(path.dirname(shim)) ?? false,
      shellRc: shellRcPath(home),
    },
    npmHa: detectNpmHa(input.env),
    daemon: {
      endpoint: localUserDaemonEndpoint(daemonUserRoot(input.env), daemonIdFromEnv(input.env)),
      reachable,
      serviceInstalled,
    },
    shim: { path: shim, installed: existsSync(shim), preservedExistingHa: false },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { daemonSocketProbe } from "@harness-anything/daemon/internal/daemon-singleton";
import { daemonServiceUnit } from "@harness-anything/daemon/internal/client/daemon-service";
import { daemonUserRoot, daemonIdFromEnv, localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import type { DesktopSetupFailure } from "../api/first-run-contract.ts";

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

/** The daemon-service step runs the packaged CLI's own `daemon service install`: one implementation
 *  owns the unit write/load orchestration (including the not-loaded guard around bootout) and the
 *  wait for the daemon to answer, so the App never carries a second copy of it. */
export interface DesktopServiceInstallRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}

export async function runDesktopSetup(input: {
  readonly runtime: DesktopRuntimePaths;
  readonly home?: string;
  readonly runServiceInstall?: (runtime: DesktopRuntimePaths) => Promise<DesktopServiceInstallRun>;
}): Promise<readonly DesktopSetupFailure[]> {
  const home = input.home ?? os.homedir();
  const failures: DesktopSetupFailure[] = [];
  const attempt = (failure: DesktopSetupFailure | null): void => {
    if (failure !== null) failures.push(failure);
  };
  attempt(
    setupStep(
      "terminal-command",
      `确认 ${path.dirname(desktopShimPath(home))} 目录可以写入后，点「重新检查并完成」重试`,
      () => ensureShim(input.runtime, home),
    ),
  );
  attempt(
    setupStep("shell-path", `确认 ${shellRcPath(home)} 可以写入后，点「重新检查并完成」重试`, () =>
      ensureShellPath(home),
    ),
  );
  attempt(await serviceInstallFailure(input.runServiceInstall ?? runCliServiceInstall, input.runtime));
  return failures;
}

function setupStep(step: DesktopSetupFailure["step"], hint: string, action: () => void): DesktopSetupFailure | null {
  try {
    action();
  } catch (cause) {
    return { step, reason: cause instanceof Error ? cause.message : String(cause), hint };
  }
  return null;
}

async function serviceInstallFailure(
  run: (runtime: DesktopRuntimePaths) => Promise<DesktopServiceInstallRun>,
  runtime: DesktopRuntimePaths,
): Promise<DesktopSetupFailure | null> {
  const result = await run(runtime);
  if (result.exitCode === 0) return null;
  return {
    step: "background-service",
    reason: serviceInstallReason(result),
    hint: "在终端运行 ha daemon service install 查看完整原因后重试",
  };
}

function serviceInstallReason(result: DesktopServiceInstallRun): string {
  if (result.error !== null) return result.error;
  for (const line of result.stdout.split(/\r?\n/u).reverse()) {
    const receipt = parseReceiptLine(line);
    if (receipt.ok && typeof receipt.record.hint === "string" && receipt.record.hint !== "") return receipt.record.hint;
  }
  return result.stderr.trim() !== "" ? result.stderr.trim() : `安装命令退出码 ${String(result.exitCode)}`;
}

type ReceiptLine = { readonly ok: true; readonly record: Record<string, unknown> } | { readonly ok: false };

function parseReceiptLine(line: string): ReceiptLine {
  if (line.trim() === "") return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // stdout in --json mode carries exactly the receipt line; one that does not parse is not it.
    return { ok: false };
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "ok" in parsed
    ? { ok: true, record: parsed as Record<string, unknown> }
    : { ok: false };
}

function runCliServiceInstall(runtime: DesktopRuntimePaths): Promise<DesktopServiceInstallRun> {
  return new Promise((resolve) => {
    execFile(
      runtime.node,
      [runtime.cli, "daemon", "service", "install", "--json"],
      { encoding: "utf8", windowsHide: true, timeout: 120_000 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error === null ? 0 : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error !== null && typeof error.code !== "number" ? error.message : null,
        });
      },
    );
  });
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
    ? execFileSync(input.runtime.node, ["--version"], { encoding: "utf8", windowsHide: true }).trim()
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

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dispatchIsolatedTestCommand, parseToolOptions, renderToolHelp, toolOption, toolValue } from "./tool-command-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const sourceRootAllowlist = Object.freeze([
  ".github",
  ".gitignore",
  ".mergify.yml",
  "README.md",
  "docs-release",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "packages",
  "scripts",
  "skills",
  "tools",
  "tsconfig.json"
]);

export function parseDispatchArgs(argv) {
  const parsed = parseToolOptions(dispatchIsolatedTestCommand, argv);
  if (parsed.help) return { help: true };
  const options = { target: toolValue(parsed, "--target") ?? toolOption(dispatchIsolatedTestCommand, "--target").defaultValue, tier: toolValue(parsed, "--tier"), file: toolValue(parsed, "--file") };
  return options;
}

export function testRunnerArgs(options) {
  return ["node", "tools/run-node-tests.mjs", ...(options.tier === undefined ? ["--file", options.file] : ["--tier", options.tier])];
}

export function sourceArchiveArgs(platform = process.platform, sourceRoot = repoRoot) {
  return [
    ...(platform === "darwin" ? ["--no-xattrs"] : []),
    "-cf", "-", "-C", sourceRoot,
    "--null", "-T", "-"
  ];
}

export function sourceRsyncArgs(sourceRoot, destination) {
  return ["-a", "--delete", "--from0", "--files-from=-", `${sourceRoot}/`, destination];
}

export function sourceFileList(sourceRoot = repoRoot, allowedRoots = sourceRootAllowlist, candidates = gitWorktreeFiles(sourceRoot)) {
  const allowed = new Set(allowedRoots);
  return candidates
    .filter((entry) => entry !== "" && !path.isAbsolute(entry) && entry.split("/")[0] !== ".." && allowed.has(entry.split("/")[0]))
    .filter((entry) => pathExists(path.join(sourceRoot, entry)))
    .sort();
}

export function posixTestScript(workspaceRoot, stateRoot, options) {
  const command = testRunnerArgs(options).map(shellQuote).join(" ");
  return [
    "set -eu",
    `cd ${shellQuote(workspaceRoot)}`,
    "npm ci --no-audit --no-fund",
    `node tools/test-hermetic-preflight.mjs --user-root ${shellQuote(stateRoot)}`,
    `HARNESS_DAEMON_USER_ROOT=${shellQuote(stateRoot)} ${command}`
  ].join("\n");
}

export function powerShellTestScript(workspaceRoot, stateRoot, options) {
  const command = testRunnerArgs(options).map(powerShellLiteral).join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Set-Location -LiteralPath ${powerShellLiteral(workspaceRoot)}`,
    "& npm ci --no-audit --no-fund",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `& node tools/test-hermetic-preflight.mjs --user-root ${powerShellLiteral(stateRoot)}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `$env:HARNESS_DAEMON_USER_ROOT = ${powerShellLiteral(stateRoot)}`,
    `& ${command}`,
    "exit $LASTEXITCODE"
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseDispatchArgs(argv);
  } catch (error) {
    console.error(`dispatch-isolated-test: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(renderToolHelp(dispatchIsolatedTestCommand));
    return 0;
  }
  const runId = `harness-test-isolation-${process.pid}-${randomUUID()}`;
  const startedAt = Date.now();
  console.log(`[test-isolation] target=${options.target} selection=${options.tier ? `tier:${options.tier}` : `file:${options.file}`} run=${runId}`);
  const exitCode = options.target === "ubuntu"
    ? await runUbuntu(options, runId)
    : options.target === "docker"
      ? await runDocker(options, runId)
      : await runWindows(options, runId);
  console.log(`[test-isolation] target=${options.target} exit=${exitCode} duration_ms=${Date.now() - startedAt}`);
  return exitCode;
}

async function runUbuntu(options, runId) {
  const workspaceRoot = `/tmp/${runId}`;
  const stateRoot = `${workspaceRoot}/.test-isolation-state`;
  const files = sourceFileList();
  let exitCode = 1;
  try {
    console.log(`[test-isolation] sync=rsync destination=ubuntu:${workspaceRoot}`);
    if (await run("ssh", ["ubuntu", `mkdir -p -- ${shellQuote(workspaceRoot)}`]) === 0
      && await runWithInput("rsync", sourceRsyncArgs(repoRoot, `ubuntu:${workspaceRoot}/`), encodeFileList(files)) === 0) {
      exitCode = await run("ssh", ["ubuntu", posixTestScript(workspaceRoot, stateRoot, options)]);
    }
  } finally {
    const cleanupCode = await run("ssh", ["ubuntu", `rm -rf -- ${shellQuote(workspaceRoot)}`], { quiet: true });
    if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
  }
  return exitCode;
}

async function runDocker(options, runId) {
  const container = runId;
  const workspaceRoot = "/workspace";
  const stateRoot = `/tmp/${runId}`;
  let created = false;
  let exitCode = 1;
  try {
    if (await run("docker", ["create", "--name", container, "--workdir", workspaceRoot, "--entrypoint", "sh", "plt-center-testbed/source:latest", "-lc", posixTestScript(workspaceRoot, stateRoot, options)]) === 0) {
      created = true;
      console.log(`[test-isolation] sync=tar destination=docker:${container}:${workspaceRoot}`);
      if (await copyArchive(["docker", "cp", "-", `${container}:${workspaceRoot}`]) === 0) exitCode = await run("docker", ["start", "-a", container]);
    }
  } finally {
    if (created) {
      const cleanupCode = await run("docker", ["rm", "-f", container], { quiet: true });
      if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
    }
  }
  return exitCode;
}

async function runWindows(options, runId) {
  let workspaceRoot;
  let exitCode = 1;
  try {
    const createScript = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$root = Join-Path $env:TEMP ${powerShellLiteral(runId)}`,
      "New-Item -ItemType Directory -Force -Path $root | Out-Null",
      "[Console]::Out.Write($root)"
    ].join("\n");
    workspaceRoot = (await runCapture("ssh", powerShellArgs(createScript))).trim();
    if (workspaceRoot) {
      console.log(`[test-isolation] sync=tar destination=windows:${workspaceRoot}`);
      const extractScript = `$ProgressPreference = 'SilentlyContinue'\ntar -xf - -C ${powerShellLiteral(workspaceRoot)}`;
      if (await copyArchive(["ssh", "windows-vm", ...powerShellArgs(extractScript).slice(1)]) === 0) {
        exitCode = await run("ssh", powerShellArgs(powerShellTestScript(workspaceRoot, `${workspaceRoot}\\.test-isolation-state`, options)));
      }
    }
  } finally {
    if (workspaceRoot) {
      const cleanupScript = `$ProgressPreference = 'SilentlyContinue'\nRemove-Item -LiteralPath ${powerShellLiteral(workspaceRoot)} -Recurse -Force`;
      const cleanupCode = await run("ssh", powerShellArgs(cleanupScript), { quiet: true });
      if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
    }
  }
  return exitCode;
}

function powerShellArgs(script) {
  return ["windows-vm", "powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

async function copyArchive(destinationArgs) {
  const input = encodeFileList(sourceFileList());
  const archive = spawn("tar", sourceArchiveArgs(), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const destination = spawn(destinationArgs[0], destinationArgs.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  archive.stdin.end(input);
  archive.stdout.pipe(destination.stdin);
  archive.stderr.pipe(process.stderr);
  destination.stdout.pipe(process.stdout);
  destination.stderr.pipe(process.stderr);
  destination.stdin.on("error", () => archive.stdout.unpipe(destination.stdin));
  const [archiveCode, destinationCode] = await Promise.all([waitFor(archive), waitFor(destination)]);
  return archiveCode === 0 && destinationCode === 0 ? 0 : 1;
}

async function run(command, args, options = {}) {
  if (!options.quiet) console.log(`[test-isolation] exec=${formatCommand(command, args)}`);
  const child = spawn(command, args, { stdio: "inherit" });
  return waitFor(child);
}

async function runWithInput(command, args, input) {
  console.log(`[test-isolation] exec=${formatCommand(command, args)}`);
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(input);
  return waitFor(child);
}

async function runCapture(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const exitCode = await waitFor(child);
  return exitCode === 0 ? output : "";
}

function waitFor(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => { console.error(error.message); resolve(1); });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"")}'`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function formatCommand(command, args) {
  const encodedAt = args.indexOf("-EncodedCommand");
  const visible = encodedAt === -1 ? args : [...args.slice(0, encodedAt + 1), "<encoded>"];
  return [command, ...visible].map(shellQuote).join(" ");
}

function gitWorktreeFiles(sourceRoot) {
  return execFileSync("git", ["-C", sourceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function pathExists(target) {
  try { lstatSync(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function encodeFileList(files) {
  return Buffer.from(files.length === 0 ? "" : `${files.join("\0")}\0`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

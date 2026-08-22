#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dispatchIsolatedTestCommand, parseToolOptions, renderToolHelp, toolOption, toolValue } from "./tool-command-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceExcludes = [".git", "node_modules", ".harness", "coverage", "dist", "out"];

export function parseDispatchArgs(argv) {
  const parsed = parseToolOptions(dispatchIsolatedTestCommand, argv);
  if (parsed.help) return { help: true };
  const options = { target: toolValue(parsed, "--target") ?? toolOption(dispatchIsolatedTestCommand, "--target").defaultValue, tier: toolValue(parsed, "--tier"), file: toolValue(parsed, "--file") };
  return options;
}

export function testRunnerArgs(options) {
  return ["node", "tools/run-node-tests.mjs", ...(options.tier === undefined ? ["--file", options.file] : ["--tier", options.tier])];
}

export function sourceArchiveArgs(platform = process.platform) {
  return [
    ...(platform === "darwin" ? ["--no-xattrs"] : []),
    ...sourceExcludes.map((entry) => `--exclude=${entry}`),
    "-cf", "-", "-C", repoRoot, "."
  ];
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
  let exitCode = 1;
  try {
    console.log(`[test-isolation] sync=rsync destination=ubuntu:${workspaceRoot}`);
    if (await run("ssh", ["ubuntu", `mkdir -p -- ${shellQuote(workspaceRoot)}`]) === 0
      && await run("rsync", ["-a", "--delete", ...sourceExcludes.map((entry) => `--exclude=${entry}`), `${repoRoot}/`, `ubuntu:${workspaceRoot}/`]) === 0) {
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
  const archive = spawn("tar", sourceArchiveArgs(), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const destination = spawn(destinationArgs[0], destinationArgs.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

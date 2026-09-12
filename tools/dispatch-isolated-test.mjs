#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  dispatchIsolatedTestCommand,
  parseToolOptions,
  renderToolHelp,
  toolOption,
  toolValue,
} from "./tool-command-contract.mjs";
import { guiVitestManifest } from "./gui-test-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dispatchCommand = Object.freeze({
  ...dispatchIsolatedTestCommand,
  options: Object.freeze(
    dispatchIsolatedTestCommand.options.map((option) =>
      option.name === "--file" ? { ...option, validate: validateDispatchTestFile } : option,
    ),
  ),
});
export function parseDispatchArgs(argv) {
  const parsed = parseToolOptions(dispatchCommand, argv);
  if (parsed.help) return { help: true };
  const options = {
    target: toolValue(parsed, "--target") ?? toolOption(dispatchIsolatedTestCommand, "--target").defaultValue,
    tier: toolValue(parsed, "--tier"),
    file: toolValue(parsed, "--file"),
  };
  return options;
}

export function testRunnerArgs(options) {
  if (options.file !== undefined) validateDispatchTestFile(options.file);
  if (guiVitestManifest.includes(options.file)) {
    return [
      "npm",
      "run",
      "test:gui",
      "--workspace",
      "@harness-anything/gui",
      "--",
      options.file.slice("packages/gui/".length),
    ];
  }
  return [
    "node",
    "tools/run-node-tests.mjs",
    ...(options.tier === undefined ? ["--file", options.file] : ["--tier", options.tier]),
  ];
}

function validateDispatchTestFile(value) {
  if (guiVitestManifest.includes(value)) return;
  if (value.includes(".vitest.")) throw new Error(`unknown GUI test file: ${value}`);
  toolOption(dispatchIsolatedTestCommand, "--file").validate(value);
}

export function sourceArchiveArgs(platform = process.platform, sourceRoot = repoRoot) {
  return [...(platform === "darwin" ? ["--no-xattrs"] : []), "-cf", "-", "-C", sourceRoot, "--null", "-T", "-"];
}

export function sourceRsyncArgs(sourceRoot, destination) {
  return ["-a", "--delete", "--from0", "--files-from=-", `${sourceRoot}/`, destination];
}

export function sourceFileList(sourceRoot = repoRoot) {
  return execFileSync("git", ["-C", sourceRoot, "ls-files", "--cached", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function prepareSource(sourceRoot, snapshotRoot) {
  const files = sourceFileList(sourceRoot);
  // Two generations support both source identity (HEAD) and the clean-tree shard baseline (HEAD^).
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-checkout",
    "--depth",
    "2",
    "--template=",
    pathToFileURL(sourceRoot).href,
    snapshotRoot,
  ]);
  execFileSync("git", ["-C", snapshotRoot, "remote", "remove", "origin"]);
  rmSync(path.join(snapshotRoot, ".git", "logs"), { recursive: true, force: true });
  execFileSync("git", ["-C", snapshotRoot, "reset", "--mixed", "HEAD"], { stdio: "ignore" });
  for (const file of files) {
    const target = path.join(snapshotRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(sourceRoot, file), target, { verbatimSymlinks: true });
  }
  const metadata = readdirSync(path.join(snapshotRoot, ".git"), { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(snapshotRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  return [...files, ...metadata].sort();
}

export function posixTestScript(workspaceRoot, stateRoot, options) {
  const command = testRunnerArgs(options).map(shellQuote).join(" ");
  return [
    "set -eu",
    `cd ${shellQuote(workspaceRoot)}`,
    "npm ci --no-audit --no-fund",
    `node tools/test-hermetic-preflight.mjs --user-root ${shellQuote(stateRoot)}`,
    `HARNESS_DAEMON_USER_ROOT=${shellQuote(stateRoot)} ${command}`,
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
    "exit $LASTEXITCODE",
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
  console.log(
    `[test-isolation] target=${options.target} selection=${options.tier ? `tier:${options.tier}` : `file:${options.file}`} run=${runId}`,
  );
  const snapshotRoot = mkdtempSync(path.join(tmpdir(), `${runId}-`));
  let exitCode;
  try {
    const files = prepareSource(repoRoot, snapshotRoot);
    exitCode =
      options.target === "ubuntu"
        ? await runUbuntu(options, runId, snapshotRoot, files)
        : options.target === "docker"
          ? await runDocker(options, runId, snapshotRoot, files)
          : await runWindows(options, runId, snapshotRoot, files);
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
  console.log(`[test-isolation] target=${options.target} exit=${exitCode} duration_ms=${Date.now() - startedAt}`);
  return exitCode;
}

async function runUbuntu(options, runId, snapshotRoot, files) {
  const workspaceRoot = `/tmp/${runId}`;
  const stateRoot = `${workspaceRoot}/.test-isolation-state`;
  let exitCode = 1;
  try {
    console.log(`[test-isolation] sync=rsync destination=ubuntu:${workspaceRoot}`);
    if (
      (await run("ssh", ["ubuntu", `mkdir -p -- ${shellQuote(workspaceRoot)}`])) === 0 &&
      (await runWithInput(
        "rsync",
        sourceRsyncArgs(snapshotRoot, `ubuntu:${workspaceRoot}/`),
        encodeFileList(files),
      )) === 0
    ) {
      exitCode = await run("ssh", ["ubuntu", posixTestScript(workspaceRoot, stateRoot, options)]);
    }
  } finally {
    const cleanupCode = await run("ssh", ["ubuntu", `rm -rf -- ${shellQuote(workspaceRoot)}`], { quiet: true });
    if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
  }
  return exitCode;
}

async function runDocker(options, runId, snapshotRoot, files) {
  const container = runId;
  const workspaceRoot = "/workspace";
  const stateRoot = `/tmp/${runId}`;
  let created = false;
  let exitCode = 1;
  try {
    if (
      (await run("docker", [
        "create",
        "--name",
        container,
        "--workdir",
        workspaceRoot,
        "--entrypoint",
        "sh",
        "plt-center-testbed/source:latest",
        "-lc",
        posixTestScript(workspaceRoot, stateRoot, options),
      ])) === 0
    ) {
      created = true;
      console.log(`[test-isolation] sync=tar destination=docker:${container}:${workspaceRoot}`);
      if ((await copyArchive(["docker", "cp", "-", `${container}:${workspaceRoot}`], snapshotRoot, files)) === 0)
        exitCode = await run("docker", ["start", "-a", container]);
    }
  } finally {
    if (created) {
      const cleanupCode = await run("docker", ["rm", "-f", container], { quiet: true });
      if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
    }
  }
  return exitCode;
}

async function runWindows(options, runId, snapshotRoot, files) {
  let workspaceRoot;
  let exitCode = 1;
  try {
    const createScript = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$root = Join-Path $env:TEMP ${powerShellLiteral(runId)}`,
      "New-Item -ItemType Directory -Force -Path $root | Out-Null",
      "[Console]::Out.Write($root)",
    ].join("\n");
    workspaceRoot = (await runCapture("ssh", powerShellArgs(createScript))).trim();
    if (workspaceRoot) {
      console.log(`[test-isolation] sync=tar destination=windows:${workspaceRoot}`);
      const extractScript = `$ProgressPreference = 'SilentlyContinue'\ntar -xf - -C ${powerShellLiteral(workspaceRoot)}`;
      if (
        (await copyArchive(["ssh", "windows-vm", ...powerShellArgs(extractScript).slice(1)], snapshotRoot, files)) === 0
      ) {
        exitCode = await run(
          "ssh",
          powerShellArgs(powerShellTestScript(workspaceRoot, `${workspaceRoot}\\.test-isolation-state`, options)),
        );
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
  return [
    "windows-vm",
    "powershell",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

async function copyArchive(destinationArgs, snapshotRoot, files) {
  const input = encodeFileList(files);
  const archive = spawn("tar", sourceArchiveArgs(process.platform, snapshotRoot), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
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
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const exitCode = await waitFor(child);
  return exitCode === 0 ? output : "";
}

function waitFor(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
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

function encodeFileList(files) {
  return Buffer.from(files.length === 0 ? "" : `${files.join("\0")}\0`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { guiVitestFilePattern } from "./gui-test-runner-lib.mjs";

const server = JSON.parse(readFileSync(new URL("./isolated-test-server.json", import.meta.url)));

const repoRoot = path.resolve(import.meta.dirname, "..");

export function sourceRootFromCwd(cwd = process.cwd()) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}
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
    coverage: toolValue(parsed, "--coverage"),
  };
  if (options.coverage !== undefined && isGuiVitestFile(options.file)) {
    throw new Error("--coverage is only supported for Node test files and tiers");
  }
  return options;
}

export function testRunnerArgs(options) {
  if (options.file !== undefined) validateDispatchTestFile(options.file);
  if (isGuiVitestFile(options.file)) {
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
    ...(options.coverageTarget === undefined ? [] : ["--coverage", options.coverageTarget]),
  ];
}

function coveragePath(workspaceRoot) {
  return path.join(workspaceRoot, ".test-coverage", "lcov.info");
}

// GUI vitest files are routed to the vitest lane by shape; the runner discovers
// them dynamically, so the only registry is the file system itself.
function isGuiVitestFile(value) {
  return value !== undefined && value.startsWith("packages/gui/test/") && guiVitestFilePattern.test(value);
}

function validateDispatchTestFile(value) {
  if (isGuiVitestFile(value)) {
    if (existsSync(path.join(sourceRootFromCwd(), value))) return;
    throw new Error(`unknown GUI test file: ${value}`);
  }
  if (value.includes(".vitest.")) throw new Error(`unknown GUI test file: ${value}`);
  toolOption(dispatchIsolatedTestCommand, "--file").validate(value);
}

export function untrackedSelectionError(file, files) {
  if (file === undefined || files.includes(file)) return undefined;
  return (
    `${file} is not tracked by git. Isolated dispatch only syncs git-tracked files, so the isolated target ` +
    `never receives it. Run "git add ${file}" (or commit it) first, then dispatch again.`
  );
}

export function sourceArchiveArgs(platform = process.platform, sourceRoot = repoRoot) {
  return [...(platform === "darwin" ? ["--no-xattrs"] : []), "-cf", "-", "-C", sourceRoot, "--null", "-T", "-"];
}

export function sourceFileList(sourceRoot = repoRoot) {
  const deleted = new Set(
    execFileSync("git", ["-C", sourceRoot, "ls-files", "--deleted", "-z"]).toString().split("\0"),
  );
  return execFileSync("git", ["-C", sourceRoot, "ls-files", "--cached", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((file) => file !== "" && !deleted.has(file))
    .sort();
}

function assertPublicPath(file) {
  if (
    ["harness", ".harness-private", "AGENTS.md", "CLAUDE.md"].some(
      (privatePath) => file === privatePath || file.startsWith(`${privatePath}/`),
    )
  ) {
    throw new Error(`private source path cannot be sent: ${file}`);
  }
}

export function prepareSource(sourceRoot, snapshotRoot) {
  const files = sourceFileList(sourceRoot);
  const generations = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD", "HEAD^@"])
    .toString()
    .trim()
    .split("\n");
  for (const ref of generations) {
    const tree = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "--name-only", "-z", ref])
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const file of tree) assertPublicPath(file);
  }
  for (const file of files) {
    assertPublicPath(file);
    if (lstatSync(path.join(sourceRoot, file)).isSymbolicLink()) {
      const relative = path
        .relative(sourceRoot, realpathSync(path.join(sourceRoot, file)))
        .split(path.sep)
        .join("/");
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error(`source link leaves repository: ${file}`);
      assertPublicPath(relative);
    }
  }
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
  const command = testRunnerArgs({
    ...options,
    coverageTarget: options.coverage === undefined ? undefined : coveragePath(workspaceRoot),
  })
    .map(shellQuote)
    .join(" ");
  return [
    "set -eu",
    `cd ${shellQuote(workspaceRoot)}`,
    ...(options.prepareDependencies === false ? [] : ["node tools/isolated-test-dependencies.mjs"]),
    `node tools/test-hermetic-preflight.mjs --user-root ${shellQuote(stateRoot)}`,
    `HARNESS_TEST_CONCURRENCY=2 HARNESS_DAEMON_USER_ROOT=${shellQuote(stateRoot)} PLAYWRIGHT_BROWSERS_PATH=${shellQuote(path.join(workspaceRoot, ".test-runtime/playwright"))} ELECTRON_CACHE=${shellQuote(path.join(workspaceRoot, ".test-runtime/electron"))} ${command}`,
  ].join("\n");
}

export function localQueueConfig() {
  return {
    mode: "local",
    root: path.join(tmpdir(), "harness-test-isolation-local"),
    capacity: 2,
  };
}

export function powerShellTestScript(workspaceRoot, stateRoot, options) {
  const command = testRunnerArgs({
    ...options,
    coverageTarget: options.coverage === undefined ? undefined : coveragePath(workspaceRoot),
  })
    .map(powerShellLiteral)
    .join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Set-Location -LiteralPath ${powerShellLiteral(workspaceRoot)}`,
    "& node tools/isolated-test-dependencies.mjs",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `& node tools/test-hermetic-preflight.mjs --user-root ${powerShellLiteral(stateRoot)}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `$env:HARNESS_DAEMON_USER_ROOT = ${powerShellLiteral(stateRoot)}`,
    `$env:PLAYWRIGHT_BROWSERS_PATH = ${powerShellLiteral(path.join(workspaceRoot, ".test-runtime/playwright"))}`,
    `$env:ELECTRON_CACHE = ${powerShellLiteral(path.join(workspaceRoot, ".test-runtime/electron"))}`,
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
  let sourceRoot;
  try {
    sourceRoot = sourceRootFromCwd();
  } catch (error) {
    console.error(`dispatch-isolated-test: cannot resolve source repository from cwd: ${error.message}`);
    return 2;
  }
  const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runId = `harness-test-isolation-${process.pid}-${randomUUID()}`;
  const startedAt = Date.now();
  console.log(
    `[test-isolation] target=${options.target} selection=${options.tier ? `tier:${options.tier}` : `file:${options.file}`} run=${runId}`,
  );
  console.log(`[test-isolation] source=${sourceRoot} head=${sourceHead}`);
  const snapshotRoot = mkdtempSync(path.join(tmpdir(), `${runId}-`));
  let exitCode;
  try {
    const files = prepareSource(sourceRoot, snapshotRoot);
    const selectionError = untrackedSelectionError(options.file, files);
    if (selectionError !== undefined) {
      console.error(`dispatch-isolated-test: ${selectionError}`);
      exitCode = 2;
    } else {
      exitCode =
        options.target === "server"
          ? await runServer(options, runId, snapshotRoot, files)
          : options.target === "local"
            ? await runLocal(options, runId, snapshotRoot, files)
            : await runWindows(options, runId, snapshotRoot, files);
    }
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
  console.log(`[test-isolation] target=${options.target} exit=${exitCode} duration_ms=${Date.now() - startedAt}`);
  return exitCode;
}

export function serverQueueCommand(runId, configPath = `${server.root}/config.json`) {
  const script = readFileSync(new URL("./isolated-test-queue.py", import.meta.url), "utf8");
  return `python3 -u -c ${shellQuote(script)} ${shellQuote(runId)} ${shellQuote(configPath)}`;
}

export function localQueueCommand(runId, configPath) {
  const script = readFileSync(new URL("./isolated-test-queue.py", import.meta.url), "utf8");
  return `python3 -u -c ${shellQuote(script)} ${shellQuote(runId)} ${shellQuote(configPath)}`;
}

async function runServer(options, runId, snapshotRoot, files) {
  const workspaceRoot = `${server.root}/runs/${runId}`;
  const stateRoot = "/workspace/.test-isolation-state";
  const destination = `${server.user}@${server.host}`;
  const owner = spawn(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", destination, serverQueueCommand(runId)],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let admitted, synced, finished;
  const admission = new Promise((resolve) => {
    admitted = resolve;
  });
  const synchronization = new Promise((resolve) => {
    synced = resolve;
  });
  const completion = new Promise((resolve) => {
    finished = resolve;
  });
  let pending = "";
  owner.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith("[test-isolation-queue] ")) continue;
      const event = JSON.parse(line.slice("[test-isolation-queue] ".length));
      if (event.event === "admitted") admitted(true);
      if (event.event === "synced") synced(true);
      if (event.event === "finished") finished(event.code);
    }
  });
  const closed = waitFor(owner).then((code) => {
    admitted(false);
    synced(false);
    finished(code);
    return code;
  });
  // Ending the control pipe cancels target preparation/execution and makes its
  // reaper clean the workspace before the ticket releases admission.
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    owner.stdin.end();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
  owner.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  let exitCode = 1;
  try {
    if (await admission) {
      console.log(`[test-isolation] sync=tar destination=${destination}:${workspaceRoot}`);
      const archive = spawnSync("tar", sourceArchiveArgs(process.platform, snapshotRoot), {
        input: encodeFileList(files),
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      if (archive.error) throw archive.error;
      if (archive.status !== 0) {
        process.stderr.write(archive.stderr);
        exitCode = archive.status ?? 1;
      } else if (!cancelled) {
        owner.stdin.write(`${archive.stdout.length}\n`);
        owner.stdin.write(archive.stdout);
        exitCode = (await synchronization) ? 0 : await closed;
      }
      if (exitCode === 0 && !cancelled) {
        owner.stdin.write(
          `${JSON.stringify(posixTestScript("/workspace", stateRoot, { ...options, prepareDependencies: false }))}\n`,
        );
        exitCode = await completion;
        if (exitCode === 0 && options.coverage !== undefined && !cancelled) {
          exitCode = await returnCoverage(options.coverage, "rsync", [
            "-e",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
            "-a",
            `${destination}:${coveragePath(workspaceRoot)}`,
          ]);
        }
      }
    } else exitCode = await closed;
  } finally {
    owner.stdin.end();
    const cleanupCode = await closed;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
    if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
  }
  return cancelled ? 130 : exitCode;
}

async function runLocal(options, runId, snapshotRoot, files) {
  const config = localQueueConfig();
  mkdirSync(config.root, { recursive: true });
  const configPath = path.join(config.root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const workspaceRoot = path.join(config.root, "runs", runId);
  const owner = spawn("sh", ["-c", `exec ${localQueueCommand(runId, configPath)}`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let admitted, synced, finished;
  const admission = new Promise((resolve) => (admitted = resolve));
  const synchronization = new Promise((resolve) => (synced = resolve));
  const completion = new Promise((resolve) => (finished = resolve));
  let pending = "";
  owner.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith("[test-isolation-queue] ")) continue;
      const event = JSON.parse(line.slice("[test-isolation-queue] ".length));
      if (event.event === "admitted") admitted(true);
      if (event.event === "synced") synced(true);
      if (event.event === "finished") finished(event.code);
    }
  });
  const closed = waitFor(owner).then((code) => {
    admitted(false);
    synced(false);
    finished(code);
    return code;
  });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    owner.stdin.end();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
  owner.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  let exitCode = 1;
  try {
    if (await admission) {
      const archive = spawnSync("tar", sourceArchiveArgs(process.platform, snapshotRoot), {
        input: encodeFileList(files),
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      if (archive.error) throw archive.error;
      if (archive.status !== 0) {
        process.stderr.write(archive.stderr);
        exitCode = archive.status ?? 1;
      } else if (!cancelled) {
        owner.stdin.write(`${archive.stdout.length}\n`);
        owner.stdin.write(archive.stdout);
        exitCode = (await synchronization) ? 0 : await closed;
      }
      if (exitCode === 0 && !cancelled) {
        owner.stdin.write(
          `${JSON.stringify(posixTestScript(workspaceRoot, path.join(workspaceRoot, ".test-isolation-state"), options))}\n`,
        );
        exitCode = await completion;
      }
    } else exitCode = await closed;
  } finally {
    owner.stdin.end();
    const cleanupCode = await closed;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
    if (exitCode === 0 && cleanupCode !== 0) exitCode = cleanupCode;
  }
  return cancelled ? 130 : exitCode;
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
        if (exitCode === 0 && options.coverage !== undefined) {
          const readScript = `[Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes(${powerShellLiteral(coveragePath(workspaceRoot))})))`;
          const encoded = (await runCapture("ssh", powerShellArgs(readScript))).trim();
          exitCode = encoded.length === 0 ? 1 : writeCoverage(options.coverage, Buffer.from(encoded, "base64"));
        }
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

async function returnCoverage(destination, command, args) {
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  return run(command, [...args, path.resolve(destination)]);
}

function writeCoverage(destination, content) {
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  writeFileSync(path.resolve(destination), content);
  return 0;
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
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
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

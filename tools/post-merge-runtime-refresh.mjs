import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliBuildPrefixes = [
  "packages/adapters/local/src/",
  "packages/adapters/multica/src/",
  "packages/application/src/",
  "packages/cli/src/",
  "packages/daemon/src/",
  "packages/gui/src/",
  "packages/kernel/src/"
];

const rootBuildFiles = new Set(["package-lock.json", "package.json", "tsconfig.json"]);
const cliBuildFiles = new Set([
  "packages/adapters/local/package.json",
  "packages/adapters/multica/package.json",
  "packages/application/package.json",
  "packages/cli/package.json",
  "packages/cli/scripts/copy-assets.mjs",
  "packages/cli/tsconfig.build.json",
  "packages/daemon/package.json",
  "packages/gui/package.json",
  "packages/kernel/package.json"
]);
const guiBuildPrefixes = ["packages/application/src/", "packages/gui/src/", "packages/kernel/src/"];
const guiBuildFiles = new Set([
  "packages/application/package.json",
  "packages/gui/package.json",
  "packages/kernel/package.json"
]);

function isPackageManifest(file) {
  return file === "package.json" || file === "package-lock.json" || file.endsWith("/package.json");
}

export function planPostMergeRuntimeRefresh(input) {
  const buildCli = input.changedPaths.some((file) =>
    rootBuildFiles.has(file) || cliBuildFiles.has(file) || cliBuildPrefixes.some((prefix) => file.startsWith(prefix))
  );
  const buildGui = input.changedPaths.some((file) =>
    rootBuildFiles.has(file) || guiBuildFiles.has(file) || guiBuildPrefixes.some((prefix) => file.startsWith(prefix))
  );
  const onCanonicalMain = input.branch === "main";
  const daemon = daemonStatusView(input.daemonStatus);
  const daemonMatchesCanonicalRoot = daemon.canonicalRoot === input.repoRoot;

  return {
    buildCli,
    buildGui,
    installCli: buildCli && onCanonicalMain,
    refreshDaemon: buildCli
      && onCanonicalMain
      && daemonMatchesCanonicalRoot
      && daemon.started === true
      && daemon.reachable === true
      && typeof daemon.pid === "number",
    syncDependencies: input.changedPaths.some(isPackageManifest)
  };
}

export function executePostMergeRuntimeRefresh(input) {
  const cliEntry = path.join(input.repoRoot, "packages/cli/dist/cli/src/index.js");
  const wrapped = (label, command, args) => input.run(process.execPath, [
    "tools/run-with-local-resources.mjs",
    "--label",
    label,
    "--",
    command,
    ...args
  ]);

  if (input.plan.syncDependencies) {
    wrapped("git-hook-dependency-sync", "npm", ["ci"]);
  }
  if (input.plan.buildCli) {
    wrapped("git-hook-cli-build", "npm", ["run", "build", "-w", "@harness-anything/cli"]);
  }
  if (input.plan.buildGui) {
    wrapped("git-hook-gui-build", "npm", ["run", "build", "-w", "@harness-anything/gui"]);
  }
  if (input.plan.installCli) {
    input.run(process.execPath, [cliEntry, "--json", "version"], { print: false });
    input.run("npm", ["install", "-g", "./packages/cli"]);
  }
  if (!input.plan.refreshDaemon) return;

  const before = daemonStatusView(input.daemonStatus);
  const control = parseJsonObject(input.run(process.execPath, [
    cliEntry,
    "--root",
    input.repoRoot,
    "daemon",
    "refresh",
    "--trigger",
    "post-merge",
    "--timeout-ms",
    "30000",
    "--reason",
    "post-merge runtime build installed",
    "--json"
  ], { print: false }), "post-merge: refresh control returned invalid JSON");
  const accepted = acceptedRefreshControl(control, before);
  const status = waitForRefreshedDaemon({
    cliEntry,
    input,
    before: {
      ...before,
      pid: accepted.beforePid,
      loadedIdentity: accepted.beforeLoadedIdentity ?? before.loadedIdentity
    }
  });
  assertRefreshedDaemon(status, {
    ...before,
    pid: accepted.beforePid,
    loadedIdentity: accepted.beforeLoadedIdentity ?? before.loadedIdentity
  }, input.repoRoot);
  input.run(process.execPath, [cliEntry, "--root", input.repoRoot, "task", "list", "--limit", "1"]);
}

export function runPostMergeRuntimeRefresh(input) {
  const branch = input.run("git", ["branch", "--show-current"], { print: false }).trim();
  const changedPaths = input.run("git", [
    "diff",
    "--name-only",
    input.previousHead,
    input.currentHead,
    "--"
  ], { print: false }).split(/\r?\n/u).filter(Boolean);
  const initialPlan = planPostMergeRuntimeRefresh({ branch, changedPaths, repoRoot: input.repoRoot });
  let daemonStatus;
  if (branch === "main" && initialPlan.buildCli) {
    try {
      daemonStatus = JSON.parse(input.run("ha", ["--root", input.repoRoot, "daemon", "status", "--json"], { print: false }));
    } catch (error) {
      input.log?.(`post-merge: unable to read the existing Daemon status; it will not be restarted: ${error instanceof Error ? error.message : String(error)}`);
      daemonStatus = undefined;
    }
  }
  const plan = planPostMergeRuntimeRefresh({ branch, changedPaths, daemonStatus, repoRoot: input.repoRoot });
  input.log?.(`post-merge: plan dependency-sync=${plan.syncDependencies} cli-build=${plan.buildCli} gui-build=${plan.buildGui} install-cli=${plan.installCli} refresh-daemon=${plan.refreshDaemon}`);
  executePostMergeRuntimeRefresh({ daemonStatus, plan, repoRoot: input.repoRoot, run: input.run });
  return plan;
}

function acceptedRefreshControl(control, before) {
  if (control.ok !== true
    || control.accepted !== true
    || control.kind !== "refresh"
    || typeof control.operationId !== "string"
    || control.operationId.length === 0) {
    throw new Error("post-merge: refresh request was rejected or returned an invalid control receipt");
  }
  const controlBefore = isRecord(control.before) ? control.before : {};
  const beforePid = typeof controlBefore.pid === "number" ? controlBefore.pid : before.pid;
  const beforeLoadedIdentity = typeof controlBefore.loadedIdentity === "string"
    ? controlBefore.loadedIdentity
    : before.loadedIdentity;
  if (typeof beforePid !== "number") {
    throw new Error("post-merge: refresh control receipt did not identify the running daemon PID");
  }
  if (typeof before.pid === "number" && beforePid !== before.pid) {
    throw new Error(`post-merge: refresh control targeted unexpected daemon PID: ${String(beforePid)}`);
  }
  if (before.loadedIdentity && beforeLoadedIdentity !== before.loadedIdentity) {
    throw new Error(`post-merge: refresh control targeted unexpected build identity: ${String(beforeLoadedIdentity)}`);
  }
  return { beforePid, beforeLoadedIdentity };
}

function waitForRefreshedDaemon({ cliEntry, input, before }) {
  const attempts = input.statusPollAttempts ?? 300;
  const wait = input.wait ?? waitSynchronously;
  let lastStatus;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastStatus = parseJsonObject(input.run(process.execPath, [
        cliEntry,
        "--root",
        input.repoRoot,
        "daemon",
        "status",
        "--json"
      ], { print: false }), "post-merge: daemon status returned invalid JSON");
      if (isRefreshedDaemon(lastStatus, before, input.repoRoot)) return lastStatus;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) wait(100);
  }
  if (lastStatus) return lastStatus;
  throw new Error(`post-merge: refreshed daemon is not reachable${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

function isRefreshedDaemon(status, before, repoRoot) {
  const current = daemonStatusView(status);
  return current.reachable === true
    && current.started === true
    && current.canonicalRoot === repoRoot
    && typeof current.pid === "number"
    && current.pid !== before.pid
    && typeof current.loadedIdentity === "string"
    && current.loadedIdentity !== before.loadedIdentity
    && current.loadedIdentity === current.installedIdentity
    && current.stale === false
    && current.queueDepth === 0;
}

function assertRefreshedDaemon(status, before, repoRoot) {
  const current = daemonStatusView(status);
  if (current.reachable !== true || current.started !== true) {
    throw new Error("post-merge: refreshed daemon is not reachable");
  }
  if (current.canonicalRoot !== repoRoot) {
    throw new Error(`post-merge: refreshed daemon root mismatch: ${String(current.canonicalRoot)}`);
  }
  if (current.pid === before.pid) {
    throw new Error(`post-merge: daemon PID did not change: ${String(current.pid)}`);
  }
  if (current.loadedIdentity === before.loadedIdentity) {
    throw new Error(`post-merge: daemon build identity did not change: ${String(current.loadedIdentity)}`);
  }
  if (!current.loadedIdentity || current.loadedIdentity !== current.installedIdentity || current.stale !== false) {
    throw new Error(`post-merge: refreshed daemon did not load the installed build identity: loaded=${String(current.loadedIdentity)} installed=${String(current.installedIdentity)}`);
  }
  if (current.queueDepth !== 0) {
    throw new Error(`post-merge: refreshed daemon queue is not empty: ${String(current.queueDepth)}`);
  }
}

function daemonStatusView(status) {
  const source = isRecord(status) ? status : {};
  const service = isRecord(source.service) ? source.service : {};
  const requestedRepo = isRecord(source.requestedRepo) ? source.requestedRepo : {};
  const build = isRecord(service.build) ? service.build : {};
  const queue = isRecord(service.queue) ? service.queue : {};
  return {
    started: source.started === true || service.started === true,
    reachable: source.reachable === true,
    pid: typeof service.pid === "number" ? service.pid : source.pid,
    canonicalRoot: typeof requestedRepo.canonicalRoot === "string" ? requestedRepo.canonicalRoot : source.rootDir,
    queueDepth: typeof queue.depth === "number" ? queue.depth : source.queueDepth,
    loadedIdentity: typeof build.loadedIdentity === "string" ? build.loadedIdentity : undefined,
    installedIdentity: typeof build.installedIdentity === "string" ? build.installedIdentity : undefined,
    stale: typeof build.stale === "boolean" ? build.stale : undefined
  };
}

function parseJsonObject(value, errorMessage) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorMessage);
  }
  if (!isRecord(parsed)) throw new Error(errorMessage);
  return parsed;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function waitSynchronously(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createPostMergeCommandRunner(repoRoot) {
  return (command, args, options = {}) => {
    if (options.print !== false) {
      execFileSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        windowsHide: true
      });
      return "";
    }
    const output = execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return output;
  };
}

export function main(argv = process.argv.slice(2)) {
  const previousHead = argv[0];
  const currentHead = argv[1] ?? "HEAD";
  if (!previousHead) throw new Error("post-merge: expected <previous-head> [current-head]");
  const repoRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim());
  return runPostMergeRuntimeRefresh({
    currentHead,
    previousHead,
    repoRoot,
    run: createPostMergeCommandRunner(repoRoot),
    log: (message) => console.log(message)
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
    if (stderr) process.stderr.write(stderr);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

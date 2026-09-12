#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realizedTaskPlan } from "./fixtures/task-plan.mjs";

export function runCliPackageSmoke(root = process.cwd()) {
  buildCliPackageArtifact(root);
  execNpmFileSync(["run", "build", "--workspace", "@harness-anything/daemon"], { cwd: root, stdio: "inherit" });
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ha-cli-pack-")),
    packDir = path.join(tempRoot, "pack"),
    consumerDir = path.join(tempRoot, "consumer");
  const projectDir = path.join(consumerDir, "workspace"),
    userRoot = path.join(consumerDir, "daemon-user"),
    home = path.join(consumerDir, "home");
  let binPath,
    started = false;
  try {
    // npm is npm.cmd on Windows and Node will not execute a .cmd directly; a shell resolves the
    // shim. Every argument below is a literal or a path this script built.
    mkdirSync(packDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(projectDir);
    mkdirSync(home);
    const tarballs = ["@harness-anything/cli", "@harness-anything/daemon"].map((workspace) => {
      const packed = JSON.parse(
        execNpmFileSync(["pack", "--workspace", workspace, "--pack-destination", packDir, "--json"], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
        }),
      )[0];
      const tarball = path.join(packDir, packed?.filename ?? "");
      if (!packed?.filename || !existsSync(tarball))
        throw new Error(`npm pack did not produce the ${workspace} tarball`);
      return tarball;
    });
    execNpmFileSync(["install", "--prefix", consumerDir, "--no-audit", "--no-fund", ...tarballs], {
      cwd: root,
      stdio: "inherit",
    });
    binPath = resolveBinCommand(consumerDir, "harness-anything");
    const alias = resolveBinCommand(consumerDir, "ha");
    for (const command of [binPath, alias]) {
      const help = run(command, ["--help"], projectDir, env(userRoot, home));
      if (
        help.status !== 0 ||
        !help.stdout.includes("ha daemon start --service") ||
        !help.stdout.includes("capabilities [--json]") ||
        !help.stdout.includes("--version")
      )
        throw new Error(`unexpected packaged help: ${help.stdout}${help.stderr}`);
      for (const [domain, usages] of [
        [
          "init",
          [
            "ha init [--repo-id <repo-id>] [--person-id <person-id>] [--display-name <display-name>]",
            "--repo-id — optional; value",
            "--person-id — optional; value",
            "--display-name — optional; value",
          ],
        ],
        ["vertical", ["ha vertical validate"]],
        ["template", ["ha template list", "ha template render <ref> [--locale <zh-CN|en-US>]"]],
        ["script", ["ha script list", "ha script inspect <id>"]],
      ]) {
        const domainHelp = run(command, [domain, "--help"], projectDir, env(userRoot, home));
        if (domainHelp.status !== 0 || !usages.every((usage) => domainHelp.stdout.includes(usage)))
          throw new Error(`unexpected packaged ${domain} help: ${domainHelp.stdout}${domainHelp.stderr}`);
      }
    }
    // The old posture (a merely missing daemon rejects bootstrap) was overturned
    // by bounded autostart: a plain `ha init` now starts the daemon on demand.
    // What must still hold is that bootstrap fails closed when the daemon CANNOT
    // start. A read-only user root makes every spawned `daemon serve` die writing
    // its pid file, so autostart exhausts its two attempts and reports the
    // classified startup failure without touching the project tree. POSIX non-root
    // only (the package-policy CI job runs ubuntu-latest); root ignores the mode.
    const unstartableSupported = process.platform !== "win32" && process.getuid?.() !== 0;
    let unstartableMs = null;
    if (unstartableSupported) {
      const deniedRoot = path.join(consumerDir, "denied-user");
      mkdirSync(deniedRoot);
      chmodSync(deniedRoot, 0o555);
      try {
        const failClosedStarted = performance.now(),
          failedStart = runJson(
            binPath,
            [
              "--root",
              projectDir,
              "--json",
              "init",
              "--repo-id",
              "smoke",
              "--person-id",
              "owner",
              "--display-name",
              "Owner",
            ],
            projectDir,
            env(path.join(deniedRoot, "user"), home),
          );
        unstartableMs = performance.now() - failClosedStarted;
        assertUnstartableDaemonFailedClosed(failedStart, existsSync(path.join(projectDir, "harness")));
        // Bounded, not instant: two attempts x 10s ready wait + 500ms retry gap,
        // plus cold-start slack for the two dying daemon processes.
        if (unstartableMs > 30_000)
          throw new Error(
            `unstartable-daemon rejection ${unstartableMs.toFixed(3)}ms exceeded the bounded two-attempt budget`,
          );
      } finally {
        chmodSync(deniedRoot, 0o755);
      }
    } else {
      console.log(
        "CLI package smoke: skipping unstartable-daemon fail-closed check (requires POSIX non-root permission semantics).",
      );
    }
    const daemonStart = runJson(
      binPath,
      ["--root", projectDir, "--json", "daemon", "start", "--service"],
      projectDir,
      env(userRoot, home),
    );
    started = daemonStart.status === 0 && daemonStart.receipt?.ok === true;
    expectOk(daemonStart, "daemon start");
    const initialized = expectOk(
      runJson(
        binPath,
        [
          "--root",
          projectDir,
          "--json",
          "init",
          "--repo-id",
          "smoke",
          "--person-id",
          "owner",
          "--display-name",
          "Owner",
        ],
        projectDir,
        env(userRoot, home),
      ),
      "init",
    );
    if (initialized.repoId !== "smoke" || !existsSync(path.join(projectDir, "harness/harness.yaml")))
      throw new Error(`unexpected init receipt: ${JSON.stringify(initialized)}`);
    const created = expectOk(
      runJson(
        binPath,
        [
          "--root",
          projectDir,
          "--json",
          "task",
          "create",
          "--id",
          "task-smoke",
          "--admin",
          "--title",
          "Smoke Task",
          "--preset",
          "docs-task",
        ],
        projectDir,
        env(userRoot, home),
      ),
      "task create",
    );
    // Writes return at durable acceptance; the package directory appears once both followers publish it.
    expectOk(
      runJson(
        binPath,
        [
          "--root",
          projectDir,
          "--json",
          "receipt",
          "show",
          String(created.opId),
          "--wait",
          "git_verified,worktree_visible",
          "--timeout-ms",
          "5000",
        ],
        projectDir,
        env(userRoot, home),
      ),
      "receipt show",
    );
    const planPath = `${String(created.packagePath)}/task_plan.md`;
    writeFileSync(path.join(projectDir, "harness", planPath), realizedTaskPlan("Smoke Task"));
    expectOk(
      runJson(
        binPath,
        ["--root", projectDir, "--json", "doc", "sync", "--submit", "--path", planPath],
        projectDir,
        env(userRoot, home),
      ),
      "task plan submit",
    );
    expectOk(
      runJson(binPath, ["--root", projectDir, "--json", "task", "show", "task-smoke"], projectDir, env(userRoot, home)),
      "task show",
    );
    expectOk(
      runJson(
        binPath,
        ["--root", projectDir, "--json", "task", "start", "task-smoke", "--execution-id", "execution-smoke"],
        projectDir,
        env(userRoot, home),
      ),
      "task start",
    );
    const taskDir = path.join(projectDir, "harness", String(created.packagePath));
    mkdirSync(path.join(taskDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(taskDir, "artifacts", "smoke.md"),
      "# Packaged CLI smoke\n\nBootstrap, task creation and execution start returned successful receipts.\n",
    );
    writeFileSync(
      path.join(taskDir, "closeout.md"),
      "# Closeout\n\n## Summary\n\nThe packaged CLI bootstrapped a workspace and started its smoke task.\n\n" +
        "## Verification\n\nBoth installed CLI aliases expose help; init, task create and task start returned successful receipts.\n\n" +
        "## Residual Risk\n\nDaemon restart behavior is checked after submission.\n\n" +
        "## Same Mechanism Elsewhere\n\nThe installed ha alias uses the same lifecycle entry point.\n",
    );
    expectOk(
      runJson(
        binPath,
        ["--root", projectDir, "--json", "task", "submit", "task-smoke"],
        projectDir,
        env(userRoot, home),
      ),
      "task submit",
    );
    expectOk(
      runJson(binPath, ["--root", projectDir, "--json", "daemon", "status"], projectDir, env(userRoot, home)),
      "daemon status",
    );
    expectOk(
      runJson(binPath, ["--root", projectDir, "--json", "daemon", "stop"], projectDir, env(userRoot, home)),
      "daemon stop",
    );
    started = false;
    // An explicit operator stop sticks: a plain repository command is refused by name
    // instead of resurrecting the daemon (the cold-migration single-writer window).
    const refused = runJson(binPath, ["--root", projectDir, "--json", "task", "list"], projectDir, env(userRoot, home));
    if (refused.status === 0 || refused.receipt?.ok !== false || refused.receipt?.code !== "daemon_stopped_by_operator")
      throw new Error(
        `task list after an explicit stop must be refused with daemon_stopped_by_operator: ${JSON.stringify(refused)}`,
      );
    if (existsSync(path.join(userRoot, "daemon-default.pid")))
      throw new Error("explicit stop was not sticky: a daemon pid appeared after the refused command");
    expectOk(
      runJson(
        binPath,
        ["--root", projectDir, "--json", "daemon", "start", "--service"],
        projectDir,
        env(userRoot, home),
      ),
      "daemon start after operator stop",
    );
    started = true;
    // Bounded autostart is the headline behavior for a daemon that died without an operator
    // stop: kill it outright, then a plain repository command must bring it back and still answer.
    const killedPid = Number(readFileSync(path.join(userRoot, "daemon-default.pid"), "utf8").trim());
    process.kill(killedPid, "SIGKILL");
    for (const deadline = Date.now() + 10_000; ; ) {
      try {
        process.kill(killedPid, 0);
      } catch {
        break;
      }
      if (Date.now() > deadline) throw new Error(`daemon ${killedPid} survived SIGKILL for 10s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    expectOk(
      runJson(binPath, ["--root", projectDir, "--json", "task", "list"], projectDir, env(userRoot, home)),
      "task list after auto-start",
    );
    started = true;
    expectOk(
      runJson(binPath, ["--root", projectDir, "--json", "daemon", "stop"], projectDir, env(userRoot, home)),
      "daemon stop after auto-start",
    );
    started = false;
    console.log(
      `CLI package smoke passed: npm-pack consumer bootstrap + lifecycle + sticky operator stop + auto-start after kill; unstartable-daemon rejection=${unstartableMs === null ? "skipped" : `${unstartableMs.toFixed(3)}ms`}.`,
    );
  } finally {
    if (started && binPath)
      run(binPath, ["--root", projectDir, "--json", "daemon", "stop"], projectDir, env(userRoot, home));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function buildCliPackageArtifact(root, options = {}) {
  const exec = options.execFileSync ?? execFileSync,
    exists = options.existsSync ?? existsSync,
    platform = options.platform ?? process.platform,
    environment = { ...process.env, ...(options.environment ?? {}) },
    invocation = npmInvocation(["run", "build", "--workspace", "@harness-anything/cli"], platform, environment);
  exec(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
    env: { ...environment, NPM_CONFIG_IGNORE_SCRIPTS: "false" },
    windowsHide: platform === "win32",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const bin = path.join(root, "packages/cli/dist/cli/src/index.js");
  if (!exists(bin)) throw new Error(`explicit CLI package build did not produce ${bin}`);
}

function execNpmFileSync(args, options = {}) {
  const invocation = npmInvocation(args, process.platform, process.env);
  return execFileSync(invocation.command, invocation.args, {
    ...options,
    windowsHide: process.platform === "win32",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

function npmInvocation(args, platform, environment) {
  if (platform !== "win32") return { command: "npm", args };
  const command = environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
    commandLine = ["npm.cmd", ...args].map(quoteWindowsArgument).join(" ");
  return { command, args: ["/d", "/s", "/c", commandLine], windowsVerbatimArguments: true };
}

function quoteWindowsArgument(value) {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}
export function assertUnstartableDaemonFailedClosed(result, harnessExists) {
  const detail = JSON.stringify(result);
  if (result.status === 0) throw new Error(`unstartable-daemon must exit non-zero: ${detail}`);
  if (result.receipt?.ok !== false) throw new Error(`unstartable-daemon receipt must report ok=false: ${detail}`);
  const code = result.receipt?.error?.code;
  if (code !== "daemon_bind_timeout" && code !== "daemon_spawn_permission")
    throw new Error(`unexpected unstartable-daemon code: ${String(code)}; ${detail}`);
  if (harnessExists) throw new Error(`unstartable-daemon created harness before failing: ${detail}`);
}
function runJson(command, args, cwd, environment) {
  const result = run(command, args, cwd, environment);
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    throw new Error(`CLI did not emit JSON: ${result.stdout}${result.stderr}`);
  }
  return { ...result, receipt };
}
function run(command, args, cwd, environment) {
  const result = spawnSync(command.file, [...command.argsPrefix, ...args], { cwd, encoding: "utf8", env: environment });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function expectOk(result, label) {
  if (result.status !== 0 || result.receipt?.ok !== true || result.receipt?.schema !== "command-receipt/v2")
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  return result.receipt;
}
function env(userRoot, home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot };
}
function resolveBinCommand(consumerDir, name) {
  const packageEntry = path.join(consumerDir, "node_modules/@harness-anything/cli/dist/cli/src/index.js");
  if (process.platform === "win32" && existsSync(packageEntry))
    return { file: process.execPath, argsPrefix: [packageEntry] };
  const binRoot = path.join(consumerDir, "node_modules/.bin"),
    candidates = process.platform === "win32" ? [`${name}.cmd`, `${name}.ps1`, name] : [name];
  for (const candidate of candidates) {
    const file = path.join(binRoot, candidate);
    if (existsSync(file)) return { file, argsPrefix: [] };
  }
  return { file: path.join(binRoot, name), argsPrefix: [] };
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCliPackageSmoke();

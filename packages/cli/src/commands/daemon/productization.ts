import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHarnessRuntimeContext,
  registerDaemonRepo,
  resolveHarnessLayout,
} from "../../../../kernel/src/index.ts";
import {
  currentDaemonProtocolVersion
} from "../../../../daemon/src/index.ts";
import { initializeHarness } from "../init.ts";
import { resolveCliVersion } from "../core/version.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { readOption } from "../../cli/parse-options.ts";
import { resolveLocalDaemonTarget, requestLocalDaemonJsonRpc, type LocalDaemonTarget } from "../../daemon/client.ts";
import { renderDaemonHelp } from "./help.ts";
import { loadDaemonIdentityWithEmail } from "./identity.ts";
import { runDaemonRepoCommand } from "./repo-registry.ts";

export {
  daemonStatusPayload,
  type DaemonConnectionStats,
  type DaemonStatusRuntimeRepo
} from "./status-payload.ts";

export interface DaemonCommandInput {
  readonly rootDir: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly json: boolean;
  readonly args: ReadonlyArray<string>;
  readonly runServe: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    args: ReadonlyArray<string>,
    hooks?: DaemonServeHooks
  ) => Promise<void>;
}

export interface DaemonServeHooks {
  readonly onStarted?: (status: Record<string, unknown>) => void;
}

export function loadDaemonIdentity(rootDir: string, layoutOverrides: { readonly authoredRoot?: string } | undefined, endpoint?: string, userRoot?: string) {
  const runtimeContext = createHarnessRuntimeContext(rootDir, layoutOverrides);
  const authoredRoot = resolveHarnessLayout(runtimeContext).authoredRoot;
  const primaryEmail = process.env.HARNESS_GIT_AUTHOR_EMAIL?.trim()
    || process.env.GIT_AUTHOR_EMAIL?.trim()
    || readGitConfigEmail(authoredRoot);
  return loadDaemonIdentityWithEmail(rootDir, layoutOverrides, primaryEmail, endpoint, userRoot);
}

function readGitConfigEmail(authoredRoot: string): string | undefined {
  try {
    const configured = execFileSync("git", ["-C", authoredRoot, "config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return configured || undefined;
  } catch {
    return undefined;
  }
}

export async function runDaemonProductCommand(input: DaemonCommandInput): Promise<number> {
  const action = input.args[1] ?? "status";
  if (action === "--help" || action === "-h" || input.args.includes("--help") || input.args.includes("-h")) {
    console.log(renderDaemonHelp());
    return 0;
  }
  try {
    if (action === "start") return await startDaemon(input);
    if (action === "status") return await statusDaemon(input);
    if (action === "stop") return await stopDaemon(input);
    if (action === "bootstrap-server") return await bootstrapServer(input);
    if (action === "install-templates") return installTemplates(input);
    if (action === "repo") return runDaemonRepoCommand({ rootDir: input.rootDir, args: input.args, json: input.json });
    emitDaemonError(`unknown daemon command: ${action}`, input.json);
    return 2;
  } catch (error) {
    emitDaemonError(error instanceof Error ? error.message : String(error), input.json);
    return 1;
  }
}

async function startDaemon(input: DaemonCommandInput): Promise<number> {
  const foreground = input.args.includes("--foreground");
  const service = input.args.includes("--service") || !foreground;
  const target = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: daemonRepoIdOverride(input.args),
    autoRegisterSingleRepo: true
  });
  const socketPath = readOption(input.args, "--socket") ?? target.socketPath;
  if (foreground) {
    await input.runServe(target.canonicalRoot, input.layoutOverrides, ["daemon", "serve", "--repo", target.repoId, "--socket", socketPath, "--user-root", target.userRoot, "--idle-ms", "0"], {
      onStarted: (status) => emitDaemonResult("daemon-start", { ...status, mode: "foreground" }, input.json)
    });
    return 0;
  }
  if (service) {
    const child = spawn(process.execPath, [
      ...process.execArgv,
      productizationCliEntrypointPath(),
      "--root",
      target.canonicalRoot,
      ...(input.layoutOverrides?.authoredRoot ? ["--authored-root", input.layoutOverrides.authoredRoot] : []),
      "daemon",
      "serve",
      "--repo",
      target.repoId,
      "--socket",
      socketPath,
      "--user-root",
      target.userRoot,
      "--idle-ms",
      "0"
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: target.userRoot, HARNESS_DAEMON_ID: target.daemonId }
    });
    child.unref();
    const status = await waitForReachableStatus(target, 6_000);
    emitDaemonResult("daemon-start", { ...status, mode: "service", socketPath }, input.json);
    return 0;
  }
  return 0;
}

async function statusDaemon(input: DaemonCommandInput): Promise<number> {
  const target = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: daemonRepoIdOverride(input.args),
    autoRegisterSingleRepo: false
  });
  const layout = resolveHarnessLayout(createHarnessRuntimeContext(target.canonicalRoot, input.layoutOverrides));
  const lockStatus = readDaemonLock(path.join(layout.locksRoot, "global.lock"));
  const rpcStatus = await readReachableDaemonStatus(target);
  emitDaemonResult("daemon-status", {
    ...lockStatus,
    ...(rpcStatus ?? {
      version: resolveCliVersion(),
      protocolVersion: currentDaemonProtocolVersion,
      queueDepth: 0,
      queue: { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false },
      connections: { active: 0, total: 0 }
    }),
    started: rpcStatus?.started === true,
    reachable: Boolean(rpcStatus)
  }, input.json);
  return 0;
}

async function stopDaemon(input: DaemonCommandInput): Promise<number> {
  const timeoutMs = Number.parseInt(readOption(input.args, "--timeout-ms") ?? "5000", 10);
  const target = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: daemonRepoIdOverride(input.args),
    autoRegisterSingleRepo: false
  });
  const layout = resolveHarnessLayout(createHarnessRuntimeContext(target.canonicalRoot, input.layoutOverrides));
  const lockPath = path.join(layout.locksRoot, "global.lock");
  const lockStatus = readDaemonLock(lockPath);
  const rpcStatus = await readReachableDaemonStatus(target);
  const before = { ...lockStatus, ...rpcStatus };
  const daemonPid = typeof rpcStatus?.pid === "number" ? rpcStatus.pid : undefined;
  if (daemonPid !== undefined) {
    process.kill(daemonPid, "SIGTERM");
  }
  const stopped = daemonPid !== undefined ? await waitForEndpointStopped(target, timeoutMs) : true;
  emitDaemonResult("daemon-stop", {
    ...before,
    pid: daemonPid ?? null,
    signaled: daemonPid !== undefined,
    drained: stopped,
    stopped
  }, input.json);
  return stopped ? 0 : 1;
}

function installTemplates(input: DaemonCommandInput): number {
  const outDir = readOption(input.args, "--out");
  if (!outDir) throw new Error("Use ha daemon install-templates --out <directory>.");
  mkdirSync(outDir, { recursive: true });
  cpSync(daemonAssetPath("systemd/harness-anything-daemon.service"), path.join(outDir, "harness-anything-daemon.service"));
  cpSync(daemonAssetPath("launchd/com.harness-anything.daemon.plist"), path.join(outDir, "com.harness-anything.daemon.plist"));
  cpSync(daemonAssetPath("windows/install-harness-anything-daemon.ps1"), path.join(outDir, "install-harness-anything-daemon.ps1"));
  emitDaemonResult("daemon-install-templates", {
    outputDir: outDir,
    files: [
      "harness-anything-daemon.service",
      "com.harness-anything.daemon.plist",
      "install-harness-anything-daemon.ps1"
    ]
  }, input.json);
  return 0;
}

async function bootstrapServer(input: DaemonCommandInput): Promise<number> {
  const canonicalRoot = path.resolve(requiredOption(input.args, "--canonical-root"));
  const sshHost = requiredOption(input.args, "--ssh-host");
  const sshUser = readOption(input.args, "--ssh-user") ?? os.userInfo().username;
  const personId = readOption(input.args, "--person-id") ?? `person_${safeId(sshUser)}`;
  const displayName = readOption(input.args, "--display-name") ?? sshUser;
  const primaryEmail = readOption(input.args, "--email");
  const role = readOption(input.args, "--role") ?? "owner";
  const readonlyMirror = readOption(input.args, "--readonly-mirror");
  const reportPath = readOption(input.args, "--report") ?? path.join(canonicalRoot, ".harness", "generated", "daemon-bootstrap-report.json");
  const skipSshCheck = input.args.includes("--skip-ssh-check");
  const noStart = input.args.includes("--no-start");
  const registryRepoId = readOption(input.args, "--repo-id") ?? "canonical";

  ensureCanonicalRepo(canonicalRoot);
  initializeHarness({ rootDir: canonicalRoot }, false, path.basename(canonicalRoot));
  const registryUserRoot = readDaemonUserRootOption(input.args);
  const registry = registerDaemonRepo({
    ...(registryUserRoot ? { userRoot: registryUserRoot } : {}),
    canonicalRoot,
    repoId: registryRepoId
  });
  const layout = resolveHarnessLayout({ rootDir: canonicalRoot });
  const peoplePath = path.join(layout.authoredRoot, "people.yaml");
  ensurePeopleRoster(peoplePath, { personId, displayName, primaryEmail, role, sshUser, sshHost });
  installCanonicalPreReceiveHook(canonicalRoot);
  const mirrorReport = readonlyMirror ? ensureReadonlyMirror(canonicalRoot, path.resolve(readonlyMirror)) : undefined;
  const daemon = noStart
    ? { started: false, reason: "no-start" }
    : await startBootstrapDaemon(canonicalRoot, registry.repo.repoId, registry.registryPath);
  const ssh = skipSshCheck ? { checked: false, reason: "skip-ssh-check" } : await checkSshReachability(sshHost, sshUser, canonicalRoot);
  const report = {
    schema: "daemon-bootstrap-report/v1",
    canonicalRoot,
    peoplePath,
    daemon,
    registry: {
      path: registry.registryPath,
      repoId: registry.repo.repoId,
      changed: registry.changed,
      warnings: registry.warnings
    },
    ssh,
    gitHook: {
      path: path.join(canonicalRoot, ".git/hooks/pre-receive"),
      policy: "reject non-daemon direct push"
    },
    readonlyMirror: mirrorReport ?? null
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  emitDaemonResult("daemon-bootstrap-server", { reportPath, ...report }, input.json);
  return 0;
}

function ensureCanonicalRepo(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
  if (!existsSync(path.join(rootDir, ".git"))) runDaemonGit(rootDir, ["init"]);
}

function ensurePeopleRoster(filePath: string, input: {
  readonly personId: string;
  readonly displayName: string;
  readonly primaryEmail?: string;
  readonly role: string;
  readonly sshUser: string;
  readonly sshHost: string;
}): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const uid = process.getuid?.();
  writeFileSync(filePath, [
    "schema: harness-people/v1",
    "people:",
    `  - personId: ${input.personId}`,
    `    displayName: ${input.displayName}`,
    ...(input.primaryEmail ? [`    primaryEmail: ${input.primaryEmail}`] : []),
    `    roles: [${input.role}]`,
    "    credentials:",
    "      - kind: ssh-forced-command-person",
    `        issuer: host:${os.hostname()}`,
    `        subject: ${input.personId}`,
    ...(typeof uid === "number" ? [
      "      - kind: unix-socket-owner-boundary",
      `        issuer: host:${os.hostname()}`,
      `        subject: ${uid}`
    ] : []),
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    "  - roleId: observer",
    "    commandClasses: [repo-read]",
    "  - roleId: arbiter",
    "    commandClasses: [arbiter, repo-write, repo-read]",
    ""
  ].join("\n"), "utf8");
}

function installCanonicalPreReceiveHook(rootDir: string): void {
  const hookPath = path.join(rootDir, ".git/hooks/pre-receive");
  mkdirSync(path.dirname(hookPath), { recursive: true });
  const tokenDir = path.join(rootDir, ".harness/server");
  const tokenPath = path.join(tokenDir, "daemon-push-token");
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${randomBytes(24).toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  writeFileSync(hookPath, readFileSync(daemonAssetPath("git-hooks/pre-receive-daemon-only.sh"), "utf8"), { encoding: "utf8", mode: 0o755 });
  chmodSync(hookPath, 0o755);
}

function ensureReadonlyMirror(canonicalRoot: string, mirrorRoot: string): Record<string, unknown> {
  mkdirSync(path.dirname(mirrorRoot), { recursive: true });
  if (!existsSync(mirrorRoot)) {
    runDaemonGit(path.dirname(mirrorRoot), ["clone", "--mirror", canonicalRoot, mirrorRoot]);
  } else if (!existsSync(path.join(mirrorRoot, "HEAD"))) {
    throw new Error(`readonly mirror path exists but is not a bare git repository: ${mirrorRoot}`);
  } else {
    runDaemonGit(mirrorRoot, ["fetch", "--prune", canonicalRoot, "+refs/heads/*:refs/heads/*"]);
  }
  const hookPath = path.join(mirrorRoot, "hooks/pre-receive");
  writeFileSync(hookPath, readFileSync(daemonAssetPath("git-hooks/pre-receive-readonly-mirror.sh"), "utf8"), { encoding: "utf8", mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return { path: mirrorRoot, sync: "git fetch", hookPath };
}

async function startBootstrapDaemon(rootDir: string, repoId: string, registryPath: string): Promise<Record<string, unknown>> {
  const userRoot = path.dirname(registryPath);
  const target = resolveLocalDaemonTarget({
    rootDir,
    repoIdOverride: repoId,
    userRoot,
    autoRegisterSingleRepo: false
  });
  const child = spawn(process.execPath, [
    ...process.execArgv,
    productizationCliEntrypointPath(),
    "--root",
    rootDir,
    "daemon",
    "serve",
    "--repo",
    target.repoId,
    "--socket",
    target.socketPath,
    "--user-root",
    target.userRoot,
    "--idle-ms",
    "0"
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: target.userRoot, HARNESS_DAEMON_ID: target.daemonId }
  });
  child.unref();
  return waitForReachableStatus(target, 6_000);
}

async function checkSshReachability(host: string, user: string, canonicalRoot: string): Promise<Record<string, unknown>> {
  const target = host.includes("@") ? host : `${user}@${host}`;
  const child = spawn("ssh", [
    "-o",
    "BatchMode=yes",
    target,
    "test",
    "-d",
    canonicalRoot
  ], { stdio: "ignore" });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { checked: true, ok: exitCode === 0, target, exitCode };
}

function readDaemonLock(lockPath: string): Record<string, unknown> {
  if (!existsSync(lockPath)) return { started: false, lockPath };
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly pid?: unknown;
    readonly hostname?: unknown;
    readonly heartbeatAt?: unknown;
    readonly ownerKind?: unknown;
    readonly ownerToken?: unknown;
  };
  return {
    started: lock.ownerKind === "daemon",
    lockPath,
    pid: lock.pid,
    hostname: lock.hostname,
    heartbeatAt: lock.heartbeatAt,
    ownerKind: lock.ownerKind,
    ownerToken: lock.ownerToken
  };
}

async function readReachableDaemonStatus(target: LocalDaemonTarget): Promise<Record<string, unknown> | undefined> {
  try {
    const receipt = await requestLocalDaemonJsonRpc(target.canonicalRoot, "repo.daemon.status", { repo: { repoId: target.repoId } }, 1_000, {
      userRoot: target.userRoot,
      daemonId: target.daemonId,
      socketPath: target.socketPath,
      allowLegacySocket: true
    });
    const details = isDaemonRecord(receipt.details) ? receipt.details : {};
    const data = isDaemonRecord(details.data) ? details.data : undefined;
    return receipt.ok === true && data ? data : { rpcError: receipt };
  } catch {
    return undefined;
  }
}

async function waitForReachableStatus(target: LocalDaemonTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = await readReachableDaemonStatus(target);
    if (status) return status;
    await waitDaemonPollInterval(100);
  }
  throw new Error("daemon service did not become reachable before timeout");
}

async function waitForEndpointStopped(target: LocalDaemonTarget, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!await readReachableDaemonStatus(target)) return true;
    await waitDaemonPollInterval(100);
  }
  return !await readReachableDaemonStatus(target);
}

function emitDaemonResult(command: string, result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command, ...result }));
    return;
  }
  const parts = [`ok`, `command=${command}`];
  for (const key of ["started", "reachable", "mode", "queueDepth", "version", "protocolVersion", "pid", "rootDir", "repoId", "endpoint", "drained", "stopped", "reportPath", "outputDir"] as const) {
    if (result[key] !== undefined) parts.push(`${key}=${JSON.stringify(result[key])}`);
  }
  if (typeof result.lockPath === "string") parts.push(`lock=${result.lockPath}`);
  console.log(parts.join(" "));
}

function emitDaemonError(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, schema: "daemon-command/v1", command: "daemon", error: cliError(CliErrorCode.JournalUnavailable, message) }));
    return;
  }
  console.error(`error code=${CliErrorCode.JournalUnavailable} hint=${message}`);
}

function daemonRepoIdOverride(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID;
}

function readDaemonUserRootOption(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--user-root") ?? process.env.HARNESS_DAEMON_USER_ROOT;
}

function requiredOption(args: ReadonlyArray<string>, name: string): string {
  const value = readOption(args, name);
  if (!value || value.startsWith("--")) throw new Error(`Use ${name} <value>.`);
  return value;
}

function runDaemonGit(cwd: string, args: ReadonlyArray<string>): void {
  try {
    execFileSync("git", [...args], { cwd, stdio: "ignore", windowsHide: true });
  } catch {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

function productizationCliEntrypointPath(): string {
  const entrypointDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const found = ["index.js", "index.ts"]
    .map((filename) => path.join(entrypointDir, filename))
    .find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`CLI entrypoint not found in: ${entrypointDir}`);
  return realpathSync(found);
}

function daemonAssetPath(relativePath: string): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets", relativePath),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../daemon/assets", relativePath)
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`daemon asset not found: ${relativePath}`);
  return found;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "user";
}

function waitDaemonPollInterval(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDaemonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

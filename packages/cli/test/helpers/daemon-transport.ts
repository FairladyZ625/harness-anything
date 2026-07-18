import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultDaemonUserRoot,
  pollUntil
} from "./daemon-cli.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

export function spawnDaemonCli(rootDir: string, args: ReadonlyArray<string>) {
  return spawn(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    env: {
      ...process.env,
      HOME: path.join(rootDir, ".home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: defaultDaemonUserRoot(rootDir)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export function runDaemonCliProcess(
  rootDir: string,
  args: ReadonlyArray<string>,
  stdin = ""
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnDaemonCli(rootDir, args);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

export async function connectSocketWhenReady(endpoint: string, timeoutMs = 8_000): Promise<net.Socket> {
  return pollUntil(
    () => connectSocket(endpoint),
    (socket) => !socket.destroyed,
    (_socket, error) => JSON.stringify({ endpoint, error: error instanceof Error ? error.message : String(error ?? "") }),
    { timeoutMs }
  );
}

export async function stopSpawnedDaemon(
  child: ReturnType<typeof spawnDaemonCli>,
  endpoint: string
): Promise<void> {
  const ownerPath = process.platform === "win32"
    ? path.join(tmpdir(), `harness-anything-daemon-${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}.owner`)
    : `${endpoint}.owner`;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await pollUntil(
    () => ({
      exited: child.exitCode !== null || child.signalCode !== null || !processIsAlive(child.pid),
      socketExists: process.platform === "win32" ? false : exists(endpoint),
      ownerExists: exists(ownerPath)
    }),
    (state) => state.exited && !state.socketExists && !state.ownerExists,
    (state, error) => JSON.stringify({ pid: child.pid, endpoint, ownerPath, state, error: String(error ?? "") }),
    { timeoutMs: 8_000 }
  );
}

export function connectSocket(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

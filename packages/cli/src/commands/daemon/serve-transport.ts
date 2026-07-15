import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  createNamedPipeTransportServer,
  createUnixSocketTransportServer,
  ensurePrivateUnixSocketDirectory,
  type DaemonAuthenticationContext,
  type DaemonTransportConnection,
  type JsonRpcProtocolServer,
  type NamedPipeTransportServer,
  type SshForcedCommandBootstrapFrame,
  type UnixSocketTransportServer
} from "../../../../daemon/src/index.ts";

interface DaemonSocketOwnerRecord {
  readonly schema: "daemon-socket-owner/v1";
  readonly pid: number;
  readonly ownerToken: string;
}

export interface DaemonSocketOwnership {
  readonly release: () => void;
}

export class DaemonSocketAlreadyOwnedError extends Error {
  constructor(endpoint: string, ownerPid?: number) {
    super(`daemon socket ${endpoint} is already owned${ownerPid === undefined ? "" : ` by pid ${ownerPid}`}`);
    this.name = "DaemonSocketAlreadyOwnedError";
  }
}

export interface DaemonLocalTransportOptions {
  readonly daemonId: string;
  readonly endpoint: string;
  readonly platform?: NodeJS.Platform;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly acceptSshForcedCommand: (frame: SshForcedCommandBootstrapFrame) => boolean;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
}

export function createDaemonLocalTransport(
  options: DaemonLocalTransportOptions
): UnixSocketTransportServer | NamedPipeTransportServer {
  if ((options.platform ?? process.platform) === "win32") {
    return createNamedPipeTransportServer({
      daemonId: options.daemonId,
      pipePath: options.endpoint,
      acceptSshForcedCommand: options.acceptSshForcedCommand,
      createProtocolServer: options.createProtocolServer,
      onConnection: options.onConnection,
      onConnectionClosed: options.onConnectionClosed
    });
  }
  return createUnixSocketTransportServer({
    daemonId: options.daemonId,
    socketPath: options.endpoint,
    acceptSshForcedCommand: options.acceptSshForcedCommand,
    createProtocolServer: options.createProtocolServer,
    onConnection: options.onConnection,
    onConnectionClosed: options.onConnectionClosed
  });
}

export async function acquireDaemonSocketOwnership(
  endpoint: string,
  platform: NodeJS.Platform = process.platform
): Promise<DaemonSocketOwnership> {
  if (platform === "win32") return { release: () => undefined };

  ensurePrivateUnixSocketDirectory(path.dirname(endpoint));
  const lockPath = `${endpoint}.owner`;
  return acquireUnixSocketOwnership(endpoint, lockPath);
}

export async function withDaemonSocketOwnership<Result>(
  endpoint: string,
  run: () => Promise<Result>
): Promise<Result> {
  const ownership = await acquireDaemonSocketOwnership(endpoint);
  try {
    return await run();
  } finally {
    ownership.release();
  }
}

async function acquireUnixSocketOwnership(endpoint: string, lockPath: string): Promise<DaemonSocketOwnership> {
  const ownerToken = randomUUID();
  const record = {
    schema: "daemon-socket-owner/v1",
    pid: process.pid,
    ownerToken
  } satisfies DaemonSocketOwnerRecord;

  try {
    createOwnerLock(lockPath, record);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const existing = readOwnerLock(lockPath);
    if (!existing) throw new DaemonSocketAlreadyOwnedError(endpoint);
    if (processIsAlive(existing.pid)) {
      const state = await waitForSocketOwner(endpoint, lockPath, existing);
      if (state === "reachable") throw new DaemonSocketAlreadyOwnedError(endpoint, existing.pid);
      return acquireUnixSocketOwnership(endpoint, lockPath);
    }
    quarantineStaleOwnerLock(lockPath, existing, ownerToken);
    try {
      createOwnerLock(lockPath, record);
    } catch (retryError) {
      if (isAlreadyExistsError(retryError)) {
        throw new DaemonSocketAlreadyOwnedError(endpoint, readOwnerLock(lockPath)?.pid);
      }
      throw retryError;
    }
  }

  return {
    release: () => {
      const current = readOwnerLock(lockPath);
      if (current?.ownerToken === ownerToken) rmSync(lockPath, { force: true });
    }
  };
}

function waitForSocketOwner(
  endpoint: string,
  lockPath: string,
  expected: DaemonSocketOwnerRecord
): Promise<"reachable" | "released"> {
  return new Promise((resolve, reject) => {
    let inspecting = false;
    let settled = false;
    const ownershipTimer = setInterval(() => {
      void inspect();
    }, 25);
    void inspect();

    async function inspect(): Promise<void> {
      if (settled || inspecting) return;
      inspecting = true;
      try {
        const current = readOwnerLock(lockPath);
        if ((!current && !existsSync(lockPath)) || (current && current.ownerToken !== expected.ownerToken) || !processIsAlive(expected.pid)) {
          finish("released");
          return;
        }
        if (await endpointIsReachable(endpoint)) finish("reachable");
      } catch (error) {
        fail(error);
      } finally {
        inspecting = false;
      }
    }

    function finish(state: "reachable" | "released"): void {
      if (settled) return;
      settled = true;
      clearInterval(ownershipTimer);
      resolve(state);
    }

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      clearInterval(ownershipTimer);
      reject(error);
    }
  });
}

function endpointIsReachable(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function createOwnerLock(lockPath: string, record: DaemonSocketOwnerRecord): void {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readOwnerLock(lockPath: string): DaemonSocketOwnerRecord | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<DaemonSocketOwnerRecord>;
    if (
      record.schema === "daemon-socket-owner/v1"
      && typeof record.pid === "number"
      && Number.isSafeInteger(record.pid)
      && record.pid > 0
      && typeof record.ownerToken === "string"
      && record.ownerToken.length > 0
    ) {
      return record as DaemonSocketOwnerRecord;
    }
  } catch {
    // A concurrently starting owner may not have finished its durable write.
  }
  return undefined;
}

function quarantineStaleOwnerLock(
  lockPath: string,
  expected: DaemonSocketOwnerRecord,
  contenderToken: string
): void {
  const quarantinePath = `${lockPath}.stale.${expected.ownerToken}.${contenderToken}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (isNoSuchFileError(error)) return;
    throw error;
  }
  const quarantined = readOwnerLock(quarantinePath);
  if (quarantined?.ownerToken !== expected.ownerToken || processIsAlive(quarantined.pid)) {
    try {
      renameSync(quarantinePath, lockPath);
    } catch {
      // Another contender already established the authoritative owner lock.
    }
    throw new DaemonSocketAlreadyOwnedError(lockPath, quarantined?.pid);
  }
  rmSync(quarantinePath, { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNoSuchFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isNoSuchProcessError(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

import { existsSync, lstatSync, readFileSync, rmdirSync } from "node:fs";

export function daemonSocketConnectError(socketPath: string, cause: unknown): unknown {
  const shape = daemonSocketPathShape(socketPath);
  if (shape !== "directory" && socketErrorCode(cause) !== "EINVAL") return cause;
  const ownership = daemonSocketDirectoryOwnership(socketPath);
  let cleanup = "not-attempted";
  if (shape === "directory" && ownership === "unowned") {
    try {
      rmdirSync(socketPath);
      cleanup = "removed-empty-directory";
    } catch (error) {
      cleanup = socketErrorCode(error) === "ENOTEMPTY"
        ? "preserved-non-empty-directory"
        : `failed:${String(socketErrorCode(error) ?? "unknown")}`;
    }
  }
  return new Error(
    `DAEMON_SOCKET_NAMESPACE_INVALID:path=${socketPath};shape=${shape};owner=${ownership};cleanup=${cleanup};connectCode=${String(socketErrorCode(cause) ?? "unknown")}`,
    { cause }
  );
}

function daemonSocketPathShape(socketPath: string): "missing" | "socket" | "directory" | "symbolic-link" | "other" | "unreadable" {
  try {
    const stat = lstatSync(socketPath);
    if (stat.isSymbolicLink()) return "symbolic-link";
    if (stat.isSocket()) return "socket";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    return socketErrorCode(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

function daemonSocketDirectoryOwnership(socketPath: string): string {
  const ownerPath = `${socketPath}.owner`;
  if (!existsSync(ownerPath)) return "unowned";
  try {
    const record = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    if (record.schema !== "daemon-socket-owner/v1"
      || !Number.isSafeInteger(record.pid)
      || Number(record.pid) < 1
      || typeof record.ownerToken !== "string"
      || record.ownerToken.length === 0) {
      return "indeterminate-owner-record";
    }
    const pid = Number(record.pid);
    return daemonOwnerProcessIsAlive(pid) ? `live-pid-${pid}` : "unowned";
  } catch {
    return "indeterminate-owner-record";
  }
}

function daemonOwnerProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return socketErrorCode(error) !== "ESRCH";
  }
}

function socketErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

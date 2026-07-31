import { RepoWriteProtocolDecodeError } from "./repo-write-protocol-scalars.ts";

export function invalidRepoWriteProtocol(path: string, expected: string): never {
  throw new RepoWriteProtocolDecodeError(
    "REPO_WRITE_PROTOCOL_INVALID",
    `Invalid repo writer IPC at ${boundedProtocolPath(path)}: expected ${expected}.`
  );
}

export function limitRepoWriteProtocol(
  path: string,
  boundary: string,
  actual?: number,
  maximum?: number
): never {
  throw new RepoWriteProtocolDecodeError(
    "REPO_WRITE_PROTOCOL_LIMIT",
    `Repo writer IPC limit exceeded at ${boundedProtocolPath(path)}: ${boundary}.`,
    actual === undefined || maximum === undefined
      ? undefined
      : { path: boundedProtocolPath(path), boundary, actual, maximum }
  );
}

function boundedProtocolPath(path: string): string {
  return path.length <= 160 ? path : `${path.slice(0, 157)}...`;
}

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseDelegatedExecutionToken,
  stableStringify,
  type ExecutionDelegationRecord,
} from "@harness-anything/kernel";
import { writeFileDurably } from "./durable-file.ts";
import type { RuntimeDaemonRoute } from "./runtime-spawn.ts";

interface DelegationState {
  readonly schema: "execution-delegations/v1";
  readonly repoId: string;
  readonly records: readonly ExecutionDelegationRecord[];
  readonly operations: Readonly<Record<string, { readonly fingerprint: string; readonly tokenId: string }>>;
}

/** A center repository writer owns this file; callers must hold its publication turn. */
export function executionDelegationPath(route: RuntimeDaemonRoute, repoId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repoId)) throw new Error("Invalid delegation repository id");
  return path.join(path.resolve(route.userRoot), "execution-delegations", `${repoId}.json`);
}

export function readExecutionDelegations(file: string, repoId: string): DelegationState {
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schema: "execution-delegations/v1", repoId, records: [], operations: {} };
    throw error;
  }
  const state = JSON.parse(body) as DelegationState;
  if (
    state.schema !== "execution-delegations/v1" ||
    state.repoId !== repoId ||
    !Array.isArray(state.records) ||
    !state.operations ||
    typeof state.operations !== "object"
  )
    throw new Error("Invalid repository execution delegation state");
  for (const record of state.records) {
    if (
      record.repoId !== repoId ||
      typeof record.issuedByOperationId !== "string" ||
      !record.issuedByOperationId ||
      (record.source !== "local" &&
        (typeof record.source !== "object" ||
          record.source.kind !== "assignment" ||
          !record.source.nodeId ||
          !record.source.assignmentId))
    )
      throw new Error("Invalid execution delegation source");
    parseDelegatedExecutionToken(record.token);
  }
  if (new Set(state.records.map((record) => record.token.tokenId)).size !== state.records.length)
    throw new Error("Duplicate execution delegation id");
  return state;
}

export function writeExecutionDelegation(input: {
  readonly file: string;
  readonly state: DelegationState;
  readonly record: ExecutionDelegationRecord;
  readonly opId: string;
  readonly fingerprint: string;
}): void {
  const records = input.state.records.filter((record) => record.token.tokenId !== input.record.token.tokenId);
  records.push(input.record);
  writeFileDurably(
    input.file,
    stableStringify({
      ...input.state,
      records,
      operations: {
        ...input.state.operations,
        [input.opId]: {
          fingerprint: input.fingerprint,
          tokenId: input.record.token.tokenId,
        },
      },
    }) + "\n",
    0o600,
  );
}

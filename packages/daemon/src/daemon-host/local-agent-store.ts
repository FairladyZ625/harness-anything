import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  consumeKnownError,
  entitySlug,
  parseAgentDeclarationV1,
  type AgentDeclarationV1,
  type LocalAgentRecordV1,
  type LocalAgentStorePort,
  type LocalAgentTransferIntent,
  type LocalAgentWriteOptions,
} from "@harness-anything/kernel";

export type LocalAgentRecord = LocalAgentRecordV1;

class LocalAgentStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function parsePendingTransfer(value: unknown): LocalAgentTransferIntent | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Local Agent pendingTransfer must be a JSON object.");
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.direction !== "share" && candidate.direction !== "unshare") ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.trim().length === 0 ||
    !Number.isSafeInteger(candidate.sourceRevision) ||
    Number(candidate.sourceRevision) < 0 ||
    (candidate.targetScope !== "local" && candidate.targetScope !== "shared") ||
    typeof candidate.declarationSha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.declarationSha256)
  )
    throw new Error("Local Agent pendingTransfer has an invalid shape.");
  return {
    direction: candidate.direction,
    operationId: candidate.operationId,
    sourceRevision: Number(candidate.sourceRevision),
    targetScope: candidate.targetScope,
    declarationSha256: candidate.declarationSha256,
  };
}

export function readLocalAgentDeclarations(userRoot: string, repoId: string): readonly AgentDeclarationV1[] {
  return readLocalAgentRecords(userRoot, repoId).map(({ declaration }) => declaration);
}

export function readLocalAgentRecords(userRoot: string, repoId: string): readonly LocalAgentRecord[] {
  const directory = localAgentDirectory(userRoot, repoId);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consumeKnownError(error);
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readLocalAgentRecord(userRoot, repoId, entry.name.slice(0, -5)))
    .filter((record): record is LocalAgentRecord => record?.declaration.scope === "local");
}

export function readLocalAgentDeclaration(
  userRoot: string,
  repoId: string,
  agentId: string,
): AgentDeclarationV1 | null {
  return readLocalAgentRecord(userRoot, repoId, agentId)?.declaration ?? null;
}

export function readLocalAgentRecord(userRoot: string, repoId: string, agentId: string): LocalAgentRecord | null {
  if (!entitySlug(agentId)) return null;
  try {
    const directory = localAgentDirectory(userRoot, repoId);
    const value = JSON.parse(readFileSync(path.join(directory, `${agentId}.json`), "utf8"));
    if (
      value?.schema !== "local-agent-record/v1" ||
      value.id !== agentId ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new Error(`Local Agent ${agentId} has an invalid storage record.`);
    const declaration = parseAgentDeclarationV1(value.declaration),
      pendingTransfer = parsePendingTransfer(value.pendingTransfer);
    return declaration.scope === "local"
      ? {
          schema: "local-agent-record/v1",
          id: agentId,
          declaration,
          revision: value.revision,
          ...(pendingTransfer ? { pendingTransfer } : {}),
        }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consumeKnownError(error);
      return null;
    }
    throw error;
  }
}

export function writeLocalAgentDeclaration(
  userRoot: string,
  repoId: string,
  declaration: AgentDeclarationV1,
  expectedVersionOrOptions?: number | LocalAgentWriteOptions,
): number {
  if (!entitySlug(declaration.id)) throw new Error("Local Agent id must be a lowercase slug.");
  if (declaration.scope !== "local") throw new Error("Only local Agent declarations can be written to local storage.");
  const options: LocalAgentWriteOptions =
    typeof expectedVersionOrOptions === "number"
      ? { expectedVersion: expectedVersionOrOptions }
      : (expectedVersionOrOptions ?? {});
  const directory = localAgentDirectory(userRoot, repoId),
    destination = path.join(directory, `${declaration.id}.json`),
    temporary = `${destination}.${randomUUID()}.tmp`;
  /* @gate-identity state-store/agent.local-declarations */ mkdirSync(directory, { recursive: true });
  if (lstatSync(path.dirname(directory)).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
    throw new Error("Local Agent storage cannot traverse symbolic links.");
  const current = readLocalAgentRecord(userRoot, repoId, declaration.id),
    revision = current?.revision ?? 0;
  if (options.expectedVersion !== undefined && options.expectedVersion !== revision)
    throw new LocalAgentStoreError(
      "revision_conflict",
      `Local Agent ${declaration.id} expected revision ${options.expectedVersion}, current revision is ${revision}.`,
    );
  const nextRevision = options.preserveRevision === true && revision >= 1 ? revision : revision + 1,
    pendingTransfer =
      options.pendingTransfer === null
        ? undefined
        : options.pendingTransfer !== undefined
          ? options.pendingTransfer
          : current?.pendingTransfer;
  const record: LocalAgentRecordV1 = {
    schema: "local-agent-record/v1",
    id: declaration.id,
    revision: nextRevision,
    declaration,
    ...(pendingTransfer ? { pendingTransfer } : {}),
  };
  /* @gate-identity state-store/agent.local-declarations */ writeFileSync(
    temporary,
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  /* @gate-identity state-store/agent.local-declarations */ renameSync(temporary, destination);
  return nextRevision;
}

export function removeLocalAgentDeclaration(
  userRoot: string,
  repoId: string,
  agentId: string,
  options?: { readonly expectedVersion?: number },
): boolean {
  if (!entitySlug(agentId)) throw new Error("Local Agent id must be a lowercase slug.");
  const directory = localAgentDirectory(userRoot, repoId),
    target = path.join(directory, `${agentId}.json`);
  if (
    lstatSync(path.dirname(directory), { throwIfNoEntry: false })?.isSymbolicLink() ||
    lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw new Error("Local Agent storage cannot traverse a symbolic link.");
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Local Agent storage cannot remove a symbolic link.");
  const current = readLocalAgentRecord(userRoot, repoId, agentId);
  if (options?.expectedVersion !== undefined) {
    const revision = current?.revision ?? 0;
    if (revision !== options.expectedVersion)
      throw new LocalAgentStoreError(
        "revision_conflict",
        `Local Agent ${agentId} expected revision ${options.expectedVersion}, current revision is ${revision}.`,
      );
  }
  if (current === null) return false;
  /* @gate-identity state-store/agent.local-declarations */ rmSync(target, { force: true });
  return true;
}

/** Thin host adapter implementing Kernel's `LocalAgentStorePort` over per-repo user-state files. */
export function createLocalAgentStorePort(userRoot: string, repoId: string): LocalAgentStorePort {
  return {
    list: () => readLocalAgentRecords(userRoot, repoId),
    get: (agentId) => readLocalAgentRecord(userRoot, repoId, agentId),
    write: (declaration, options) => writeLocalAgentDeclaration(userRoot, repoId, declaration, options),
    remove: (agentId, options) => removeLocalAgentDeclaration(userRoot, repoId, agentId, options),
  };
}

function localAgentDirectory(userRoot: string, repoId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(repoId)) throw new Error("Repository id cannot name a local Agent directory.");
  const root = path.join(userRoot, "local-agents"),
    directory = path.join(root, repoId);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Local Agent storage cannot traverse a symbolic link.");
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Local Agent storage cannot traverse a symbolic link.");
  return directory;
}

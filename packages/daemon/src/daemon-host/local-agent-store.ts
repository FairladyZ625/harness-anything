import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  consumeKnownError,
  parseAgentDeclarationV1,
  entitySlug,
  type AgentDeclarationV1,
} from "@harness-anything/kernel";

export interface LocalAgentRecord {
  readonly declaration: AgentDeclarationV1;
  readonly revision: number;
}

export function readLocalAgentDeclarations(userRoot: string, repoId: string): readonly AgentDeclarationV1[] {
  return readLocalAgentRecords(userRoot, repoId).map(({ declaration }) => declaration);
}

export function readLocalAgentRecords(userRoot: string, repoId: string): readonly LocalAgentRecord[] {
  const directory = localAgentDirectory(userRoot, repoId);
  assertLocalAgentDirectory(directory);
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

export function readLocalAgentRecord(
  userRoot: string,
  repoId: string,
  agentId: string,
): { readonly declaration: AgentDeclarationV1; readonly revision: number } | null {
  if (!entitySlug(agentId)) return null;
  try {
    const directory = localAgentDirectory(userRoot, repoId);
    assertLocalAgentDirectory(directory);
    const value = JSON.parse(readFileSync(path.join(directory, `${agentId}.json`), "utf8"));
    if (
      value?.schema !== "local-agent-record/v1" ||
      value.id !== agentId ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new Error(`Local Agent ${agentId} has an invalid storage record.`);
    const declaration = parseAgentDeclarationV1(value.declaration);
    return declaration.scope === "local" ? { declaration, revision: value.revision } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consumeKnownError(error);
      return null;
    }
    throw error;
  }
}

export function localAgentMatchesShared(local: AgentDeclarationV1, sharedValue: unknown): boolean {
  if (typeof sharedValue !== "object" || sharedValue === null || Array.isArray(sharedValue)) return false;
  const {
    lifecycleState: _lifecycleState,
    retirement: _retirement,
    ...sharedDeclaration
  } = sharedValue as Record<string, unknown>;
  return isDeepStrictEqual(
    parseAgentDeclarationV1({ ...local, scope: "shared" }),
    parseAgentDeclarationV1(sharedDeclaration),
  );
}

export function writeLocalAgentDeclaration(
  userRoot: string,
  repoId: string,
  declaration: AgentDeclarationV1,
  expectedVersion?: number,
): number {
  if (!entitySlug(declaration.id)) throw new Error("Local Agent id must be a lowercase slug.");
  if (declaration.scope !== "local") throw new Error("Only local Agent declarations can be written to local storage.");
  const directory = localAgentDirectory(userRoot, repoId),
    destination = path.join(directory, `${declaration.id}.json`),
    temporary = `${destination}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  if (lstatSync(path.dirname(directory)).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
    throw new Error("Local Agent storage cannot traverse symbolic links.");
  const current = readLocalAgentRecord(userRoot, repoId, declaration.id),
    revision = current?.revision ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== revision)
    throw Object.assign(
      new Error(`Local Agent ${declaration.id} expected revision ${expectedVersion}, current revision is ${revision}.`),
      { code: "revision_conflict" },
    );
  const nextRevision = revision + 1;
  writeFileSync(
    temporary,
    `${JSON.stringify({ schema: "local-agent-record/v1", id: declaration.id, revision: nextRevision, declaration }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temporary, destination);
  return nextRevision;
}

export function removeLocalAgentDeclaration(userRoot: string, repoId: string, agentId: string): void {
  if (!entitySlug(agentId)) throw new Error("Local Agent id must be a lowercase slug.");
  const target = path.join(localAgentDirectory(userRoot, repoId), `${agentId}.json`);
  assertLocalAgentDirectory(path.dirname(target));
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Local Agent storage cannot remove a symbolic link.");
  rmSync(target, { force: true });
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

function assertLocalAgentDirectory(directory: string): void {
  const parent = path.dirname(directory),
    parentStat = lstatSync(parent, { throwIfNoEntry: false }),
    directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (parentStat?.isSymbolicLink() || directoryStat?.isSymbolicLink())
    throw new Error("Local Agent storage cannot traverse a symbolic link.");
}

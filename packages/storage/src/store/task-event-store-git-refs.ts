import {
  localGitObjectRefStore as gitObjects,
  localGitObjectRefStoreAsync as gitObjectsAsync,
} from "./local-version-control-system.ts";
import type { PublicationFile } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { EventPublicationKillpoint } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { LedgerCutIdentity } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";

/** Advances the durable follower checkpoint with the authored ref, or reuses its certified cut. */
export function publishFollowerCut(
  repoRoot: string,
  authoredRef: string,
  parent: string,
  checkpoint: number,
  cut: LedgerCutIdentity,
  files: readonly PublicationFile[],
  options: {
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly withFence?: <T>(operation: () => T) => T;
  } = {},
): string {
  if (checkpoint >= cut.revision) return parent;
  const temporaryRef = `refs/ha-sqlite-outbox/${cut.headDigest.slice(7)}`,
    commit = prepareCommit(repoRoot, temporaryRef, parent, files, `outbox-${cut.revision}`, new Date().toISOString());
  options.killpoint?.("after_git_commit");
  // The fence protects the authoritative ref/checkpoint, not slow object import or worktree I/O.
  const advance = () => finalizeRefs(repoRoot, authoredRef, commit, parent, temporaryRef);
  if (options.withFence) options.withFence(advance);
  else advance();
  options.killpoint?.("after_git_ref_update");
  return commit;
}

/** Asynchronous variant for detached follower loops: keeps slow Git subprocesses off the orchestration loop. */
export async function publishFollowerCutAsync(
  repoRoot: string,
  authoredRef: string,
  parent: string,
  checkpoint: number,
  cut: LedgerCutIdentity,
  files: readonly PublicationFile[],
  options: {
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly finalizeRefs?: (input: {
      readonly repoRoot: string;
      readonly authoredRef: string;
      readonly commit: string;
      readonly previous: string;
      readonly temporaryRef: string;
    }) => Promise<void>;
  } = {},
): Promise<string> {
  if (checkpoint >= cut.revision) return parent;
  const temporaryRef = `refs/ha-sqlite-outbox/${cut.headDigest.slice(7)}`,
    commit = await prepareCommitAsync(
      repoRoot,
      temporaryRef,
      parent,
      files,
      `outbox-${cut.revision}`,
      new Date().toISOString(),
    );
  options.killpoint?.("after_git_commit");
  if (options.finalizeRefs)
    await options.finalizeRefs({ repoRoot, authoredRef, commit, previous: parent, temporaryRef });
  else await finalizeRefsAsync(repoRoot, authoredRef, commit, parent, temporaryRef);
  options.killpoint?.("after_git_ref_update");
  return commit;
}

function* buildFastImportInput(
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): Generator<string | Uint8Array> {
  const message = `harness sqlite outbox ${opId}`,
    timestamp = Math.floor(Date.parse(occurredAt) / 1_000);
  yield [
    `commit ${ref}\n`,
    "mark :1\n",
    `committer Harness SQLite Outbox <harness-sqlite-outbox@local.invalid> ${timestamp} +0000\n`,
    `data ${Buffer.byteLength(message)}\n`,
    `${message}\n`,
    `from ${parent}\n`,
  ].join("");
  for (const file of files) {
    if ("from" in file) yield `R ${file.from} ${file.to}\n`;
    else if ("delete" in file) yield `D ${file.delete}\n`;
    else {
      yield `M ${file.mode} inline ${file.target}\ndata ${Buffer.byteLength(file.body)}\n`;
      yield file.body;
      yield "\n";
    }
  }
  yield "\nget-mark :1\ndone\n";
}

function parseImportCommitSha(output: Buffer): string {
  const sha = output.toString("utf8").trim().split("\n").at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Git outbox import returned no commit");
  return sha;
}

export function prepareCommit(
  repoRoot: string,
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): string {
  return parseImportCommitSha(
    gitObjects.importCommit(repoRoot, buildFastImportInput(ref, parent, files, opId, occurredAt)),
  );
}

export async function prepareCommitAsync(
  repoRoot: string,
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): Promise<string> {
  return parseImportCommitSha(
    await gitObjectsAsync.importCommit(repoRoot, buildFastImportInput(ref, parent, files, opId, occurredAt)),
  );
}

function updateRefsPayload(authoredRef: string, commit: string, previous: string, temporaryRef: string): string {
  return `start\nupdate ${authoredRef} ${commit} ${previous}\ndelete ${temporaryRef} ${commit}\nprepare\ncommit\n`;
}

export function finalizeRefs(
  repoRoot: string,
  authoredRef: string,
  commit: string,
  previous: string,
  temporaryRef: string,
): void {
  gitObjects.updateRefs(repoRoot, updateRefsPayload(authoredRef, commit, previous, temporaryRef));
}

export async function finalizeRefsAsync(
  repoRoot: string,
  authoredRef: string,
  commit: string,
  previous: string,
  temporaryRef: string,
): Promise<void> {
  await gitObjectsAsync.updateRefs(repoRoot, updateRefsPayload(authoredRef, commit, previous, temporaryRef));
}

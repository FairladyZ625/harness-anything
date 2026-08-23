import { sha256Text } from "../integrity/stable-hash.ts";
import { localGitObjectRefStore as gitObjects } from "./local-version-control-system.ts";
import type { PublicationFile } from "./task-event-store-types.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";
import { messageOf } from "./task-event-store-materialization.ts";

// Temporary publication refs, atomic ref updates, and branch safety checks.
export function publicationRef(opId: string): string {
  return `refs/ha-event-prepared/${sha256Text(opId)}`;
}
export function prepareCommit(
  repoRoot: string,
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): string {
  const message = `harness event ${opId}`,
    timestamp = Math.floor(Date.parse(occurredAt) / 1_000);
  let input = [
    `commit ${ref}\n`,
    "mark :1\n",
    `committer Harness Event Store <harness-event-store@local.invalid> ${timestamp} +0000\n`,
    `data ${Buffer.byteLength(message)}\n`,
    `${message}\n`,
    `from ${parent}\n`,
  ].join("");
  for (const file of files)
    input +=
      "from" in file
        ? `R ${file.from} ${file.to}\n`
        : "delete" in file
          ? `D ${file.delete}\n`
          : `M ${file.mode} inline ${file.target}\ndata ${Buffer.byteLength(file.body)}\n${file.body}\n`;
  input += "\nget-mark :1\ndone\n";
  let output: Buffer;
  try {
    output = gitObjects.importCommit(repoRoot, input);
  } catch (error) {
    throw new TaskEventStoreError("publication_indeterminate", `Git object import failed: ${messageOf(error)}`);
  }
  const sha = output.toString("utf8").trim().split("\n").at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(sha))
    throw new TaskEventStoreError("publication_indeterminate", "Git object import returned no commit");
  return sha;
}
export function preparedRefs(repoRoot: string): readonly (readonly [string, string])[] {
  return parseRefs(gitObjects.listRefs(repoRoot, ["refs/ha-event-prepared/"]));
}
export function publicationRefs(
  repoRoot: string,
  authoredRef: string,
): {
  readonly canonical: string | null;
  readonly authored: string | null;
  readonly prepared: readonly (readonly [string, string])[];
} {
  const refs = parseRefs(gitObjects.listRefs(repoRoot, [CANONICAL_EVENT_REF, authoredRef, "refs/ha-event-prepared/"])),
    find = (name: string) => refs.find(([ref]) => ref === name)?.[1] ?? null;
  return {
    canonical: find(CANONICAL_EVENT_REF),
    authored: find(authoredRef),
    prepared: refs.filter(([ref]) => ref.startsWith("refs/ha-event-prepared/")),
  };
}
export function parseRefs(body: string): readonly (readonly [string, string])[] {
  return body.trim()
    ? body
        .trim()
        .split(/\r?\n/u)
        .map((line) => line.split(" ") as [string, string])
    : [];
}
export function updateRef(repoRoot: string, ref: string, sha: string, previous?: string): void {
  gitObjects.updateRef(repoRoot, ref, sha, previous);
}
export function finalizeRefs(
  repoRoot: string,
  authoredRef: string,
  sha: string,
  previous: string,
  prepared?: readonly [string, string],
): void {
  gitObjects.updateRefs(
    repoRoot,
    [
      "start\n",
      `update ${CANONICAL_EVENT_REF} ${sha} ${previous}\n`,
      `update ${authoredRef} ${sha} ${previous}\n`,
      prepared ? `delete ${prepared[0]} ${prepared[1]}\n` : "",
      "prepare\ncommit\n",
    ].join(""),
  );
}
export function deleteRef(repoRoot: string, ref: string): void {
  gitObjects.deleteRef(repoRoot, ref);
}
export function assertPublicationCut(repoRoot: string, authoredRef: string, canonical: string): void {
  let refs: ReturnType<typeof publicationRefs>;
  try {
    refs = publicationRefs(repoRoot, authoredRef);
  } catch {
    throw new TaskEventStoreError(
      "publication_indeterminate",
      "authored and canonical refs cannot be resolved; reconcile before publishing",
    );
  }
  if (refs.authored !== canonical || refs.canonical !== canonical)
    throw new TaskEventStoreError(
      "publication_indeterminate",
      [
        `ledger ${authoredRef} must point at the last published event commit ${canonical},`,
        "but a commit was made outside the daemon. Recover with:",
        `git -C ${repoRoot} update-ref ${authoredRef} ${canonical} — this moves only the branch pointer`,
        "and leaves every file in place. Then run ha daemon stop and retry.",
      ].join(" "),
    );
}
export function currentBranch(repoRoot: string): string {
  const branch = gitObjects.currentBranch(repoRoot);
  if (branch) return branch;
  throw new TaskEventStoreError(
    "publication_indeterminate",
    "authored branch is detached; register a default branch before publishing",
  );
}

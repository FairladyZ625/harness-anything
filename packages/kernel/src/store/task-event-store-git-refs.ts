import { localGitObjectRefStore as gitObjects } from "./local-version-control-system.ts";
import type { PublicationFile } from "./task-event-store-types.ts";

export function prepareCommit(
  repoRoot: string,
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): string {
  const message = `harness sqlite outbox ${opId}`,
    timestamp = Math.floor(Date.parse(occurredAt) / 1_000);
  let input = [
    `commit ${ref}\n`,
    "mark :1\n",
    `committer Harness SQLite Outbox <harness-sqlite-outbox@local.invalid> ${timestamp} +0000\n`,
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
  const sha = gitObjects.importCommit(repoRoot, input).toString("utf8").trim().split("\n").at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Git outbox import returned no commit");
  return sha;
}

export function finalizeRefs(
  repoRoot: string,
  authoredRef: string,
  commit: string,
  previous: string,
  temporaryRef: string,
): void {
  gitObjects.updateRefs(
    repoRoot,
    `start\nupdate ${authoredRef} ${commit} ${previous}\ndelete ${temporaryRef} ${commit}\nprepare\ncommit\n`,
  );
}

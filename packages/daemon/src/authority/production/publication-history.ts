import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAuthorityBatchCommitMessage } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);
const subjectBatchSize = 256;

export interface FirstParentPublicationMetadata {
  readonly commitSha: string;
  readonly parents: ReadonlyArray<string>;
  readonly treeSha: string;
  readonly subject: string;
  readonly message: string;
  readonly sessionSubject?: string;
  readonly sessionParents?: ReadonlyArray<string>;
  readonly sessionTreeSha?: string;
  readonly sessionMessage?: string;
}

export interface AuthorityBatchCommitMetadata {
  readonly commitSha: string;
  readonly opIds: ReadonlyArray<string>;
}

export function publicationSubjectOperationIds(subject: string): ReadonlyArray<string> {
  const match = /\[([^\]]+)\]$/u.exec(subject);
  return match?.[1] ? match[1].split(",").filter(Boolean) : [];
}

export async function scanFirstParentPublicationMetadata(input: {
  readonly rootDir: string;
  readonly headCommit: string;
  readonly exclusiveCommit?: string;
}): Promise<ReadonlyArray<FirstParentPublicationMetadata>> {
  const revision = input.exclusiveCommit
    ? `${input.exclusiveCommit}..${input.headCommit}`
    : input.headCommit;
  const history = parseCommitRows(await publicationHistoryGitText(
    input.rootDir,
    "log",
    "--first-parent",
    "--format=%H%x00%P%x00%T%x00%s%x00%B%x00",
    revision
  )).map(([commitSha, parents, treeSha, subject, message]) => ({
    commitSha,
    parents: parents.split(" ").filter(Boolean),
    treeSha,
    subject,
    message
  }));
  const sessionCommits = [...new Set(history
    .filter((row) =>
      row.parents.length === 2
      && (row.subject.startsWith("materializer: merge session ")
        || publicationSubjectOperationIds(row.subject).length > 0))
    .map((row) => row.parents[1]!))];
  const sessions = new Map<string, {
    readonly parents: ReadonlyArray<string>;
    readonly treeSha: string;
    readonly subject: string;
    readonly message: string;
  }>();
  for (let start = 0; start < sessionCommits.length; start += subjectBatchSize) {
    const batch = sessionCommits.slice(start, start + subjectBatchSize);
    for (const [commitSha, parents, treeSha, subject, message] of parseCommitRows(await publicationHistoryGitText(
      input.rootDir,
      "log",
      "--no-walk=unsorted",
      "--format=%H%x00%P%x00%T%x00%s%x00%B%x00",
      ...batch
    ))) {
      sessions.set(commitSha, {
        parents: parents.split(" ").filter(Boolean),
        treeSha,
        subject,
        message
      });
    }
  }
  return history.map((row) => {
    const session = row.parents[1] ? sessions.get(row.parents[1]) : undefined;
    return {
      ...row,
      ...(session ? {
        sessionSubject: session.subject,
        sessionParents: session.parents,
        sessionTreeSha: session.treeSha,
        sessionMessage: session.message
      } : {})
    };
  });
}

export async function scanAuthorityBatchCommits(input: {
  readonly rootDir: string;
  readonly headCommit: string;
  readonly exclusiveCommit?: string;
}): Promise<ReadonlyArray<AuthorityBatchCommitMetadata>> {
  const revision = input.exclusiveCommit
    ? `${input.exclusiveCommit}..${input.headCommit}`
    : input.headCommit;
  const batches: AuthorityBatchCommitMetadata[] = [];
  for (const [commitSha, message] of parsePairs(await publicationHistoryGitText(
    input.rootDir,
    "log",
    "--format=%H%x00%B%x00",
    revision
  ))) {
    try {
      const parsed = parseAuthorityBatchCommitMessage(message);
      batches.push({
        commitSha,
        opIds: parsed.integrity.entries.map((entry) => entry.opId)
      });
    } catch {
      // Ordinary commits are not authority batch evidence.
    }
  }
  return batches;
}

async function publicationHistoryGitText(rootDir: string, ...args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

function parsePairs(value: string): ReadonlyArray<readonly [string, string]> {
  const fields = value.split("\0");
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const first = fields[index]!.trim();
    const second = fields[index + 1]!.trim();
    if (first) pairs.push([first, second]);
  }
  return pairs;
}

function parseCommitRows(value: string): ReadonlyArray<readonly [string, string, string, string, string]> {
  const fields = value.split("\0");
  const rows: Array<readonly [string, string, string, string, string]> = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const first = fields[index]!.trim();
    const second = fields[index + 1]!.trim();
    const third = fields[index + 2]!.trim();
    const fourth = fields[index + 3]!.trim();
    const fifth = fields[index + 4]!.trim();
    if (first) rows.push([first, second, third, fourth, fifth]);
  }
  return rows;
}

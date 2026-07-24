import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const subjectBatchSize = 256;

export interface FirstParentPublicationMetadata {
  readonly commitSha: string;
  readonly parents: ReadonlyArray<string>;
  readonly sessionSubject?: string;
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
  const history = parsePairs(await publicationHistoryGitText(
    input.rootDir,
    "log",
    "--first-parent",
    "--format=%H%x00%P%x00",
    revision
  )).map(([commitSha, parents]) => ({
    commitSha,
    parents: parents.split(" ").filter(Boolean)
  }));
  const sessionCommits = [...new Set(history
    .filter((row) => row.parents.length === 2)
    .map((row) => row.parents[1]!))];
  const subjects = new Map<string, string>();
  for (let start = 0; start < sessionCommits.length; start += subjectBatchSize) {
    const batch = sessionCommits.slice(start, start + subjectBatchSize);
    for (const [commitSha, subject] of parsePairs(await publicationHistoryGitText(
      input.rootDir,
      "log",
      "--no-walk=unsorted",
      "--format=%H%x00%s%x00",
      ...batch
    ))) {
      subjects.set(commitSha, subject);
    }
  }
  return history.map((row) => ({
    ...row,
    ...(row.parents[1] ? { sessionSubject: subjects.get(row.parents[1]) ?? "" } : {})
  }));
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

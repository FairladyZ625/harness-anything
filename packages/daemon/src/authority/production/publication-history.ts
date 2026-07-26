import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const subjectBatchSize = 256;

export interface FirstParentPublicationMetadata {
  readonly commitSha: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
  readonly message: string;
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
  const history = parseQuadruples(await publicationHistoryGitText(
    input.rootDir,
    "log",
    "--first-parent",
    "--format=%H%x00%P%x00%s%x00%B%x00",
    revision
  )).map(([commitSha, parents, subject, message]) => ({
    commitSha,
    parents: parents.split(" ").filter(Boolean),
    subject,
    message
  }));
  const sessionCommits = [...new Set(history
    .filter((row) =>
      row.parents.length === 2
      && row.subject.startsWith("materializer: merge session "))
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

function parseQuadruples(value: string): ReadonlyArray<readonly [string, string, string, string]> {
  const fields = value.split("\0");
  const quadruples: Array<readonly [string, string, string, string]> = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const first = fields[index]!.trim();
    const second = fields[index + 1]!.trim();
    const third = fields[index + 2]!.trim();
    const fourth = fields[index + 3]!.trim();
    if (first) quadruples.push([first, second, third, fourth]);
  }
  return quadruples;
}

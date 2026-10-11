import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** One top-level entry of the user root's backups directory. */
export interface BackupRetentionEntry {
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly lastWrittenAt: string;
  readonly ageDays: number;
  readonly expired: boolean;
}

/** Retention rule (one sentence): a backup entry is kept for `keepDays` days from its last
 *  write (directory mtime), after which this listing marks it expired — deletion stays manual. */
export const defaultBackupRetentionDays = 30,
  dayMs = 86_400_000;

export interface BackupRetentionInvocation {
  days: number;
  userRoot: string | undefined;
  json: boolean;
}

export function parseBackupRetentionInvocation(argv: readonly string[]): BackupRetentionInvocation | string {
  const rest = argv.slice(argv.indexOf("retention") + 1),
    invocation: BackupRetentionInvocation = { days: defaultBackupRetentionDays, userRoot: undefined, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--json") invocation.json = true;
    else if (token === "--days") {
      const value = rest[index + 1];
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return "--days requires a positive integer.";
      invocation.days = Number(value);
      index += 1;
    } else if (token === "--user-root") {
      const value = rest[index + 1];
      if (value === undefined || value === "") return "--user-root requires a path.";
      invocation.userRoot = value;
      index += 1;
    } else return `Unsupported argument ${token}.`;
  }
  return invocation;
}

/** Pure listing: every top-level entry under the backup root with its age and expired mark.
 *  A missing root lists empty; reading it never creates it. */
export function listBackupRetention(input: {
  readonly backupRoot: string;
  readonly now: string;
  readonly keepDays: number;
}): readonly BackupRetentionEntry[] {
  const root = path.resolve(input.backupRoot);
  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const nowMs = Date.parse(input.now);
  return names
    .map((name) => {
      const stat = statSync(path.join(root, name), { throwIfNoEntry: false });
      if (!stat) return null;
      const ageDays = (nowMs - stat.mtimeMs) / dayMs;
      return {
        name,
        kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
        lastWrittenAt: new Date(stat.mtimeMs).toISOString(),
        ageDays,
        expired: ageDays > input.keepDays,
      };
    })
    .filter((entry): entry is BackupRetentionEntry => entry !== null)
    .sort((left, right) => right.ageDays - left.ageDays || left.name.localeCompare(right.name));
}

export function renderBackupRetention(
  entries: readonly BackupRetentionEntry[],
  keepDays: number,
  backupRoot: string,
): string {
  if (entries.length === 0) return `No backup entries under ${backupRoot}.`;
  const expired = entries.filter((entry) => entry.expired),
    rows = entries.map(
      (entry) =>
        `${entry.name}\t${entry.kind}\t${entry.lastWrittenAt}\t${entry.ageDays.toFixed(1)}\t${
          entry.expired ? `expired (past ${keepDays}d)` : "retained"
        }`,
    );
  return [
    `Backup entries under ${backupRoot} — kept ${keepDays} days from last write; expired entries are listed only, never deleted:`,
    ...rows,
    `${entries.length} entries, ${expired.length} past the ${keepDays}-day retention window.`,
  ].join("\n");
}

export async function runBackupRetention(invocation: BackupRetentionInvocation): Promise<number> {
  const { daemonUserRoot } = await import("@harness-anything/daemon/internal/client/local-daemon-target"),
    userRoot = path.resolve(invocation.userRoot ?? daemonUserRoot()),
    backupRoot = path.join(userRoot, "backups"),
    entries = listBackupRetention({ backupRoot, now: new Date().toISOString(), keepDays: invocation.days });
  if (invocation.json)
    console.log(
      JSON.stringify({
        schema: "backup-retention/v1",
        ok: true,
        command: "backup-retention",
        backupRoot,
        keepDays: invocation.days,
        entries,
        expiredCount: entries.filter((entry) => entry.expired).length,
      }),
    );
  else console.log(renderBackupRetention(entries, invocation.days, backupRoot));
  return 0;
}

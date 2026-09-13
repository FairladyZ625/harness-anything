import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import { DEFAULT_RESTORE_DRILL_RETENTION, readSettingsFacet } from "../domain/settings.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localLedgerBackupFileSystem as fileSystem } from "../local/local-layout-file-system.ts";
import { decodeLegacyEventBytes, readStoppedLegacyGeneration } from "./legacy-generation-source.ts";
import { localGitText } from "./local-version-control-system.ts";
import { openSqliteEventStore, resolveActiveGeneration, sqliteLedgerPath } from "./sqlite-event-store.ts";

export interface LedgerBackupManifestV1 {
  readonly schema: "ledger-backup/v1";
  readonly tag: string;
  readonly createdAt: string;
  readonly sourceRoot: string;
  readonly accepted: { readonly revision: number; readonly opIds: number };
  readonly sqlite: { readonly present: boolean; readonly integrity: string | null; readonly generation?: number };
  readonly files: readonly LedgerBackupFileV1[];
}

export interface LedgerBackupFileV1 {
  readonly path: string;
  readonly size: number;
  readonly backupSha256: string;
  readonly method: "copy" | "vacuum-into" | "symlink";
}

export function createLedgerBackup(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly backupDir: string;
  readonly now?: Date;
  readonly generation?: 1 | 2;
}): LedgerBackupManifestV1 {
  const backupDir = path.resolve(input.backupDir);
  if (!path.isAbsolute(input.backupDir)) throw new Error("backup directory must be absolute");
  if (fileSystem.exists(backupDir)) throw new Error("backup directory must not already exist");
  const generation = input.generation ?? resolveActiveGeneration({ rootInput: input.rootInput }),
    layout = resolveHarnessLayout(input.rootInput),
    payloadRoot = path.join(backupDir, "payload"),
    sourcePaths = existingBackupSources(layout.rootDir, layout.authoredRoot),
    sqlitePath = sqliteLedgerPath(input.rootInput, generation),
    sqlitePresent = fileSystem.exists(sqlitePath);
  fileSystem.mkdir(payloadRoot, { recursive: true });
  copyWorkingTree(layout.rootDir, layout.authoredRoot, payloadRoot);
  for (const sourcePath of sourcePaths) copySource(layout.rootDir, sourcePath, payloadRoot);
  for (const generation of [1, 2]) {
    const database = sqliteLedgerPath(input.rootInput, generation);
    if (fileSystem.exists(database)) vacuumSqlite(layout.rootDir, database, payloadRoot);
  }
  const sqlite = sqlitePresent ? inspectSqlite(sqlitePath) : null,
    legacy = sqlitePresent ? null : readStoppedLegacyGeneration({ rootInput: input.rootInput }),
    files = inventory(payloadRoot).map((backupFile) => {
      const relative = portable(path.relative(payloadRoot, backupFile)),
        vacuumed = /^\.harness\/store\/generations\/[12]\/ledger\.sqlite$/u.test(relative),
        backup = entryDigest(backupFile);
      return {
        path: relative,
        size: backup.size,
        backupSha256: backup.sha256,
        method: vacuumed ? "vacuum-into" : backup.symlink ? "symlink" : "copy",
      } satisfies LedgerBackupFileV1;
    });
  const manifest: LedgerBackupManifestV1 = {
    schema: "ledger-backup/v1",
    tag: `backup-${(input.now ?? new Date()).toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
    createdAt: (input.now ?? new Date()).toISOString(),
    sourceRoot: layout.rootDir,
    accepted: sqlite
      ? { revision: sqlite.revision, opIds: sqlite.opIds }
      : {
          revision: legacy!.eventEntries.length,
          opIds: new Set(legacy!.eventEntries.map(({ event }) => event.opId)).size,
        },
    sqlite: { present: sqlitePresent, integrity: sqlite?.integrity ?? null, generation },
    files,
  };
  fileSystem.write(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function drillLedgerBackup(input: {
  readonly backupDir: string;
  readonly shadowParent: string;
  readonly destinationRoot?: string;
  readonly retention?: number;
  readonly verifiedManifest?: LedgerBackupManifestV1;
}): {
  readonly shadowRoot: string;
  readonly manifest: LedgerBackupManifestV1;
  readonly removedShadowRoots: readonly string[];
  readonly warnings: readonly string[];
} {
  const backupDir = path.resolve(input.backupDir),
    manifest = input.verifiedManifest ?? readManifest(backupDir),
    payloadRoot = path.join(backupDir, "payload");
  if (!input.verifiedManifest) verifyManifest(payloadRoot, manifest);
  fileSystem.mkdir(input.shadowParent, { recursive: true });
  if (input.destinationRoot && fileSystem.exists(input.destinationRoot))
    throw new Error("restore destination already exists");
  const shadowRoot =
    input.destinationRoot ??
    fileSystem.makeTemporaryDirectory(path.join(path.resolve(input.shadowParent), "restore-drill-"));
  fileSystem.copy(payloadRoot, shadowRoot, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  verifyManifest(shadowRoot, manifest);
  for (const database of manifest.files.filter(({ method }) => method === "vacuum-into"))
    inspectSqlite(path.join(shadowRoot, database.path));
  const removedShadowRoots: string[] = [],
    warnings: string[] = [],
    retention = input.retention ?? DEFAULT_RESTORE_DRILL_RETENTION,
    candidates = fileSystem
      .readDirectory(path.resolve(input.shadowParent))
      .filter((name) => name.startsWith("restore-drill-"))
      .map((name) => path.join(path.resolve(input.shadowParent), name))
      .filter((candidate) => fileSystem.lstat(candidate).isDirectory())
      .sort((left, right) => fileSystem.stat(left).mtimeMs - fileSystem.stat(right).mtimeMs);
  for (const candidate of candidates.slice(0, Math.max(0, candidates.length - retention))) {
    try {
      fileSystem.remove(candidate);
      removedShadowRoots.push(candidate);
    } catch (error) {
      consumeKnownError(error);
      warnings.push(`could not remove ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { shadowRoot, manifest, removedShadowRoots, warnings };
}

/** The drill runs offline, so the retention setting is read from the authored harness.yaml facet. */
export function restoreDrillRetentionFor(rootInput: HarnessLayoutInput): number {
  const settingsPath = path.join(resolveHarnessLayout(rootInput).authoredRoot, "harness.yaml");
  if (!fileSystem.exists(settingsPath)) return DEFAULT_RESTORE_DRILL_RETENTION;
  return readSettingsFacet(fileSystem.read(settingsPath, "utf8")).restoreDrillRetention;
}

export function readOfflineLedgerEvents(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly generation?: 1 | 2;
  readonly sinceRevision?: number;
  readonly sinceTime?: string;
  readonly grep?: string;
}): readonly unknown[] {
  const generation = input.generation ?? resolveActiveGeneration({ rootInput: input.rootInput }),
    databasePath = sqliteLedgerPath(input.rootInput, generation),
    events = fileSystem.exists(databasePath)
      ? readSqliteEvents(databasePath)
      : readStoppedLegacyGeneration({ rootInput: input.rootInput }).eventEntries.map(({ bytes }) =>
          parseCanonicalEvent(bytes),
        );
  const sinceMs = input.sinceTime === undefined ? null : Date.parse(input.sinceTime);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) throw new Error("--since time must be an ISO timestamp");
  return events.filter((value) => {
    const event = value as { readonly workspaceRevision: number; readonly occurredAt?: string };
    return (
      (input.sinceRevision === undefined || event.workspaceRevision > input.sinceRevision) &&
      (sinceMs === null || Date.parse(event.occurredAt ?? "") >= sinceMs) &&
      (input.grep === undefined || JSON.stringify(value).includes(input.grep))
    );
  });
}

function existingBackupSources(rootDir: string, authoredRoot: string): readonly string[] {
  const candidates = [
    fileSystem.exists(path.join(authoredRoot, ".git")) ? path.join(authoredRoot, ".git") : path.join(rootDir, ".git"),
    path.join(rootDir, ".harness", "wal"),
    path.join(rootDir, ".harness", "store", "imports"),
  ];
  for (const generation of [1, 2]) {
    const generationRoot = path.join(rootDir, ".harness", "store", "generations", String(generation));
    if (fileSystem.exists(generationRoot))
      for (const name of fileSystem.readDirectory(generationRoot))
        if (name !== "ledger.sqlite" && name !== "ledger.sqlite-wal" && name !== "ledger.sqlite-shm")
          candidates.push(path.join(generationRoot, name));
  }
  const draftsRoot = path.join(rootDir, ".harness", "operations", "conversion-drafts");
  if (fileSystem.exists(draftsRoot)) {
    candidates.push(draftsRoot);
    for (const parent of fileSystem.readDirectory(draftsRoot)) {
      const manifest = JSON.parse(fileSystem.read(path.join(draftsRoot, parent, "manifest.json"), "utf8")) as {
        drafts: readonly { preservedPath: string | null }[];
      };
      for (const draft of manifest.drafts)
        if (draft.preservedPath !== null) candidates.push(path.join(authoredRoot, draft.preservedPath));
    }
  }
  return candidates.filter((candidate) => fileSystem.exists(candidate));
}

function workingTreeSources(authoredRoot: string): readonly string[] {
  const entries = localGitText(authoredRoot, "ls-files", "--stage", "-z").split("\0").filter(Boolean);
  const tracked = entries.flatMap((entry) => {
    const tab = entry.indexOf("\t"),
      [mode] = entry.slice(0, tab).split(" ");
    if (tab < 0 || mode === "160000") return [];
    return [path.join(authoredRoot, entry.slice(tab + 1))];
  });
  const untracked = localGitText(authoredRoot, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .map((entry) => path.join(authoredRoot, entry));
  return [...new Set([...tracked, ...untracked])];
}

function copyWorkingTree(rootDir: string, authoredRoot: string, payloadRoot: string): void {
  const included = new Set([authoredRoot]);
  for (const source of workingTreeSources(authoredRoot)) {
    for (let candidate = source; !included.has(candidate); candidate = path.dirname(candidate)) included.add(candidate);
  }
  fileSystem.copy(authoredRoot, path.join(payloadRoot, path.relative(rootDir, authoredRoot)), {
    recursive: true,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: (candidate) =>
      candidate === authoredRoot || (included.has(candidate) && !vanishedAfterEnumeration(candidate)),
  });
}

function copySource(rootDir: string, sourcePath: string, payloadRoot: string): void {
  const relative = path.relative(rootDir, sourcePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("backup source escaped repository root");
  fileSystem.copy(sourcePath, path.join(payloadRoot, relative), {
    recursive: true,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: (candidate) => candidate === sourcePath || !skippedFromSource(candidate),
  });
}

// An entry that vanishes between its enumeration and this stat — Git's transient
// gc/maintenance locks under .git/, a write path replacing a temp file — no longer needs
// backing up. Tolerating only the missing-entry case is not a retry: every other stat
// error still fails the backup.
function vanishedAfterEnumeration(candidate: string): boolean {
  return fileSystem.lstat(candidate, { throwIfNoEntry: false }) === undefined;
}

// A repository nested inside a source (a tool worktree under .claude/, a checkout someone
// left in the tree) is tool state, not ledger content, and is skipped like a vanished entry.
function skippedFromSource(candidate: string): boolean {
  const stat = fileSystem.lstat(candidate, { throwIfNoEntry: false });
  return stat === undefined || (stat.isDirectory() && fileSystem.exists(path.join(candidate, ".git")));
}

function vacuumSqlite(rootDir: string, databasePath: string, payloadRoot: string): void {
  const target = path.join(payloadRoot, path.relative(rootDir, databasePath));
  fileSystem.mkdir(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(target)}`);
  } finally {
    db.close();
  }
}

function inspectSqlite(databasePath: string): {
  readonly revision: number;
  readonly opIds: number;
  readonly integrity: string;
} {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(db.prepare("PRAGMA integrity_check").get()!.integrity_check);
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
    const counts = db
        .prepare(
          "SELECT COUNT(*) AS events, COUNT(DISTINCT op_id) AS op_ids, " +
            "COALESCE(MAX(revision), 0) AS revision FROM event",
        )
        .get()!,
      metadata = db.prepare("SELECT generation, revision FROM ledger_meta WHERE singleton=1").get();
    if (
      !metadata ||
      Number(metadata.generation) !== Number(path.basename(path.dirname(databasePath))) ||
      Number(metadata.revision) !== Number(counts.revision)
    )
      throw new Error("SQLite generation metadata differs from accepted events");
    if (Number(counts.events) !== Number(counts.revision) || Number(counts.events) !== Number(counts.op_ids))
      throw new Error("SQLite accepted revision/opId counts differ");
    for (const row of db.prepare("SELECT event_json FROM event ORDER BY revision").all()) {
      if (Number(metadata.generation) === 1) decodeLegacyEventBytes(String(row.event_json), "generation 1 backup");
      else parseCanonicalEvent(String(row.event_json));
    }
    return { revision: Number(counts.revision), opIds: Number(counts.op_ids), integrity };
  } finally {
    db.close();
  }
}

function readSqliteEvents(databasePath: string): readonly unknown[] {
  const store = openSqliteEventStore({
    databasePath,
    generation: Number(path.basename(path.dirname(databasePath))),
    readOnly: true,
  });
  try {
    return store.metadata().generation === 1
      ? store.eventRows().map((row) => decodeLegacyEventBytes(row.eventJson, "read-only generation 1").event)
      : store.events();
  } finally {
    store.close();
  }
}

function readManifest(backupDir: string): LedgerBackupManifestV1 {
  const value = JSON.parse(fileSystem.read(path.join(backupDir, "manifest.json"), "utf8")) as LedgerBackupManifestV1;
  if (value.schema !== "ledger-backup/v1" || !Array.isArray(value.files)) throw new Error("backup manifest is invalid");
  return value;
}

function verifyManifest(root: string, manifest: LedgerBackupManifestV1): void {
  const actual = inventory(root).map((file) => portable(path.relative(root, file)));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files.map(({ path: file }) => file)))
    throw new Error("backup file inventory differs from manifest");
  for (const entry of manifest.files) {
    const actual = entryDigest(path.join(root, entry.path));
    if (actual.size !== entry.size || actual.sha256 !== entry.backupSha256)
      throw new Error(`backup file digest differs: ${entry.path}`);
  }
}

// Symbolic links are backed up as links: the manifest records the link target, never the
// bytes behind it. The authored root links out to external repositories (source packs),
// and following those would pull foreign trees into the ledger backup or fail on links that
// only resolve from the source location.
function entryDigest(file: string): { readonly size: number; readonly sha256: string; readonly symlink: boolean } {
  const stat = fileSystem.lstat(file);
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(fileSystem.readLink(file));
    return { size: target.byteLength, sha256: `sha256:${sha256Bytes(target)}`, symlink: true };
  }
  return { size: stat.size, sha256: sha256File(file), symlink: false };
}

function inventory(root: string): readonly string[] {
  const entries: { readonly file: string; readonly key: string }[] = [],
    walk = (directory: string) => {
      for (const name of fileSystem.readDirectory(directory)) {
        const candidate = path.join(directory, name),
          stat = fileSystem.lstat(candidate);
        if (stat.isSymbolicLink() || stat.isFile())
          entries.push({ file: candidate, key: portable(path.relative(root, candidate)) });
        else if (stat.isDirectory()) walk(candidate);
      }
    };
  walk(root);
  return entries.sort((left, right) => left.key.localeCompare(right.key)).map(({ file }) => file);
}

function sha256File(file: string): string {
  return `sha256:${sha256Bytes(fileSystem.read(file))}`;
}
function portable(value: string): string {
  return value.split(path.sep).join("/");
}
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Verify every retained source byte before an offline converter opens the copied database. */
export function readVerifiedLedgerBackup(backupDir: string): LedgerBackupManifestV1 {
  const manifest = readManifest(backupDir);
  verifyManifest(path.join(backupDir, "payload"), manifest);
  return manifest;
}

export { runGenerationTwoConversion } from "./generation-two-conversion.ts";
export { resolveActiveGeneration } from "./sqlite-event-store.ts";

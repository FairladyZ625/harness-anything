# Back up and restore a ledger

Run backups from the registered repository root. A backup is a directory containing an
integrity-checked manifest and a consistent SQLite snapshot; choose a new absolute destination.

```sh
ha backup /Volumes/offsite/harness-backup-2026-09-15
```

The manifest records the repository ID, mode, connection, display name, and authored branch
alongside the digest and size of every retained file. Keep the whole backup directory.

Exercise the backup without changing the live repository:

```sh
ha restore --drill /Volumes/offsite/harness-backup-2026-09-15
```

The drill verifies the file inventory and digests, opens each SQLite snapshot read-only, checks its
integrity and event chain, and restores only below the repository's `.harness/restore-drills`
directory.

For a real restore, choose an absolute destination that does not exist:

```sh
ha restore /Volumes/offsite/harness-backup-2026-09-15 --to /srv/restored-project
```

The restore verifies before and after copying. It never overwrites an existing destination. If an old
registration for the same repository ID remains, unregister that unavailable root first. Then use
the `repoId` printed in the restore receipt to bind and verify the restored repository:

```sh
cd /srv/restored-project
ha init --repo-id <repoId> --person-id <owner-person-id> --display-name <owner-display-name>
ha task show <known-task-id>
ha fact search <known-query>
```

Use the registry metadata printed in the receipt when the original repository used a non-local
mode or named connection. Do not copy a live `ledger.sqlite` file manually: `ha backup` uses
SQLite's snapshot operation while the daemon may still be accepting writes.
